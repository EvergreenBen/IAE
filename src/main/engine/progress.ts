// A builder's progress: the plan it reported (Arxitect's `progress` tool, or
// Claude Code's own todo list) and how far through it is. The time each
// finished step took is kept, so the window can estimate what's left.

import type { AgentProgress } from '../../shared/model';

export interface ProgressReport {
  /** The whole plan, when it is (re)stated. */
  steps?: string[];
  /** How many steps are finished. */
  done?: number;
}

const MAX_STEPS = 12;

const clean = (steps: unknown[]): string[] =>
  steps
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((x) => (x.length > 70 ? `${x.slice(0, 69)}…` : x))
    .slice(0, MAX_STEPS);

/**
 * Folds a report into the progress so far. Orienting before the plan counts
 * towards its first step; a step's time is booked when the count goes up.
 * Returns the previous progress (or undefined) when the report says nothing usable.
 */
export function nextProgress(prev: AgentProgress | undefined, report: ProgressReport, now: number, startedAt: number): AgentProgress | undefined {
  const steps = Array.isArray(report.steps) ? clean(report.steps) : [];
  const plan = steps.length ? steps : prev?.steps;
  if (!plan?.length) return prev;
  const asked = typeof report.done === 'number' && Number.isFinite(report.done) ? Math.round(report.done) : (prev?.done ?? 0);
  const done = Math.max(0, Math.min(plan.length, asked));
  if (!prev) {
    return done > 0 ? { steps: plan, done, spentMs: Math.max(0, now - startedAt), stepAt: now } : { steps: plan, done, spentMs: 0, stepAt: startedAt };
  }
  if (done > prev.done) return { steps: plan, done, spentMs: prev.spentMs + Math.max(0, now - prev.stepAt), stepAt: now };
  return { ...prev, steps: plan, done };
}

/** Claude Code's TodoWrite input as a report: every todo is a step, the completed ones are done. */
export function todoReport(input: Record<string, unknown>): ProgressReport | null {
  if (!Array.isArray(input.todos)) return null;
  const todos = input.todos.filter((t): t is { content: string; status?: string } => !!t && typeof t === 'object' && typeof (t as { content?: unknown }).content === 'string');
  if (!todos.length) return null;
  return { steps: todos.map((t) => t.content), done: todos.filter((t) => t.status === 'completed').length };
}

/** After a restart the time the app was closed doesn't count: the step in hand starts again now. */
export function resumedProgress(p: AgentProgress | undefined, now: number): AgentProgress | undefined {
  if (!p || !Array.isArray(p.steps) || !p.steps.length) return undefined;
  const done = Math.max(0, Math.min(p.steps.length, Number(p.done) || 0));
  return { steps: clean(p.steps), done, spentMs: Math.max(0, Number(p.spentMs) || 0), stepAt: now };
}
