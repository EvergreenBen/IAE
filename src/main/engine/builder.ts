// One crew job: a full Claude Code session (builder or scout). Its message
// stream becomes what the map shows: steps, file touches, a live activity
// line, and the node it's standing on.

import { query, type CanUseTool, type PermissionResult, type PermissionUpdate, type Query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { EngineEvent } from '../../shared/events';
import { describeMap, ownerOf } from '../../shared/map';
import type { AgendaItem, AgentInfo, Autonomy, NodeStatus, Settings } from '../../shared/model';
import { describeToolUse, stepText } from './activity';
import { createCrewTools, crewToolNames } from './crew-tools';
import { builderAppend } from './prompts';
import { baseOptions, errorText, InputQueue, log } from './sdk';
import type { Workspace } from './workspace';

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
}

const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'NotebookRead', 'BashOutput', 'ToolSearch']);
const SCOUT_TOOLS = ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'];

export class BuilderRun {
  agent: AgentInfo;
  readonly input = new InputQueue();
  private q: Query | null = null;
  private readonly abort = new AbortController();
  private stopped = false;
  private finished = false;
  private lastText = '';
  private prevNodeStatus: NodeStatus | null = null;

  constructor(
    readonly job: JobSpec,
    agent: AgentInfo,
    private readonly d: RunDeps,
  ) {
    this.agent = agent;
  }

  get isScout(): boolean {
    return this.job.kind === 'investigate';
  }

  get isRunning(): boolean {
    return !!this.q && !this.finished;
  }

  update(patch: Partial<AgentInfo>): void {
    this.agent = { ...this.agent, ...patch };
    this.d.onUpdate(this.agent);
  }

  start(): void {
    const { ws, settings } = this.d;
    const node = this.job.nodeId ? ws.map.nodes[this.job.nodeId] : undefined;
    if (node && this.job.kind !== 'investigate') {
      this.prevNodeStatus = node.status;
      ws.setNodeStatus(node.id, 'building');
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
      canNote: false,
      onAsked: (item, blocking) => this.d.onAsked(this, item, blocking),
      onWaiting: (waiting) => this.update(waiting ? { status: 'waiting', activity: 'Waiting for your answer' } : { status: 'working', activity: 'Back at work' }),
    });
    const ownTools = crewToolNames({ canAsk: true, canNote: false });

    this.q = query({
      prompt: this.input,
      options: {
        ...baseOptions(ws.root),
        model: settings.builderModel,
        systemPrompt: { type: 'preset', preset: 'claude_code', append },
        settingSources: ['user', 'project', 'local'],
        mcpServers: { iae: tools },
        abortController: this.abort,
        includePartialMessages: false,
        ...(this.isScout
          ? { tools: SCOUT_TOOLS, allowedTools: [...SCOUT_TOOLS, ...ownTools], permissionMode: 'dontAsk' as const, strictMcpConfig: true }
          : permissionOptions(settings.autonomy, this.canUseTool, ownTools)),
      },
    });
    this.input.push(this.firstMessage());
    this.update({ status: 'thinking', activity: this.isScout ? 'Looking around' : 'Getting oriented', startedAt: Date.now() });
    void this.consume();
  }

  private firstMessage(): string {
    if (this.job.kind === 'command') return this.job.brief;
    if (this.isScout) return `${this.job.title}\n\n${this.job.brief}\n\nDon't modify anything. Report what you found in 2–5 plain sentences.`;
    return `${this.job.title}\n\n${this.job.brief}`;
  }

  private canUseTool: CanUseTool = async (toolName, input, opts) => {
    if (toolName.startsWith('mcp__iae__')) return { behavior: 'allow', updatedInput: input };
    if (this.d.settings.autonomy === 'ask' && READ_ONLY_TOOLS.has(toolName)) return { behavior: 'allow', updatedInput: input };
    return this.d.askPermission(this, { toolName, input, title: opts.title, suggestions: opts.suggestions, signal: opts.signal });
  };

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

  private async consume(): Promise<void> {
    let error: string | null = null;
    try {
      for await (const m of this.q!) {
        if (this.finished) break;
        this.onMessage(m);
      }
    } catch (e) {
      error = errorText(e);
    }
    if (this.finished) return;
    if (this.stopped) this.finish({ status: 'stopped', result: 'Stopped.' });
    else this.finish({ status: 'failed', result: error ?? (this.lastText || 'The session ended unexpectedly.') });
  }

  private onMessage(m: SDKMessage): void {
    const { ws, emit } = this.d;
    if (m.type === 'system' && m.subtype === 'init') {
      log('crew', `${this.agent.name} session ${m.session_id} (${m.model}, ${m.permissionMode})`);
      return;
    }
    if (m.type === 'assistant') {
      if (m.error) log('crew', `${this.agent.name} assistant error`, m.error);
      for (const block of m.message.content as { type: string; text?: string; name?: string; input?: unknown }[]) {
        if (block.type === 'text' && block.text?.trim() && !m.parent_tool_use_id) {
          this.lastText = block.text.trim();
          emit({ type: 'agent/step', agentId: this.agent.id, step: { at: Date.now(), kind: 'text', text: stepText(block.text) } });
        } else if (block.type === 'tool_use' && block.name) {
          const input = (block.input && typeof block.input === 'object' ? block.input : {}) as Record<string, unknown>;
          const act = describeToolUse(ws.root, block.name, input);
          emit({ type: 'agent/step', agentId: this.agent.id, step: { at: Date.now(), kind: act.kind, text: act.activity, ...(act.path ? { path: act.path } : {}) } });
          if (act.path && act.touch) emit({ type: 'files/touched', path: act.path, agentId: this.agent.id, action: act.touch });
          const nodeId = (act.path ? ownerOf(ws.map, act.path) : null) ?? this.agent.nodeId;
          if (this.agent.status !== 'waiting') this.update({ status: 'working', activity: act.activity, file: act.path, nodeId });
        }
      }
      return;
    }
    if (m.type === 'result') {
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

  private finish(outcome: Outcome): void {
    if (this.finished) return;
    // A finished session exits on its own once its input closes (so the person's hooks still run).
    this.finished = true;
    this.input.close();
    const { ws } = this.d;
    const nodeId = this.job.nodeId;
    if (nodeId && this.prevNodeStatus) {
      if (outcome.status === 'done') ws.setNodeStatus(nodeId, 'built');
      else if (outcome.status === 'failed') ws.setNodeStatus(nodeId, 'broken');
      else ws.setNodeStatus(nodeId, this.prevNodeStatus);
    }
    this.d.onFinished(this, outcome);
  }
}

/** IAE's own tools are approved in canUseTool (listing them in allowedTools would shadow it). */
function permissionOptions(autonomy: Autonomy, canUseTool: CanUseTool, ownTools: string[]) {
  if (autonomy === 'full') return { permissionMode: 'bypassPermissions' as const, allowDangerouslySkipPermissions: true, allowedTools: ownTools };
  if (autonomy === 'ask') return { permissionMode: 'default' as const, canUseTool };
  return { permissionMode: 'acceptEdits' as const, canUseTool };
}
