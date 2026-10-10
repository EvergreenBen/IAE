// How far along a builder is and how long it has left, from the plan it
// reported (AgentProgress). The bar creeps within a step but never passes the
// step's end until the builder says it's done; the estimate comes from how
// long its finished steps took, so there is none until one has.

import type { AgentProgress } from '@shared/model';

export interface Estimate {
  /** 0..1, for the bar. */
  fraction: number;
  /** Time left, ms; null while there's nothing to go on. */
  leftMs: number | null;
}

/** A step's guessed length before any has finished: only moves the bar, never the estimate. */
const FIRST_STEP_MS = 90_000;
/** The step in hand never looks more than this far along. */
const IN_STEP_MAX = 0.85;

export function estimate(p: AgentProgress | undefined, now: number): Estimate {
  if (!p?.steps.length) return { fraction: 0, leftMs: null };
  const total = p.steps.length;
  const done = Math.min(p.done, total);
  if (done >= total) return { fraction: 1, leftMs: 0 };
  const inStep = Math.max(0, now - p.stepAt);
  const avg = done > 0 ? p.spentMs / done : FIRST_STEP_MS;
  const fraction = (done + Math.min(IN_STEP_MAX, inStep / avg)) / total;
  if (done === 0) return { fraction, leftMs: null };
  // The step in hand: what an average step has left, but never nothing (it isn't done yet).
  const current = Math.max(avg - inStep, avg * 0.15);
  return { fraction, leftMs: current + avg * (total - done - 1) };
}

/** "~4 min left", "<1 min left", "~1 h 20 min left". */
export function leftText(ms: number): string {
  if (ms < 60_000) return '<1 min left';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `~${min} min left`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `~${h} h${m ? ` ${m} min` : ''} left`;
}

/** "Step 2 of 5", for the line under a name. */
export function stepText(p: AgentProgress | undefined): string | null {
  if (!p?.steps.length) return null;
  const n = Math.min(p.done + 1, p.steps.length);
  return `Step ${n} of ${p.steps.length}`;
}
