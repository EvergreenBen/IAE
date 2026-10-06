// Architecture autocomplete: a warm, minimal Haiku session turns the words the
// person is still saying into ghost nodes. Debounced; only the latest draft
// matters; failures are silent (the renderer's lexicon ghosts still work).

import { query, type Query } from '@anthropic-ai/claude-agent-sdk';
import type { EngineEvent } from '../../shared/events';
import { slug } from '../../shared/map';
import type { ArchMap, GhostProposal, Settings } from '../../shared/model';
import { clamp01 } from './agenda';
import { normalizeKind } from './mapops';
import { sketcherSystemPrompt } from './prompts';
import { assistantText, errorText, InputQueue, leanOptions, log } from './sdk';

const DEBOUNCE_MS = 300;
const MIN_CHARS = 12;
const RECYCLE_AFTER = 20;
const MAX_FAILURES = 3;
const COOLDOWN_MS = 60_000;
const REPLY_TIMEOUT_MS = 15_000;

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
  for (const item of arr.slice(0, 8)) {
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
  return out.slice(0, 4);
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
}

export class Sketcher {
  private latest: Draft | null = null;
  private inFlight: Draft | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private session: Session | null = null;
  private used = 0;
  /** The map text this session last saw; unchanged maps aren't re-sent. */
  private sentMap = '';
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
    const reply = await this.ask(session, `${nodes}\nSentence so far: "${draft.text}"`);
    this.inFlight = null;
    if (this.closed) return;
    const latest = this.latest;
    // A newer utterance replaced this one: its ghosts would be wrong.
    if (reply !== null && latest && latest.draftId === draft.draftId) {
      this.d.emit({ type: 'ghost/proposals', draftId: draft.draftId, proposals: parseProposals(reply, this.d.map()) });
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
        systemPrompt: sketcherSystemPrompt(),
        persistSession: false,
        permissionMode: 'dontAsk',
      },
    });
    const session: Session = { q, input, waiting: null, dead: false };
    this.used = 0;
    this.sentMap = '';
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

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.session) this.dropSession(this.session);
  }
}
