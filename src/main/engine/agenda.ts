// The agenda: open questions anchored on the map, decisions, and builders
// waiting on answers. Ordering = what unblocks work first, then priority (the
// lead's estimate of the cost of getting it wrong), then age.

import { nanoid } from 'nanoid';
import { ancestorsOf, visibleAncestor } from '../../shared/map';
import type { AgendaItem, AgendaKind, ArchMap, Decision } from '../../shared/model';

/**
 * Where a question card goes: on the node being discussed as seen from where
 * the person is looking. A card on a leaf deep inside only shows as a dot at
 * higher zoom, so it moves up to the node that's visible at the current scope
 * (the scope itself or one of its children). Outside the scope it sits no
 * deeper than a top-level node's child.
 */
export function anchorNode(map: ArchMap, nodeId: string | null | undefined, scopeId: string | null): string | null {
  if (!nodeId || !map.nodes[nodeId]) return null;
  if (nodeId === scopeId) return nodeId;
  const visible = visibleAncestor(map, nodeId, scopeId);
  if (visible) return visible;
  const chain = ancestorsOf(map, nodeId);
  return chain.length > 1 ? chain[1].id : nodeId;
}

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

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A sentence that speaks of the builder as at work right now ("Ada is writing the scheduler now"). */
function presentTense(name: string): RegExp {
  const n = escapeRe(name);
  return new RegExp(
    [
      `\\b(?:while|until|before|once|as soon as)\\s+${n}\\b`,
      `\\b${n}(?:'s|’s|\\s+is|\\s+are|'ll|’ll|\\s+will\\s+be)\\s+(?:still\\s+|now\\s+|currently\\s+|already\\s+)?\\w+ing\\b`,
      `\\b${n}(?:\\s+(?:still|now|currently))?\\s+(?:is|are|needs?|wants?|waits?|will|can't|can’t|cannot|won't|won’t|has\\s+to|keeps?|starts?|builds?|writes?|works?|runs?|migrates?|wires?|adds?|sets?\\s+up)\\b`,
      `\\b${n}(?:'s|’s)\\s+(?:still|now|currently|about|waiting|blocked|on\\s+it)\\b`,
    ].join('|'),
  );
}

/**
 * The card's "why" once a builder has stopped or finished: sentences that talk
 * about it as still at work go (the rest stays); nothing left means no why.
 */
export function whyWithout(why: string | undefined, names: string[]): string | undefined {
  if (!why) return why;
  const stale = names.filter(Boolean).map(presentTense);
  if (!stale.some((re) => re.test(why))) return why;
  const kept = why
    .split(/(?<=[.!?;])\s+/)
    .filter((s) => !stale.some((re) => re.test(s)))
    .join(' ')
    .trim();
  return kept || undefined;
}

/** Who made a decision: the person (said it, or answered a card) or the lead on its own. */
export type DecidedBy = 'person' | 'lead';

/** "Archie's call: …" — how the lead's own calls are marked (the rationale carries it, so no schema change). */
const OWN_CALL = /^\s*(?:[^\s:'’]{1,24} ){0,2}[^\s:'’]{1,24}['’]s call\b:?\s*/;

export function ownCallRationale(leadName: string, rationale?: string): string {
  const why = rationale?.trim().replace(OWN_CALL, '');
  return `${leadName.trim() || 'Archie'}'s call${why ? `: ${why}` : ''}`;
}

/** True for a decision the lead made itself (not the person's choice). */
export function isOwnCall(d: Decision): boolean {
  return !!d.rationale && OWN_CALL.test(d.rationale);
}

/** The rationale without the "Archie's call" mark. */
export function plainRationale(d: Decision): string | undefined {
  return d.rationale?.replace(OWN_CALL, '').trim() || undefined;
}

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
    /** Builder names: none of them is at work after a restart. */
    crewNames: string[] = [],
  ) {
    // Builders don't survive a restart, so nothing is blocked on reload, and no card says one is at work.
    this.items = items.map((i) => {
      if (i.status !== 'open') return i;
      const why = whyWithout(i.why, crewNames);
      return i.blocking?.length || why !== i.why ? { ...i, blocking: [], why } : i;
    });
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

  /**
   * Closes an item with the person's answer. The decision it settles is
   * recorded by the lead (decide, in its own words), not here, so each choice
   * is stored once.
   */
  answer(id: string, answer: string): AgendaItem | null {
    return this.close(id, 'answered', answer);
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

  /** The agent stopped waiting on this item (it timed out and went on with a default). */
  removeBlocker(id: string, agentId: string): void {
    const i = this.items.findIndex((x) => x.id === id);
    if (i === -1 || this.items[i].status !== 'open' || !this.items[i].blocking?.includes(agentId)) return;
    const item = { ...this.items[i], blocking: this.items[i].blocking!.filter((a) => a !== agentId) };
    this.items[i] = item;
    this.sink.upsert(item);
    this.save();
  }

  /**
   * An agent stopped or finished: it no longer blocks anything, and no card's
   * "why" says it's still at work ("Ada is writing the scheduler now").
   */
  releaseAgent(agentId: string, name?: string): void {
    this.items = this.items.map((item) => {
      if (item.status !== 'open') return item;
      const blocked = !!item.blocking?.includes(agentId);
      const why = name ? whyWithout(item.why, [name]) : item.why;
      if (!blocked && why === item.why) return item;
      const next = { ...item, blocking: (item.blocking ?? []).filter((a) => a !== agentId), why };
      if (!why) delete next.why;
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
      const onAbort = () => finish(null);
      const finish = (v: string | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const rest = (this.waiters.get(id) ?? []).filter((w) => w !== finish);
        if (rest.length) this.waiters.set(id, rest);
        else this.waiters.delete(id);
        resolve(v);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      const list = this.waiters.get(id) ?? [];
      list.push(finish);
      this.waiters.set(id, list);
    });
  }

  /**
   * Records a decision. The lead's own calls (`by: 'lead'`) are marked in the
   * rationale ("Archie's call: …"), so later turns recall them as the lead's,
   * not as something decided together.
   */
  decide(input: { title: string; rationale?: string; nodeId?: string | null; by?: DecidedBy; leadName?: string }): Decision {
    const rationale = input.by === 'lead' ? ownCallRationale(input.leadName ?? 'Archie', input.rationale) : input.rationale?.trim().replace(OWN_CALL, '') || undefined;
    const d: Decision = {
      id: `d-${nanoid(6)}`,
      title: input.title.trim(),
      rationale,
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
