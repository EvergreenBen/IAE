// One crew job: a full Claude Code session (builder or scout). Its message
// stream becomes what the map shows: steps, file touches, a live activity
// line in plain words (plain.ts), and the node it's standing on, read as the
// stream arrives (whereabouts.ts).

import type { CanUseTool, PermissionResult, PermissionUpdate, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { query, resumable, type Query } from './agent';
import type { EngineEvent } from '../../shared/events';
import { describeMap } from '../../shared/map';
import type { AgendaItem, AgentInfo, AgentStep, Autonomy, Settings } from '../../shared/model';
import { describeToolUse, stepText } from './activity';
import { ChangeTracker } from './changes';
import { RESTARTED } from './crew-persist';
import { createCrewTools, crewToolNames } from './crew-tools';
import { gateHooks } from './gate';
import { plainActivity } from './plain';
import { nextProgress, todoReport, type ProgressReport } from './progress';
import { builderAppend } from './prompts';
import { baseOptions, errorText, InputQueue, log } from './sdk';
import type { Workspace } from './workspace';
import { Whereabouts, type StreamEvent } from './whereabouts';

export type JobKind = 'build' | 'investigate' | 'command';

export interface JobSpec {
  kind: JobKind;
  title: string;
  /** The brief, or the command text for `command` jobs. */
  brief: string;
  nodeId: string | null;
}

export interface PermissionAsk {
  toolName: string;
  input: Record<string, unknown>;
  title?: string;
  suggestions?: PermissionUpdate[];
  signal: AbortSignal;
}

export type Outcome = { status: 'done' | 'failed' | 'stopped'; result: string };

export interface RunDeps {
  ws: Workspace;
  emit: (e: EngineEvent) => void;
  settings: Settings;
  onUpdate(agent: AgentInfo): void;
  askPermission(run: BuilderRun, ask: PermissionAsk): Promise<PermissionResult>;
  onAsked(run: BuilderRun, item: AgendaItem, blocking: boolean): void;
  onFinished(run: BuilderRun, outcome: Outcome): void;
  /** Claude Code reported the session id (saved so the job can resume after a restart). */
  onSession?(run: BuilderRun): void;
}

const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'NotebookRead', 'BashOutput', 'ToolSearch']);
const SCOUT_TOOLS = ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'];
/** Steps kept per run, for a window that reloads mid-job. */
const KEEP_STEPS = 30;
/** The plan it shows: its own plain-words plan (progress tool) wins over Claude Code's todo list. */
type PlanSource = 'progress' | 'todo';

export class BuilderRun {
  agent: AgentInfo;
  input = new InputQueue();
  /** Claude Code's session id once known. Set before start() to resume that session. */
  sessionId?: string;
  /** The first message of a resumed session, in place of the brief. */
  resumeNote?: string;
  /** Resuming a saved session that hasn't started yet (if it can't, the job starts over). */
  private resuming = false;
  private q: Query | null = null;
  private readonly abort = new AbortController();
  private stopped = false;
  private finished = false;
  private lastText = '';
  /** The node this run marked as building (released when it ends). */
  private buildingNode: string | null = null;
  /** Files this run created (they get one-line notes when it ends). */
  readonly created = new Set<string>();
  /** The latest steps, newest last. */
  readonly steps: AgentStep[] = [];
  /** When this session began (a resumed job's first start was before the restart). */
  private workStartedAt = Date.now();
  /** What it changed, file by file (AgentInfo.changes). */
  private readonly changes: ChangeTracker;
  private planFrom: PlanSource | null = null;
  /** Where it stands and whether it's thinking (whereabouts.ts). */
  private readonly where: Whereabouts;

  constructor(
    readonly job: JobSpec,
    agent: AgentInfo,
    private readonly d: RunDeps,
  ) {
    this.agent = agent;
    this.changes = new ChangeTracker(d.ws.root);
    this.where = new Whereabouts({
      root: d.ws.root,
      map: () => d.ws.map,
      agent: () => this.agent,
      jobNode: job.nodeId,
      update: (patch) => this.update(patch),
      finished: () => this.finished,
    });
    // A job resumed after a restart carries on counting from what it had changed.
    if (agent.changes?.length) this.changes.changes = [...agent.changes];
  }

  get isScout(): boolean {
    return this.job.kind === 'investigate';
  }

  get isRunning(): boolean {
    return !!this.q && !this.finished;
  }

  update(patch: Partial<AgentInfo>): void {
    this.where.noting(patch);
    this.agent = { ...this.agent, ...patch };
    this.d.onUpdate(this.agent);
  }

  start(): void {
    const { ws, settings } = this.d;
    const node = this.job.nodeId ? ws.map.nodes[this.job.nodeId] : undefined;
    // Builds mark their node; scouts and slash commands (which run wherever the
    // person happened to be looking) don't.
    if (node && this.job.kind === 'build' && !this.buildingNode) {
      this.buildingNode = node.id;
      ws.beginBuild(node.id);
    }
    const decisions = ws.agenda.allDecisions().slice(-20).map((d) => (d.rationale ? `${d.title} (${d.rationale})` : d.title));
    const append = builderAppend({
      name: this.agent.name,
      role: this.isScout ? 'scout' : 'builder',
      task: this.job.title,
      brief: this.job.kind === 'command' ? `Run ${this.job.brief} for the human.` : this.job.brief,
      nodeLabel: node?.label,
      nodeId: node?.id ?? null,
      mapText: describeMap(ws.map, ws.files),
      decisions,
    });
    const tools = createCrewTools({
      ws,
      agentId: this.agent.id,
      source: 'builder',
      allowedOps: ['upsertNode', 'upsertEdge'],
      signal: this.abort.signal,
      canAsk: true,
      canNote: !this.isScout,
      canProgress: !this.isScout,
      onAsked: (item, blocking) => this.d.onAsked(this, item, blocking),
      onWaiting: (waiting) => this.update(waiting ? { status: 'waiting', activity: 'Waiting for your answer' } : { status: 'working', activity: 'Back at work' }),
      onProgress: (report) => this.report(report),
    });
    const ownTools = crewToolNames({ canAsk: true, canNote: !this.isScout, canProgress: !this.isScout });
    // Saved by the other agent (Settings changed since): start over from the brief.
    if (this.sessionId && !resumable(this.sessionId)) {
      this.sessionId = undefined;
      this.resumeNote = undefined;
    }
    this.resuming = !!this.sessionId;
    this.workStartedAt = Date.now();
    this.where.reset();

    this.q = query({
      prompt: this.input,
      options: {
        ...baseOptions(ws.root),
        model: settings.builderModel,
        systemPrompt: { type: 'preset', preset: 'claude_code', append },
        settingSources: ['user', 'project', 'local'],
        mcpServers: { iae: tools },
        abortController: this.abort,
        includePartialMessages: true,
        ...(this.sessionId ? { resume: this.sessionId } : {}),
        ...(this.isScout
          ? { tools: SCOUT_TOOLS, allowedTools: [...SCOUT_TOOLS, ...ownTools], permissionMode: 'dontAsk' as const, strictMcpConfig: true }
          : {
              ...permissionOptions(settings.autonomy, this.canUseTool, ownTools),
              hooks: { PreToolUse: gateHooks(settings.autonomy, (toolName, input, signal) => this.d.askPermission(this, { toolName, input, signal })) },
            }),
      },
    });
    this.input.push(this.firstMessage());
    const activity = this.resuming ? 'Picking up where it left off' : this.isScout ? 'Looking around' : 'Getting oriented';
    // A resumed job keeps its first start (the panel shows how long it has been at it).
    this.update({ status: 'thinking', activity, ...(this.resuming ? {} : { startedAt: Date.now() }) });
    void this.consume(this.q);
  }

  private firstMessage(): string {
    if (this.resuming) return this.resumeNote ?? RESTARTED;
    if (this.job.kind === 'command') return this.job.brief;
    if (this.isScout) return `${this.job.title}\n\n${this.job.brief}\n\nDon't modify anything. Report what you found in 2–5 plain sentences.`;
    return `${this.job.title}\n\n${this.job.brief}`;
  }

  private canUseTool: CanUseTool = async (toolName, input, opts) => {
    if (toolName.startsWith('mcp__iae__')) return { behavior: 'allow', updatedInput: input };
    if (this.d.settings.autonomy === 'ask' && READ_ONLY_TOOLS.has(toolName)) return { behavior: 'allow', updatedInput: input };
    return this.d.askPermission(this, { toolName, input, title: opts.title, suggestions: opts.suggestions, signal: opts.signal });
  };

  /** The map changed under it (the cartographer regrouped things): if its node is gone, it stands somewhere real. */
  rehome(): void {
    this.where.rehome();
  }

  /** The builder said where it is in its plan. Its own plain plan, once sent, isn't replaced by its todo list. */
  private report(r: ProgressReport, from: PlanSource = 'progress'): void {
    if (from === 'todo' && this.planFrom === 'progress') return;
    if (r.steps?.length) this.planFrom = from;
    const progress = nextProgress(this.agent.progress, r, Date.now(), this.workStartedAt);
    if (progress && progress !== this.agent.progress) this.update({ progress });
  }

  private step(step: AgentStep): void {
    this.steps.push(step);
    if (this.steps.length > KEEP_STEPS) this.steps.splice(0, this.steps.length - KEEP_STEPS);
    this.d.emit({ type: 'agent/step', agentId: this.agent.id, step });
  }

  message(text: string): boolean {
    if (this.finished || this.input.isClosed) return false;
    this.input.push(`Message from the architect: ${text}`);
    return true;
  }

  /** Ends the session now: releases blocking waits, kills the process. */
  async stop(): Promise<void> {
    if (this.finished) return;
    this.stopped = true;
    this.input.close();
    this.abort.abort();
    try {
      this.q?.close();
    } catch {
      // already gone
    }
    this.finish({ status: 'stopped', result: 'Stopped.' });
  }

  private async consume(q: Query): Promise<void> {
    let error: string | null = null;
    try {
      for await (const m of q) {
        if (this.finished || q !== this.q) break;
        this.onMessage(m);
      }
    } catch (e) {
      error = errorText(e);
    }
    // Started over (the saved session couldn't resume): the new session carries on.
    if (this.finished || q !== this.q) return;
    if (this.resuming && !this.stopped) return this.startOver(error);
    if (this.stopped) this.finish({ status: 'stopped', result: 'Stopped.' });
    else this.finish({ status: 'failed', result: error ?? (this.lastText || 'The session ended unexpectedly.') });
  }

  private onMessage(m: SDKMessage): void {
    const { ws, emit } = this.d;
    if (m.type === 'system' && m.subtype === 'init') {
      log('crew', `${this.agent.name} session ${m.session_id} (${m.model}, ${m.permissionMode}${this.resuming ? ', resumed' : ''})`);
      this.resuming = false;
      if (m.session_id && m.session_id !== this.sessionId) {
        this.sessionId = m.session_id;
        this.d.onSession?.(this);
      }
      return;
    }
    if (m.type === 'stream_event') {
      if (!m.parent_tool_use_id) this.where.stream(m.event as StreamEvent);
      return;
    }
    if (m.type === 'assistant') {
      if (m.error) log('crew', `${this.agent.name} assistant error`, m.error);
      for (const block of m.message.content as { type: string; id?: string; text?: string; name?: string; input?: unknown }[]) {
        if (block.type === 'text' && block.text?.trim() && !m.parent_tool_use_id) {
          this.lastText = block.text.trim();
          this.step({ at: Date.now(), kind: 'text', text: stepText(block.text) });
        } else if (block.type === 'tool_use' && block.name) {
          if (!m.parent_tool_use_id) this.where.called(block.id);
          const input = (block.input && typeof block.input === 'object' ? block.input : {}) as Record<string, unknown>;
          // Bookkeeping, not work: it moves the bar, not the activity line.
          if (block.name === 'mcp__iae__progress') continue;
          if (block.name === 'TodoWrite' && !m.parent_tool_use_id) {
            const todos = todoReport(input);
            if (todos) this.report(todos, 'todo');
          }
          const act = describeToolUse(ws.root, block.name, input);
          this.step({ at: Date.now(), kind: act.kind, text: act.activity, ...(act.path ? { path: act.path } : {}) });
          if (act.path && act.touch) emit({ type: 'files/touched', path: act.path, agentId: this.agent.id, action: act.touch });
          if (act.path && act.touch === 'create') this.created.add(act.path);
          if (act.path && block.id) this.changes.begin(block.id, block.name, act.path, input, act.touch === 'create');
          if (this.agent.status !== 'waiting') this.update({ status: 'working', activity: plainActivity(block.name, act), file: act.path, nodeId: this.where.home(act.path) });
        }
      }
      return;
    }
    if (m.type === 'user') {
      this.onToolResults(m.message.content, m.tool_use_result);
      if (!m.parent_tool_use_id) this.where.answered(m.message.content);
      return;
    }
    if (m.type === 'result') {
      if (m.subtype !== 'success' && this.resuming) return this.startOver(m.errors?.join('; ') || m.subtype);
      if (m.subtype === 'success') {
        // More messages queued for this session (message_agent): keep going.
        if ((m.queued_turn_count ?? 0) > 0) return;
        this.input.close();
        this.finish({ status: m.is_error ? 'failed' : 'done', result: (m.result || this.lastText || 'Done.').trim() });
      } else {
        this.input.close();
        this.finish({ status: 'failed', result: m.errors?.join('; ') || `Stopped: ${m.subtype.replace(/_/g, ' ')}.` });
      }
    }
  }

  /** Tool results came back: edits that worked count towards what it changed. */
  private onToolResults(content: unknown, structured: unknown): void {
    if (!Array.isArray(content)) return;
    const results = (content as { type?: string; tool_use_id?: string; is_error?: boolean }[]).filter((b) => b?.type === 'tool_result' && typeof b.tool_use_id === 'string');
    for (const r of results) {
      // The structured result belongs to the message's one tool result; with several, each counts from its call.
      const result = results.length === 1 ? structured : undefined;
      void this.changes.finish(r.tool_use_id!, r.is_error === true, result, Date.now()).then((changes) => changes && this.update({ changes }));
    }
  }

  /** The saved session couldn't be resumed (gone, or never written): start over from the brief. */
  private startOver(why: string | null): void {
    log('crew', `${this.agent.name} couldn't resume its session (${why || 'no reason given'}); starting over from the brief`);
    const old = this.q;
    this.sessionId = undefined;
    this.resumeNote = undefined;
    this.input.close();
    this.input = new InputQueue();
    try {
      old?.close();
    } catch {
      // already gone
    }
    try {
      this.start();
    } catch (e) {
      this.finish({ status: 'failed', result: errorText(e) });
    }
  }

  private finish(outcome: Outcome): void {
    if (this.finished) return;
    // A finished session exits on its own once its input closes (so the person's hooks still run).
    this.finished = true;
    this.where.stop();
    this.input.close();
    if (this.buildingNode) this.d.ws.endBuild(this.buildingNode, outcome.status);
    this.buildingNode = null;
    this.d.onFinished(this, outcome);
  }
}

/** Arxitect's own tools are approved in canUseTool (listing them in allowedTools would shadow it). */
function permissionOptions(autonomy: Autonomy, canUseTool: CanUseTool, ownTools: string[]) {
  if (autonomy === 'full') return { permissionMode: 'bypassPermissions' as const, allowDangerouslySkipPermissions: true, allowedTools: ownTools };
  if (autonomy === 'ask') return { permissionMode: 'default' as const, canUseTool };
  return { permissionMode: 'acceptEdits' as const, canUseTool };
}
