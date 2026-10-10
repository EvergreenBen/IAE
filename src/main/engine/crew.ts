// The crew: builders and scouts. Names, concurrency, permission prompts, and
// what happens when a job finishes (node status, rescan, a digest for the lead).

import type { PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import { nanoid } from 'nanoid';
import { homedir } from 'node:os';
import { basename } from 'node:path';
import type { EngineEvent } from '../../shared/events';
import type { AgendaItem, AgentInfo, AgentStep, PermissionRequest, Settings } from '../../shared/model';
import type { SavedJob } from '../project/store';
import { commandSummary } from './activity';
import { BuilderRun, type JobSpec, type Outcome, type PermissionAsk } from './builder';
import { jobSpec, resumableJobs, resumeNote, savedJob } from './crew-persist';
import { noteNewFiles } from './notes';
import { resumedProgress } from './progress';
import { log } from './sdk';
import type { Workspace } from './workspace';

export const NAME_POOL = ['Ada', 'Kit', 'Rho', 'Juno', 'Max', 'Bea', 'Lev', 'Ivy'];
const REMOVE_AFTER_MS = 6_000;
const REMEMBER_MS = 10 * 60_000;
/** Finished jobs that changed files stay on the crew list for review; at most this many (oldest go first). */
const MAX_KEPT = 4;

interface PendingPermission {
  agentId: string;
  toolName: string;
  input: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
  /** The card as the window shows it (its summary is also saved, so a resumed job knows what it was waiting for). */
  request: PermissionRequest;
  resolve: (r: PermissionResult) => void;
}

export interface CrewDeps {
  ws: Workspace;
  emit: (e: EngineEvent) => void;
  settings: () => Settings;
  /** A build finished, failed or needs an answer: the pulse should consider speaking. */
  onLeadEvent: () => void;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export class Crew {
  private runs = new Map<string, BuilderRun>();
  private queue: BuilderRun[] = [];
  private finishedAt = new Map<string, number>();
  private permissions = new Map<string, PendingPermission>();
  /** Non-blocking questions a builder asked: item id → agent id (answers get forwarded). */
  private askedBy = new Map<string, string>();
  /** Who stopped a job, so the lead's digest says so (and doesn't guess why). */
  private stoppedBy = new Map<string, 'person' | 'lead'>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private closed = false;
  /** What `.iae/crew.json` was last asked to hold. */
  private savedText = '';
  /** Finished jobs kept on the crew list because they changed files, oldest first. */
  private kept: string[] = [];

  constructor(private readonly d: CrewDeps) {}

  /** Agents to show in a project snapshot. */
  visible(): AgentInfo[] {
    return [...this.runs.values()].filter((r) => !this.finishedAt.has(r.agent.id) || this.kept.includes(r.agent.id)).map((r) => r.agent);
  }

  /** The person is done reviewing a finished job: off the crew list. */
  clear(id: string): void {
    const i = this.kept.indexOf(id);
    if (i === -1) return;
    this.kept.splice(i, 1);
    this.d.emit({ type: 'agent/remove', agentId: id });
    if (this.finishedAt.has(id) && Date.now() - this.finishedAt.get(id)! > REMEMBER_MS) this.runs.delete(id);
  }

  /** The visible agents' latest steps. */
  recentSteps(): Record<string, AgentStep[]> {
    const out: Record<string, AgentStep[]> = {};
    for (const r of this.runs.values()) if ((!this.finishedAt.has(r.agent.id) || this.kept.includes(r.agent.id)) && r.steps.length) out[r.agent.id] = [...r.steps];
    return out;
  }

  /** Permission cards still waiting for an answer. */
  pendingPermissions(): PermissionRequest[] {
    return [...this.permissions.values()].map((p) => p.request);
  }

  /** By id or name; a name means the newest unfinished run with it ("ada" while "ada-2" works). */
  find(idOrName: string): BuilderRun | undefined {
    const key = idOrName.trim().toLowerCase();
    const live = (r: BuilderRun) => !this.finishedAt.has(r.agent.id);
    const byId = this.runs.get(key);
    if (byId && live(byId)) return byId;
    const newest = [...this.runs.values()].reverse();
    return newest.find((r) => live(r) && r.agent.name.toLowerCase() === key) ?? byId ?? newest.find((r) => r.agent.name.toLowerCase() === key);
  }

  nameOf(id: string): string {
    return this.runs.get(id)?.agent.name ?? id;
  }

  /** `saved`: a job from before a restart, keeping its name and resuming its session. */
  spawn(job: JobSpec, saved?: SavedJob): AgentInfo {
    const { name, hue, id } = saved ?? this.pickName();
    const agent: AgentInfo = {
      id,
      name,
      role: job.kind === 'investigate' ? 'scout' : 'builder',
      hue,
      status: 'starting',
      task: clip(job.title, 60),
      nodeId: job.nodeId,
      activity: 'Getting ready',
      startedAt: saved?.startedAt ?? Date.now(),
    };
    const progress = resumedProgress(saved?.progress, Date.now());
    if (progress) agent.progress = progress;
    if (saved?.changes?.length) agent.changes = saved.changes;
    const run = new BuilderRun(job, agent, {
      ws: this.d.ws,
      emit: this.d.emit,
      settings: this.d.settings(),
      onUpdate: (a) => {
        this.d.emit({ type: 'agent/upsert', agent: a });
        this.persist();
      },
      askPermission: (r, ask) => this.askPermission(r, ask),
      onAsked: (r, item, blocking) => this.onAsked(r, item, blocking),
      onFinished: (r, outcome) => this.onFinished(r, outcome),
      onSession: () => this.persist(),
    });
    if (saved?.sessionId) {
      run.sessionId = saved.sessionId;
      run.resumeNote = resumeNote(saved);
    }
    this.runs.set(id, run);
    this.d.emit({ type: 'agent/upsert', agent });
    this.queue.push(run);
    this.pump();
    if (this.queue.includes(run)) run.update({ activity: 'Waiting for a free slot' });
    log('crew', `${name} [${id}] ${job.kind}${saved ? (saved.sessionId ? ' (resumed)' : ' (restarted)') : ''}: ${job.title}`);
    this.persist();
    return run.agent;
  }

  /** Picks up the jobs left unfinished when the app closed. Returns their names. */
  restore(saved: SavedJob[]): string[] {
    return resumableJobs(saved)
      .filter((s) => !this.runs.has(s.id))
      .map((s) => this.spawn(jobSpec(s), s).name);
  }

  /** Saves every job to `.iae/crew.json` (when something worth saving changed), so unfinished ones resume after a restart. */
  private persist(): void {
    if (this.closed) return;
    const waiting = new Map([...this.permissions.values()].map((p) => [p.agentId, p.request.summary]));
    const jobs = [...this.runs.values()].map((r) => savedJob(r, waiting.get(r.agent.id)));
    const text = JSON.stringify(jobs);
    if (text === this.savedText) return;
    this.savedText = text;
    this.d.ws.store.saveCrew(jobs);
  }

  /** A note for the lead when a new job would have to wait for a slot. */
  slotsNote(): string | undefined {
    const max = this.d.settings().maxBuilders;
    return this.active() + this.queue.length >= max ? `all ${max} builder slots are busy: a new job waits in the queue` : undefined;
  }

  isQueued(id: string): boolean {
    return this.queue.some((r) => r.agent.id === id);
  }

  private pickName(): { name: string; hue: number; id: string } {
    const busy = new Set([...this.runs.values()].filter((r) => !this.finishedAt.has(r.agent.id)).map((r) => r.agent.name));
    let index = NAME_POOL.findIndex((n) => !busy.has(n));
    if (index === -1) index = this.runs.size % NAME_POOL.length;
    const name = NAME_POOL[index];
    let id = name.toLowerCase();
    for (let i = 2; this.runs.has(id); i++) id = `${name.toLowerCase()}-${i}`;
    return { name, hue: index % 6, id };
  }

  private active(): number {
    return [...this.runs.values()].filter((r) => r.isRunning).length;
  }

  /** Settings changed (e.g. more builder slots): start whatever now fits. */
  kick(): void {
    this.pump();
  }

  private pump(): void {
    if (this.closed) return;
    const max = this.d.settings().maxBuilders;
    while (this.queue.length && this.active() < max) {
      const run = this.queue.shift()!;
      try {
        run.start();
      } catch (e) {
        this.onFinished(run, { status: 'failed', result: (e as Error).message });
      }
    }
  }

  message(idOrName: string, text: string): string {
    const run = this.find(idOrName);
    if (!run) return `No agent "${idOrName}".`;
    if (this.queue.includes(run)) {
      run.job.brief += `\n\nUpdate from the architect: ${text}`;
      return `${run.agent.name} hasn't started yet; added to the brief.`;
    }
    if (this.finishedAt.has(run.agent.id)) return `${run.agent.name} already finished. Delegate a follow-up with the context instead.`;
    return run.message(text) ? `Sent to ${run.agent.name}.` : `${run.agent.name} can't take messages right now.`;
  }

  async stop(idOrName: string, by: 'person' | 'lead' = 'person'): Promise<string> {
    const run = this.find(idOrName);
    if (!run || this.finishedAt.has(run.agent.id)) return `No running agent "${idOrName}".`;
    this.stoppedBy.set(run.agent.id, by);
    const queued = this.queue.indexOf(run);
    if (queued !== -1) {
      this.queue.splice(queued, 1);
      this.onFinished(run, { status: 'stopped', result: 'Stopped before starting.' });
    } else {
      await run.stop();
    }
    return `Stopped ${run.agent.name}.`;
  }

  // ── permissions ────────────────────────────────────────────────────────────

  private askPermission(run: BuilderRun, ask: PermissionAsk): Promise<PermissionResult> {
    // A shell command is summed up from the command itself: Claude Code's title would lead with the `cd`.
    const own = permissionSummary(ask.toolName, ask.input, this.d.ws.root, homedir());
    const summary = ask.toolName === 'Bash' ? own : ask.title || own;
    // Auto mode: the person said yes in advance, so no card appears.
    if (this.d.settings().autoApprove) {
      log('crew', `${run.agent.name} auto-approved: ${summary}`);
      return Promise.resolve({ behavior: 'allow', updatedInput: ask.input });
    }
    const id = `perm-${nanoid(6)}`;
    const prev = { status: run.agent.status, activity: run.agent.activity };
    run.update({ status: 'waiting', activity: 'Waiting for your OK' });
    // The whole command too (the summary is one clipped line); the card shows it on demand.
    const detail = ask.toolName === 'Bash' && typeof ask.input.command === 'string' ? ask.input.command.trim() : undefined;
    const request: PermissionRequest = { id, agentId: run.agent.id, tool: ask.toolName, summary, nodeId: run.agent.nodeId, ...(detail ? { detail } : {}) };
    this.d.emit({ type: 'permission/request', ...request });
    return new Promise<PermissionResult>((resolve) => {
      const done = (r: PermissionResult) => {
        if (!this.permissions.has(id)) return;
        this.permissions.delete(id);
        this.d.emit({ type: 'permission/resolved', id });
        if (run.agent.status === 'waiting') run.update({ status: prev.status === 'waiting' ? 'working' : prev.status, activity: prev.activity });
        this.persist();
        resolve(r);
      };
      this.permissions.set(id, { agentId: run.agent.id, toolName: ask.toolName, input: ask.input, suggestions: ask.suggestions, request, resolve: done });
      this.persist();
      ask.signal.addEventListener('abort', () => done({ behavior: 'deny', message: 'Cancelled.' }), { once: true });
    });
  }

  resolvePermission(id: string, decision: 'allow' | 'deny' | 'always'): void {
    const p = this.permissions.get(id);
    if (!p) {
      this.d.emit({ type: 'permission/resolved', id });
      return;
    }
    if (decision === 'deny') {
      p.resolve({ behavior: 'deny', message: 'The person declined this. Find another way, or explain in your summary why it was needed.' });
    } else {
      // "always": Claude Code's own suggested rule, or allow this tool for the rest of the session.
      const always: PermissionUpdate[] = p.suggestions?.length
        ? p.suggestions
        : [{ type: 'addRules', rules: [{ toolName: p.toolName }], behavior: 'allow', destination: 'session' }];
      p.resolve({ behavior: 'allow', updatedInput: p.input, ...(decision === 'always' ? { updatedPermissions: always } : {}) });
    }
  }

  /** Auto mode was switched on: say yes to everything already waiting. */
  approveAll(): number {
    const waiting = [...this.permissions.keys()];
    for (const id of waiting) this.resolvePermission(id, 'allow');
    if (waiting.length) log('crew', `auto mode approved ${waiting.length} waiting request${waiting.length === 1 ? '' : 's'}`);
    return waiting.length;
  }

  // ── questions & completion ─────────────────────────────────────────────────

  private onAsked(run: BuilderRun, item: AgendaItem, blocking: boolean): void {
    const where = item.nodeId ? ` on ${item.nodeId}` : '';
    this.d.ws.pushEvent(`${run.agent.name} asks${blocking ? ' (BLOCKING, waiting for the answer)' : ''}${where}: "${item.prompt}" [${item.id}]`, blocking);
    if (!blocking) this.askedBy.set(item.id, run.agent.id);
    this.d.onLeadEvent();
  }

  /**
   * An agenda item was answered: forward non-blocking answers to whoever asked.
   * Returns the names of builders that now have the answer (blocked ones get it
   * through their wait), so the lead doesn't relay it a second time.
   */
  answered(item: AgendaItem): string[] {
    const told = (item.blocking ?? []).map((id) => this.nameOf(id));
    const agentId = this.askedBy.get(item.id);
    if (!agentId) return told;
    this.askedBy.delete(item.id);
    if (this.runs.get(agentId)?.message(`Answer to your question "${item.prompt}": ${item.answer}`)) told.push(this.nameOf(agentId));
    return told;
  }

  private onFinished(run: BuilderRun, outcome: Outcome): void {
    const { ws } = this.d;
    const id = run.agent.id;
    if (this.finishedAt.has(id)) return;
    this.finishedAt.set(id, Date.now());
    for (const p of this.permissions.values()) if (p.agentId === id) p.resolve({ behavior: 'deny', message: 'Stopped.' });
    ws.agenda.releaseAgent(id, run.agent.name);
    run.update({
      status: outcome.status,
      activity: undefined,
      file: undefined,
      endedAt: Date.now(),
      result: clip(outcome.result.replace(/\s+/g, ' ').trim(), 600),
    });
    if (this.closed) return;
    const where = run.job.nodeId ? ` on ${run.job.nodeId}` : '';
    // The whole summary (builders keep it to a few sentences): cut short, the lead hears half a thought.
    const summary = clip(outcome.result.replace(/\s+/g, ' ').trim(), 1500);
    const verb = outcome.status === 'done' ? (run.isScout ? 'found' : 'finished') : outcome.status === 'failed' ? 'failed' : 'was stopped on';
    if (outcome.status === 'stopped') {
      const by = this.stoppedBy.get(id);
      const what = `${run.agent.name} on "${run.job.title}"${where} before it finished`;
      ws.pushEvent(by === 'lead' ? `You stopped ${what}` : by === 'person' ? `The person stopped ${what}` : `${run.agent.name} was stopped on "${run.job.title}"${where}`, false);
    } else {
      ws.pushEvent(`${run.agent.name} ${verb} "${run.job.title}"${where}: ${summary}`, true);
    }
    ws.appendTranscript('system', `${run.agent.name} ${verb} ${run.job.title}.`, run.job.nodeId);
    // New files get one-line meanings (the builder's own notes win).
    const created = [...run.created];
    void ws.rescan().then(() => (created.length && outcome.status === 'done' ? noteNewFiles(ws, created, this.d.settings().sketchModel) : 0));
    // What it changed is worth a look: it stays on the crew list until cleared. The rest leave after a moment.
    if (run.agent.changes?.length) {
      this.kept.push(id);
      while (this.kept.length > MAX_KEPT) this.clear(this.kept[0]);
    } else this.later(REMOVE_AFTER_MS, () => this.d.emit({ type: 'agent/remove', agentId: id }));
    this.later(REMEMBER_MS, () => this.finishedAt.has(id) && !this.kept.includes(id) && this.runs.delete(id));
    this.pump();
    this.d.onLeadEvent();
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  /** One line per agent for the lead's context: running, queued, and recently finished. */
  statusLines(): string[] {
    const lines: string[] = [];
    const now = Date.now();
    for (const r of this.runs.values()) {
      const a = r.agent;
      const ended = this.finishedAt.get(a.id);
      if (ended && now - ended > REMEMBER_MS) continue;
      const head = `${a.name} [${a.id}] (${a.role}, ${this.queue.includes(r) ? 'queued' : a.status})${a.nodeId ? ` on ${a.nodeId}` : ''} — "${a.task}"`;
      if (ended) lines.push(`${head}: ${clip(a.result ?? '', 160)}`);
      else lines.push(`${head}${a.activity ? ` · ${a.activity}` : ''}${planLine(a, now)}`);
    }
    return lines.slice(-8);
  }

  async closeAll(): Promise<void> {
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.queue = [];
    await Promise.all([...this.runs.values()].map((r) => r.stop().catch(() => {})));
  }
}

/** Where a builder is in its plan, for the lead ("how close is Ada?"): " · step 2/5 (Wire playback) · 4 min in". */
export function planLine(a: AgentInfo, now: number): string {
  const p = a.progress;
  const mins = Math.max(0, Math.round((now - a.startedAt) / 60_000));
  const step = p?.steps.length ? ` · step ${Math.min(p.done + 1, p.steps.length)}/${p.steps.length} (${clip(p.steps[Math.min(p.done, p.steps.length - 1)], 40)})` : '';
  return `${step} · ${mins} min in`;
}

/** The one line on a permission card. Shell commands show what really runs (no `cd <project> &&`, short paths). */
export function permissionSummary(toolName: string, input: Record<string, unknown>, root?: string, home?: string): string {
  const file = typeof input.file_path === 'string' ? basename(input.file_path) : null;
  switch (toolName) {
    case 'Bash':
      return `Run ${commandSummary(String(input.command ?? ''), root, home, 90)}`;
    case 'Write':
      return `Write ${file ?? 'a file'}`;
    case 'Edit':
    case 'MultiEdit':
      return `Edit ${file ?? 'a file'}`;
    case 'WebFetch':
      return `Fetch ${clip(String(input.url ?? ''), 60)}`;
    default:
      return toolName.startsWith('mcp__') ? `Use ${toolName.replace(/^mcp__/, '').replace(/__/g, ' ')}` : `Use ${toolName}`;
  }
}
