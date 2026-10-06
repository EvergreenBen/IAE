// The never-idle heartbeat. Every few seconds it asks: is the person quiet,
// is the lead idle (and done speaking), and is anything worth raising? If so it
// nudges the lead. Urgent events (a build finished, a builder is blocked) go
// out as soon as the person isn't mid-utterance; plain nudges wait for ~20s of
// quiet and back off (45s → 90s → 180s) until the person speaks again.

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
  now?: () => number;
}

export class Pulse {
  private timer: ReturnType<typeof setInterval> | null = null;
  private wake: ReturnType<typeof setTimeout> | null = null;
  private level = 0;
  private lastNudgeAt = 0;

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

  /** What a nudge would be about, or null when nothing clears the bar. */
  pending(): string | null {
    const { ws } = this.d;
    if (ws.hasEvents()) return 'events';
    const open = ws.agenda.open();
    if (open.length) return 'agenda';
    if (ws.info.isNew && Object.keys(ws.map.nodes).length === 0) return 'empty';
    return null;
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
    lead.send('pulse', `the person has been quiet for ${Math.round(quiet / 1000)}s`);
    return 'pulse';
  }
}
