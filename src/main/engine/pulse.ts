// The never-idle heartbeat. Every few seconds it asks: is the person quiet,
// is the lead idle (and done speaking), and is there something new worth
// raising? If so it nudges the lead. Urgent events (a build finished, a
// builder is blocked) go out as soon as the person isn't mid-utterance; plain
// nudges wait for ~20s of quiet and back off (45s → 90s → 180s) until the
// person speaks again.
//
// "New" matters: a question the lead already asked is on screen as a card, so
// it isn't raised again; builders at work earn one nudge (use their time to
// settle the next decision); events always count. When nothing is new the
// pulse stays quiet instead of asking the lead to repeat itself.

import type { TurnKind } from './context';
import type { Workspace } from './workspace';

export const TICK_MS = 5_000;
export const IDLE_BEFORE_PULSE_MS = 20_000;
export const URGENT_GRACE_MS = 1_500;
export const BACKOFF_MS = [45_000, 90_000, 180_000];

export interface PulseLead {
  readonly busy: boolean;
  readonly speechEndsAt: number;
  send(kind: TurnKind, body: string): void;
}

export interface PulseDeps {
  ws: Workspace;
  lead: PulseLead;
  /** Builders and scouts at work right now. */
  working?: () => { id: string; name: string }[];
  now?: () => number;
}

export type PulseReason = 'events' | 'agenda' | 'crew' | 'empty';

interface Topic {
  key: string;
  why: PulseReason;
}

export class Pulse {
  private timer: ReturnType<typeof setInterval> | null = null;
  private wake: ReturnType<typeof setTimeout> | null = null;
  private level = 0;
  private lastNudgeAt = 0;
  /** Topics the lead has already had its chance to raise. */
  private seen = new Set<string>();

  constructor(private readonly d: PulseDeps) {}

  start(): void {
    if (!this.timer) this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.wake) clearTimeout(this.wake);
    this.timer = null;
    this.wake = null;
  }

  /** The person said or drafted something: nudges start over at the shortest interval. */
  userActive(): void {
    this.level = 0;
  }

  /** Something urgent happened; check now instead of waiting for the next tick. */
  poke(): void {
    setTimeout(() => this.tick(), 0);
  }

  /**
   * A lead turn ended. Whatever was on the agenda then has been heard (the
   * lead saw it in context and a card is on screen). Builders at work still
   * earn their own nudge unless this was one.
   */
  turnEnded(kind: TurnKind): void {
    for (const t of this.topics()) if (t.why !== 'crew' || kind === 'pulse') this.seen.add(t.key);
  }

  private topics(): Topic[] {
    const { ws } = this.d;
    const out: Topic[] = [];
    const top = ws.agenda.open()[0];
    if (top) out.push({ key: `top:${top.id}`, why: 'agenda' });
    const working = this.d.working?.() ?? [];
    if (working.length) out.push({ key: `crew:${working.map((a) => a.id).sort().join(',')}`, why: 'crew' });
    if (ws.info.isNew && Object.keys(ws.map.nodes).length === 0) out.push({ key: 'empty', why: 'empty' });
    return out;
  }

  /** What a nudge would be about, or null when nothing new clears the bar. */
  pending(): PulseReason | null {
    if (this.d.ws.hasEvents()) return 'events';
    return this.topics().find((t) => !this.seen.has(t.key))?.why ?? null;
  }

  private body(why: PulseReason, quiet: number): string {
    const secs = `the person has been quiet for ${Math.round(quiet / 1000)}s`;
    if (why === 'crew') {
      const names = (this.d.working?.() ?? []).map((a) => a.name);
      const who = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)} are` : `${names[0] ?? 'the crew'} is`;
      return `${secs}; ${who} building. Use the time: if a real decision is coming up (for the work in flight or what comes after), raise it now. Otherwise <silence/>.`;
    }
    if (why === 'agenda') return `${secs}; the top open question hasn't been raised yet.`;
    if (why === 'empty') return `${secs} on an empty project.`;
    return secs;
  }

  tick(): 'events' | 'pulse' | null {
    const { ws, lead } = this.d;
    const now = this.d.now?.() ?? Date.now();
    if (ws.isClosed || lead.busy || ws.presence !== 'idle') return null;
    if (now < lead.speechEndsAt) {
      // Still speaking: look again right when it should be done.
      if (this.timer && !this.wake && ws.hasEvents(true)) {
        this.wake = setTimeout(() => {
          this.wake = null;
          this.tick();
        }, lead.speechEndsAt - now + 50);
      }
      return null;
    }
    const quiet = now - ws.lastUserActivityAt;
    if (ws.hasEvents(true) && quiet >= URGENT_GRACE_MS) {
      lead.send('events', '');
      return 'events';
    }
    if (quiet < IDLE_BEFORE_PULSE_MS) return null;
    if (now - this.lastNudgeAt < BACKOFF_MS[Math.min(this.level, BACKOFF_MS.length - 1)]) return null;
    const why = this.pending();
    if (!why) return null;
    this.lastNudgeAt = now;
    this.level++;
    for (const t of this.topics()) this.seen.add(t.key);
    lead.send('pulse', this.body(why, quiet));
    return 'pulse';
  }
}
