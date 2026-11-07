// Architecture autocomplete: a warm, minimal Haiku session turns the words the
// person is still saying into ghost nodes. Debounced; only the latest draft
// matters; failures are silent (the renderer's lexicon ghosts still work).
// Each draft is sent whole, with what's already sketched for it, and the
// ghosts shown for an utterance are the union of every answer for it: later
// words add ghosts, they never wipe out what the first words sketched.

import { query, type Query } from './agent';
import type { EngineEvent } from '../../shared/events';
import { slug } from '../../shared/map';
import type { ArchMap, GhostProposal, Settings } from '../../shared/model';
import { clamp01 } from './agenda';
import { normalizeKind } from './mapops';
import { sketcherSystemPrompt } from './prompts';
import { assistantText, debug, errorText, InputQueue, leanOptions, log } from './sdk';

const DEBOUNCE_MS = 300;
const MIN_CHARS = 12;
const RECYCLE_AFTER = 20;
const MAX_FAILURES = 3;
const COOLDOWN_MS = 60_000;
const REPLY_TIMEOUT_MS = 15_000;

const MAX_PER_REPLY = 6;
/** Ghosts shown for one utterance at most (the union of every draft's answer). */
export const MAX_GHOSTS = 8;

/** Robustly reads the model's JSON array into proposals that aren't on the map yet. */
export function parseProposals(raw: string, map: ArchMap): GhostProposal[] {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end <= start) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const labels = new Set(Object.values(map.nodes).map((n) => n.label.toLowerCase()));
  const seen = new Set<string>();
  const out: GhostProposal[] = [];
  for (const item of arr.slice(0, MAX_PER_REPLY + 4)) {
    if (!item || typeof item !== 'object') continue;
    const p = item as Record<string, unknown>;
    const label = typeof p.label === 'string' ? p.label.replace(/\s+/g, ' ').trim().slice(0, 40) : '';
    if (!label) continue;
    const key = slug(label);
    if (map.nodes[key] || labels.has(label.toLowerCase()) || seen.has(key)) continue;
    seen.add(key);
    const near = typeof p.near === 'string' && map.nodes[p.near] ? p.near : null;
    const connects = Array.isArray(p.connects) ? p.connects.filter((c): c is string => typeof c === 'string' && !!map.nodes[c]) : [];
    out.push({ key, label, kind: normalizeKind(p.kind) ?? 'module', nearNodeId: near, connectsTo: connects, confidence: clamp01(p.confidence, 0.6), source: 'sketch' });
  }
  return out.slice(0, MAX_PER_REPLY);
}

const FILLER_WORDS = new Set(['the', 'a', 'an', 'of', 'for', 'and', '&']);

/** "Route Tracking" ≈ "Route Tracker", "Class Bookings" ≈ "Class Booking", "Member Auth" ≈ "Member Authentication". */
function stem(word: string): string {
  return word.replace(/(ings?|ers?|ions?|s)$/, '') || word;
}

function tokens(label: string): string[] {
  return label
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !FILLER_WORDS.has(w))
    .map(stem);
}

const sameToken = (a: string, b: string): boolean => a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)));

/** Two labels name the same component (word order, plurals and -ing/-er forms aside). */
export function sameComponent(a: string, b: string): boolean {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.length || ta.length !== tb.length) return false;
  const rest = [...tb];
  for (const t of ta) {
    const i = rest.findIndex((u) => sameToken(t, u));
    if (i === -1) return false;
    rest.splice(i, 1);
  }
  return true;
}

/** The text names the component (any of its words, loosely): "meal planner" in "…plan meals…". */
export function mentioned(label: string, text: string): boolean {
  const words = tokens(text);
  return tokens(label).some((t) => t.length >= 3 && words.some((w) => sameToken(t, w)));
}

/**
 * A warm session sometimes carries a component over from the person's previous
 * sentence. In a new sentence, a component the last one already had stays only
 * if the new words mention it.
 */
export function withoutCarryover(next: GhostProposal[], previous: GhostProposal[], text: string): GhostProposal[] {
  if (!previous.length) return next;
  return next.filter((p) => !previous.some((q) => q.key === p.key || sameComponent(q.label, p.label)) || mentioned(p.label, text));
}

export interface MergeOptions {
  max?: number;
  /** Labels that are never components (the product's own name). */
  exclude?: (string | undefined)[];
}

/**
 * One utterance's ghosts: everything any draft of it implied so far, so later
 * words never wipe out what earlier words sketched. A component keeps the key
 * and label it first appeared with (no flicker); newer answers refresh its
 * placement. Whatever has since landed on the map stops being a ghost. Over
 * the cap, what the latest answer no longer lists goes first.
 */
export function mergeProposals(prev: GhostProposal[], next: GhostProposal[], map: ArchMap, opts: MergeOptions = {}): GhostProposal[] {
  const max = opts.max ?? MAX_GHOSTS;
  const onMap = new Set(Object.values(map.nodes).map((n) => n.label.toLowerCase()));
  const excluded = (opts.exclude ?? []).filter((x): x is string => !!x?.trim());
  const live = (p: GhostProposal) => !map.nodes[p.key] && !onMap.has(p.label.toLowerCase()) && !excluded.some((x) => sameComponent(x, p.label));
  const out = prev.filter(live).map((p) => ({ ...p }));
  const fresh = new Set<string>();
  for (const p of next) {
    if (!live(p)) continue;
    const i = out.findIndex((q) => q.key === p.key || sameComponent(q.label, p.label));
    if (i === -1) {
      out.push(p);
      fresh.add(p.key);
      continue;
    }
    const q = out[i];
    fresh.add(q.key);
    out[i] = {
      ...q,
      kind: p.kind,
      nearNodeId: p.nearNodeId ?? q.nearNodeId ?? null,
      connectsTo: p.connectsTo?.length ? p.connectsTo : q.connectsTo,
      confidence: Math.max(q.confidence, p.confidence),
    };
  }
  while (out.length > max) {
    // The least likely of those the latest answer dropped (the oldest of equals).
    const pool = out.some((g) => !fresh.has(g.key)) ? out.filter((g) => !fresh.has(g.key)) : out;
    const worst = pool.reduce((w, g) => (g.confidence < w.confidence ? g : w));
    out.splice(out.indexOf(worst), 1);
  }
  return out;
}

/** The map as the sketcher sees it: ids, labels and the gist of each summary (to spot overlap). */
export function compactMap(map: ArchMap, max = 60): string {
  const nodes = Object.values(map.nodes).slice(0, max);
  const gist = (s: string) => (s.length > 64 ? `${s.slice(0, 63)}…` : s);
  return nodes.length ? nodes.map((n) => `${n.id} (${n.label}${n.summary ? `: ${gist(n.summary)}` : ''})`).join(', ') : '(none yet)';
}

interface Draft {
  draftId: string;
  text: string;
}

interface Session {
  q: Query;
  input: InputQueue;
  waiting: ((text: string | null) => void) | null;
  /** Dropped (failed or recycled): its stream ending later isn't another failure. */
  dead: boolean;
}

export interface SketcherDeps {
  root: string;
  emit: (e: EngineEvent) => void;
  settings: () => Settings;
  map: () => ArchMap;
  /** The product's own name is never a component ("Crag Night"). */
  projectName?: () => string;
}

export class Sketcher {
  private latest: Draft | null = null;
  /** The ghosts shown for the current utterance (its draft id), accumulated across drafts. */
  private shown: { draftId: string; proposals: GhostProposal[] } | null = null;
  /** The previous utterance's ghosts (not carried into a new sentence unless it names them). */
  private before: GhostProposal[] = [];
  private inFlight: Draft | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private session: Session | null = null;
  private used = 0;
  /** The map text this session last saw; unchanged maps aren't re-sent. */
  private sentMap = '';
  /** The utterance this session last saw a draft of. */
  private sentDraftId = '';
  private failures = 0;
  private pausedUntil = 0;
  private closed = false;

  constructor(private readonly d: SketcherDeps) {}

  /** Spawns the session ahead of the first draft. */
  warm(): void {
    if (!this.session && !this.closed && Date.now() >= this.pausedUntil) this.session = this.createSession();
  }

  draft(draftId: string, text: string): void {
    if (this.closed) return;
    this.latest = { draftId, text: text.trim() };
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.latest.text.length < MIN_CHARS) return;
    this.timer = setTimeout(() => void this.fire(), DEBOUNCE_MS);
  }

  private async fire(): Promise<void> {
    this.timer = null;
    const draft = this.latest;
    if (!draft || this.inFlight || this.closed || Date.now() < this.pausedUntil) return;
    if (this.used >= RECYCLE_AFTER && this.session) this.dropSession(this.session);
    if (!this.session) this.session = this.createSession();
    const session = this.session;
    this.inFlight = draft;
    this.used++;
    const mapText = compactMap(this.d.map());
    const nodes = mapText === this.sentMap ? 'Existing nodes: (same as before)' : `Existing nodes: ${mapText}`;
    this.sentMap = mapText;
    // The session can't tell a new utterance from a longer draft of the last one,
    // and each message says what this utterance already has (no reliance on memory).
    const same = this.sentDraftId === draft.draftId;
    this.sentDraftId = draft.draftId;
    const has = this.shown?.draftId === draft.draftId ? this.shown.proposals.map((p) => p.label) : [];
    const reply = await this.ask(
      session,
      `${nodes}\n${same ? 'Same sentence, now longer' : 'New sentence'}: "${draft.text}"${has.length ? `\nAlready sketched for it: ${has.join(', ')}` : ''}`,
    );
    this.inFlight = null;
    if (this.closed) return;
    const latest = this.latest;
    // A newer utterance replaced this one: its ghosts would be wrong.
    debug('sketch', `${same ? '+' : 'new'} "…${draft.text.slice(-48)}" →`, reply);
    if (reply !== null && latest && latest.draftId === draft.draftId) {
      const map = this.d.map();
      if (this.shown && this.shown.draftId !== draft.draftId) this.before = this.shown.proposals;
      const prev = this.shown?.draftId === draft.draftId ? this.shown.proposals : [];
      const fresh = withoutCarryover(parseProposals(reply, map), this.before, draft.text);
      const proposals = mergeProposals(prev, fresh, map, { exclude: [this.d.projectName?.()] });
      this.shown = { draftId: draft.draftId, proposals };
      this.d.emit({ type: 'ghost/proposals', draftId: draft.draftId, proposals });
    }
    if (latest && latest !== draft && latest.text.length >= MIN_CHARS) void this.fire();
  }

  private ask(session: Session, prompt: string): Promise<string | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        session.waiting = null;
        this.fail(session, 'timed out');
        resolve(null);
      }, REPLY_TIMEOUT_MS);
      session.waiting = (text) => {
        clearTimeout(timer);
        session.waiting = null;
        resolve(text);
      };
      session.input.push(prompt);
    });
  }

  private createSession(): Session {
    const s = this.d.settings();
    const input = new InputQueue();
    const q = query({
      prompt: input,
      options: {
        ...leanOptions(this.d.root),
        model: s.sketchModel,
        thinking: { type: 'disabled' },
        tools: [],
        systemPrompt: sketcherSystemPrompt(this.d.projectName?.()),
        persistSession: false,
        permissionMode: 'dontAsk',
      },
    });
    const session: Session = { q, input, waiting: null, dead: false };
    this.used = 0;
    this.sentMap = '';
    this.sentDraftId = '';
    void this.consume(session);
    return session;
  }

  private async consume(session: Session): Promise<void> {
    let text = '';
    try {
      for await (const m of session.q) {
        if (m.type === 'assistant') text = assistantText(m) || text;
        else if (m.type === 'result') {
          const reply = m.subtype === 'success' ? m.result || text : null;
          text = '';
          if (reply !== null) this.failures = 0;
          session.waiting?.(reply);
        }
      }
    } catch (e) {
      if (!this.closed) this.fail(session, errorText(e));
    }
    session.waiting?.(null);
    if (this.session === session) this.session = null;
  }

  private fail(session: Session, why: string): void {
    if (session.dead) return;
    log('sketch', 'failed:', why);
    this.dropSession(session);
    if (++this.failures >= MAX_FAILURES) {
      this.pausedUntil = Date.now() + COOLDOWN_MS;
      this.failures = 0;
    }
  }

  private dropSession(session: Session): void {
    session.dead = true;
    session.input.close();
    try {
      session.q.close();
    } catch {
      // already gone
    }
    if (this.session === session) this.session = null;
  }

  /** The agent changed (Settings): the next draft starts a new session on it. */
  refresh(): void {
    if (this.session) this.dropSession(this.session);
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.session) this.dropSession(this.session);
  }
}
