// How far the voice has got through the reply it is speaking, so the caption
// keeps pace with it: words appear as they are said, not seconds earlier as
// they stream in, and Archie's mouth never moves to words nobody hears yet.

import type { Said } from '../state/store';

/** Words show this much before they are heard, so the caption never lags the voice. */
const LEAD_MS = 120;

export const wordCount = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;

export class SaidTracker {
  private said: Said | null = null;

  constructor(private readonly publish: (said: Said | null) => void) {}

  /** The voice takes on a new reply: nothing of it has been said yet. */
  begin(turnId: string): void {
    this.set({ turnId, before: 0, chunk: null, done: false });
  }

  /** A chunk of `turnId` started playing (`ms` long; 0 when it was skipped). */
  started(turnId: string | null, words: number, ms: number, now = performance.now()): void {
    const s = this.said;
    if (!s || s.done || s.turnId !== turnId) return;
    this.set({ ...s, before: s.before + (s.chunk?.words ?? 0), chunk: { words, at: now, ms } });
  }

  /** The voice is finished with the reply: the caption shows all of it. */
  end(): void {
    if (this.said && !this.said.done) this.set({ ...this.said, done: true });
  }

  private set(s: Said): void {
    this.said = s;
    this.publish(s);
  }
}

/** How many of the reply's words have been said by `now`, spread evenly across the chunk being spoken. Infinity once done. Pure. */
export function wordsSaid(s: Said, now: number): number {
  if (s.done) return Infinity;
  if (!s.chunk) return s.before;
  const { words, at, ms } = s.chunk;
  const part = ms <= 0 ? words : Math.ceil((words * (now - at + LEAD_MS)) / ms);
  return s.before + Math.max(0, Math.min(words, part));
}
