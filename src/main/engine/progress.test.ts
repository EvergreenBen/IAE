import { describe, expect, it } from 'vitest';
import { nextProgress, resumedProgress, todoReport } from './progress';

const T0 = 1_000_000;
const plan = ['Read the voice code', 'Add the picker', 'Wire playback', 'Test it'];

describe('a builder reporting progress', () => {
  it('starts the first step when it began work, so orienting counts towards it', () => {
    const p = nextProgress(undefined, { steps: plan }, T0 + 40_000, T0);
    expect(p).toEqual({ steps: plan, done: 0, spentMs: 0, stepAt: T0 });
  });

  it('books each finished step', () => {
    let p = nextProgress(undefined, { steps: plan }, T0 + 40_000, T0);
    p = nextProgress(p, { done: 1 }, T0 + 90_000, T0);
    expect(p).toMatchObject({ done: 1, spentMs: 90_000, stepAt: T0 + 90_000 });
    p = nextProgress(p, { done: 2 }, T0 + 150_000, T0);
    expect(p).toMatchObject({ done: 2, spentMs: 150_000, stepAt: T0 + 150_000 });
  });

  it('keeps the count when the plan is revised, and never books time twice', () => {
    let p = nextProgress(undefined, { steps: plan, done: 1 }, T0 + 60_000, T0);
    expect(p).toMatchObject({ done: 1, spentMs: 60_000 });
    p = nextProgress(p, { steps: [...plan, 'Update the docs'] }, T0 + 70_000, T0);
    expect(p).toMatchObject({ steps: [...plan, 'Update the docs'], done: 1, spentMs: 60_000, stepAt: T0 + 60_000 });
    p = nextProgress(p, { done: 1 }, T0 + 80_000, T0);
    expect(p).toMatchObject({ done: 1, spentMs: 60_000 });
  });

  it('ignores a report with nothing usable, and clamps the count', () => {
    expect(nextProgress(undefined, { done: 2 }, T0, T0)).toBeUndefined();
    expect(nextProgress(undefined, { steps: ['  ', ''] }, T0, T0)).toBeUndefined();
    expect(nextProgress(undefined, { steps: plan, done: 9 }, T0 + 5, T0)?.done).toBe(4);
  });

  it("reads Claude Code's todo list", () => {
    expect(
      todoReport({
        todos: [
          { content: 'Read the code', status: 'completed', activeForm: 'Reading the code' },
          { content: 'Add the picker', status: 'in_progress', activeForm: 'Adding the picker' },
          { content: 'Test it', status: 'pending', activeForm: 'Testing it' },
        ],
      }),
    ).toEqual({ steps: ['Read the code', 'Add the picker', 'Test it'], done: 1 });
    expect(todoReport({ todos: 'nope' })).toBeNull();
  });

  it("doesn't count the time the app was closed", () => {
    const saved = { steps: plan, done: 2, spentMs: 150_000, stepAt: T0 };
    expect(resumedProgress(saved, T0 + 3_600_000)).toEqual({ ...saved, stepAt: T0 + 3_600_000 });
    expect(resumedProgress(undefined, T0)).toBeUndefined();
  });
});
