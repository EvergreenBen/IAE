// The crew: builders and scouts. Names, concurrency, permission prompts, and
// what happens when a job finishes (node status, rescan, a digest for the lead).

import type { PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import { nanoid } from 'nanoid';
import { basename } from 'node:path';
import type { EngineEvent } from '../../shared/events';
import type { AgendaItem, AgentInfo, Settings } from '../../shared/model';
import { BuilderRun, type JobSpec, type Outcome, type PermissionAsk } from './builder';
import { log } from './sdk';
import type { Workspace } from './workspace';

export const NAME_POOL = ['Ada', 'Kit', 'Rho', 'Juno', 'Max', 'Bea', 'Lev', 'Ivy'];
const REMOVE_AFTER_MS = 6_000;
const REMEMBER_MS = 10 * 60_000;

interface PendingPermission {
  agentId: string;
  toolName: string;
  input: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
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
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private closed = false;

  constructor(private readonly d: CrewDeps) {}

  /** Agents to show in a project snapshot. */
  visible(): AgentInfo[] {
    return [...this.runs.values()].filter((r) => !this.finishedAt.has(r.agent.id)).map((r) => r.agent);
  }

  find(idOrName: string): BuilderRun | undefined {
    const key = idOrName.trim().toLowerCase();
    return this.runs.get(key) ?? [...this.runs.values()].reverse().find((r) => r.agent.name.toLowerCase() === key);
  }

  nameOf(id: string): string {
    return this.runs.get(id)?.agent.name ?? id;
  }

  spawn(job: JobSpec): AgentInfo {
    const { name, hue, id } = this.pickName();
    const agent: AgentInfo = {
      id,
      name,
      role: job.kind === 'investigate' ? 'scout' : 'builder',
      hue,
      status: 'starting',
      task: clip(job.title, 60),
      nodeId: job.nodeId,
      activity: 'Getting ready',
      startedAt: Date.now(),
    };
    const run = new BuilderRun(job, agent, {
      ws: this.d.ws,
      emit: this.d.emit,
      settings: this.d.settings(),
      onUpdate: (a) => this.d.emit({ type: 'agent/upsert', agent: a }),
      askPermission: (r, ask) => this.askPermission(r, ask),
      onAsked: (r, item, blocking) => this.onAsked(r, item, blocking),
      onFinished: (r, outcome) => this.onFinished(r, outcome),
    });
    this.runs.set(id, run);
    this.d.emit({ type: 'agent/upsert', agent });
    this.queue.push(run);
    this.pump();
    if (this.queue.includes(run)) run.update({ activity: 'Waiting for a free slot' });
    log('crew', `${name} [${id}] ${job.kind}: ${job.title}`);
    return run.agent;
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

  async stop(idOrName: string): Promise<string> {
    const run = this.find(idOrName);
    if (!run || this.finishedAt.has(run.agent.id)) return `No running agent "${idOrName}".`;
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
    const id = `perm-${nanoid(6)}`;
    const summary = ask.title || permissionSummary(ask.toolName, ask.input);
    const prev = { status: run.agent.status, activity: run.agent.activity };
    run.update({ status: 'waiting', activity: 'Waiting for your OK' });
    this.d.emit({ type: 'permission/request', id, agentId: run.agent.id, tool: ask.toolName, summary, nodeId: run.agent.nodeId });
    return new Promise<PermissionResult>((resolve) => {
      const done = (r: PermissionResult) => {
        if (!this.permissions.has(id)) return;
        this.permissions.delete(id);
        this.d.emit({ type: 'permission/resolved', id });
        if (run.agent.status === 'waiting') run.update({ status: prev.status === 'waiting' ? 'working' : prev.status, activity: prev.activity });
        resolve(r);
      };
      this.permissions.set(id, { agentId: run.agent.id, toolName: ask.toolName, input: ask.input, suggestions: ask.suggestions, resolve: done });
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

  // ── questions & completion ─────────────────────────────────────────────────

  private onAsked(run: BuilderRun, item: AgendaItem, blocking: boolean): void {
    const where = item.nodeId ? ` on ${item.nodeId}` : '';
    this.d.ws.pushEvent(`${run.agent.name} asks${blocking ? ' (BLOCKING, waiting for the answer)' : ''}${where}: "${item.prompt}" [${item.id}]`, blocking);
    if (!blocking) this.askedBy.set(item.id, run.agent.id);
    this.d.onLeadEvent();
  }

  /** An agenda item was answered: forward non-blocking answers to whoever asked. */
  answered(item: AgendaItem): void {
    const agentId = this.askedBy.get(item.id);
    if (!agentId) return;
    this.askedBy.delete(item.id);
    this.runs.get(agentId)?.message(`Answer to your question "${item.prompt}": ${item.answer}`);
  }

  private onFinished(run: BuilderRun, outcome: Outcome): void {
    const { ws } = this.d;
    const id = run.agent.id;
    if (this.finishedAt.has(id)) return;
    this.finishedAt.set(id, Date.now());
    for (const p of this.permissions.values()) if (p.agentId === id) p.resolve({ behavior: 'deny', message: 'Stopped.' });
    ws.agenda.releaseAgent(id);
    run.update({
      status: outcome.status,
      activity: undefined,
      file: undefined,
      endedAt: Date.now(),
      result: clip(outcome.result.replace(/\s+/g, ' ').trim(), 600),
    });
    if (this.closed) return;
    const where = run.job.nodeId ? ` on ${run.job.nodeId}` : '';
    const summary = clip(outcome.result.replace(/\s+/g, ' ').trim(), 400);
    const verb = outcome.status === 'done' ? (run.isScout ? 'found' : 'finished') : outcome.status === 'failed' ? 'failed' : 'was stopped on';
    ws.pushEvent(`${run.agent.name} ${verb} "${run.job.title}"${where}${outcome.status === 'stopped' ? '' : `: ${summary}`}`, outcome.status !== 'stopped');
    ws.appendTranscript('system', `${run.agent.name} ${verb} ${run.job.title}.`, run.job.nodeId);
    void ws.rescan();
    this.later(REMOVE_AFTER_MS, () => this.d.emit({ type: 'agent/remove', agentId: id }));
    this.later(REMEMBER_MS, () => this.finishedAt.has(id) && this.runs.delete(id));
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
      else lines.push(`${head}${a.activity ? ` · ${a.activity}` : ''}`);
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

export function permissionSummary(toolName: string, input: Record<string, unknown>): string {
  const file = typeof input.file_path === 'string' ? basename(input.file_path) : null;
  switch (toolName) {
    case 'Bash':
      return `Run ${clip(String(input.command ?? '').split('\n')[0], 80)}`;
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
