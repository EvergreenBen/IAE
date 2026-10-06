// The agenda: open questions anchored on the map, decisions, and builders
// waiting on answers. Ordering = what unblocks work first, then priority (the
// lead's estimate of the cost of getting it wrong), then age.

import { nanoid } from 'nanoid';
import type { AgendaItem, AgendaKind, Decision } from '../../shared/model';

export const MAX_OPEN = 5;
const KEEP_CLOSED = 40;
const BLOCKING_PRIORITY = 0.95;

export interface AskInput {
  prompt: string;
  kind?: AgendaKind;
  why?: string;
  options?: string[];
  nodeId?: string | null;
  priority?: number;
  blocking?: string[];
}

export interface AgendaSink {
  upsert(item: AgendaItem): void;
  remove(id: string): void;
  decision(d: Decision): void;
  persist(items: AgendaItem[], decisions: Decision[]): void;
}

type Waiter = (answer: string | null) => void;

export const clamp01 = (n: unknown, fallback: number): number => {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : fallback;
  return Math.min(1, Math.max(0, v));
};

export function compareAgenda(a: AgendaItem, b: AgendaItem): number {
  const ab = a.blocking?.length ? 1 : 0;
  const bb = b.blocking?.length ? 1 : 0;
  return bb - ab || b.priority - a.priority || a.createdAt - b.createdAt;
}

export class Agenda {
  private items: AgendaItem[];
  private decisions: Decision[];
  private waiters = new Map<string, Waiter[]>();

  constructor(
    items: AgendaItem[],
    decisions: Decision[],
    private readonly sink: AgendaSink,
  ) {
    // Builders don't survive a restart, so nothing is blocked on reload.
    this.items = items.map((i) => (i.blocking?.length ? { ...i, blocking: [] } : i));
    this.decisions = decisions;
  }

  open(): AgendaItem[] {
    return this.items.filter((i) => i.status === 'open').sort(compareAgenda);
  }

  get(id: string): AgendaItem | undefined {
    return this.items.find((i) => i.id === id);
  }

  allDecisions(): Decision[] {
    return this.decisions;
  }

  ask(input: AskInput): AgendaItem {
    const blocking = input.blocking?.filter(Boolean) ?? [];
    const options = (input.options ?? []).map((o) => String(o).trim()).filter(Boolean).slice(0, 4);
    const item: AgendaItem = {
      id: `q-${nanoid(6)}`,
      kind: input.kind ?? 'decision',
      prompt: input.prompt.trim(),
      why: input.why?.trim() || undefined,
      options: options.length ? options : undefined,
      nodeId: input.nodeId ?? null,
      blocking,
      priority: blocking.length ? Math.max(BLOCKING_PRIORITY, clamp01(input.priority, 0.5)) : clamp01(input.priority, 0.5),
      status: 'open',
      createdAt: Date.now(),
    };
    this.items.push(item);
    this.sink.upsert(item);
    this.prune();
    this.save();
    return item;
  }

  /** Keeps at most MAX_OPEN open; the lowest-ranked non-blocking items go first. */
  private prune(): void {
    const open = this.open();
    for (const item of open.slice(MAX_OPEN).reverse()) {
      if (item.blocking?.length) continue;
      this.close(item.id, 'dismissed');
    }
  }

  answer(id: string, answer: string): AgendaItem | null {
    const item = this.close(id, 'answered', answer);
    if (!item) return null;
    if (item.kind === 'decision') this.decide({ title: answer, rationale: item.prompt, nodeId: item.nodeId });
    return item;
  }

  dismiss(id: string): AgendaItem | null {
    return this.close(id, 'dismissed');
  }

  private close(id: string, status: 'answered' | 'dismissed', answer?: string): AgendaItem | null {
    const i = this.items.findIndex((x) => x.id === id);
    if (i === -1 || this.items[i].status !== 'open') return null;
    const item: AgendaItem = { ...this.items[i], status, answer };
    this.items[i] = item;
    this.sink.remove(id);
    for (const w of this.waiters.get(id) ?? []) w(status === 'answered' ? (answer ?? '') : null);
    this.waiters.delete(id);
    this.save();
    return item;
  }

  /** Marks an agent as blocked on an item (shown on the card). */
  addBlocker(id: string, agentId: string): void {
    const i = this.items.findIndex((x) => x.id === id);
    if (i === -1 || this.items[i].status !== 'open') return;
    const prev = this.items[i];
    if (prev.blocking?.includes(agentId)) return;
    const item = { ...prev, blocking: [...(prev.blocking ?? []), agentId], priority: Math.max(prev.priority, BLOCKING_PRIORITY) };
    this.items[i] = item;
    this.sink.upsert(item);
    this.save();
  }

  /** Removes an agent from every item it was blocking (it stopped or finished). */
  releaseAgent(agentId: string): void {
    this.items = this.items.map((item) => {
      if (item.status !== 'open' || !item.blocking?.includes(agentId)) return item;
      const next = { ...item, blocking: item.blocking.filter((a) => a !== agentId) };
      this.sink.upsert(next);
      return next;
    });
    this.save();
  }

  /** Resolves with the answer, or null when dismissed or timed out. */
  waitFor(id: string, timeoutMs: number, signal?: AbortSignal): Promise<string | null> {
    const item = this.get(id);
    if (!item) return Promise.resolve(null);
    if (item.status !== 'open') return Promise.resolve(item.status === 'answered' ? (item.answer ?? '') : null);
    return new Promise((resolve) => {
      let done = false;
      const finish = (v: string | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      signal?.addEventListener('abort', () => finish(null), { once: true });
      const list = this.waiters.get(id) ?? [];
      list.push(finish);
      this.waiters.set(id, list);
    });
  }

  decide(input: { title: string; rationale?: string; nodeId?: string | null }): Decision {
    const d: Decision = {
      id: `d-${nanoid(6)}`,
      title: input.title.trim(),
      rationale: input.rationale?.trim() || undefined,
      nodeId: input.nodeId ?? null,
      at: Date.now(),
    };
    this.decisions.push(d);
    this.sink.decision(d);
    this.save();
    return d;
  }

  /** Releases every waiter (project closing). */
  shutdown(): void {
    for (const list of this.waiters.values()) for (const w of list) w(null);
    this.waiters.clear();
  }

  private save(): void {
    const open = this.items.filter((i) => i.status === 'open');
    const closed = this.items.filter((i) => i.status !== 'open').slice(-KEEP_CLOSED);
    this.items = [...closed, ...open].sort((a, b) => a.createdAt - b.createdAt);
    this.sink.persist(this.items, this.decisions);
  }
}
