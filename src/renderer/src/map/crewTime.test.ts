import { describe, expect, it } from 'vitest';
import { estimate, leftText, stepText } from './crewTime';

const plan = ['Read the code', 'Add the picker', 'Wire playback', 'Test it'];
const T = 1_000_000;

describe('how long a builder has left', () => {
  it('has nothing to go on before a plan', () => {
    expect(estimate(undefined, T)).toEqual({ fraction: 0, leftMs: null });
  });

  it('moves the bar through the first step but gives no estimate until a step finishes', () => {
    const e = estimate({ steps: plan, done: 0, spentMs: 0, stepAt: T }, T + 45_000);
    expect(e.leftMs).toBeNull();
    expect(e.fraction).toBeGreaterThan(0);
    expect(e.fraction).toBeLessThan(0.25);
  });

  it('estimates from how long the finished steps took', () => {
    // Two steps took 4 minutes: 2 min each, so two more take about 4 min.
    const e = estimate({ steps: plan, done: 2, spentMs: 240_000, stepAt: T }, T);
    expect(e.leftMs).toBe(240_000);
    expect(e.fraction).toBe(0.5);
    // A minute into the third step: about 3 min left, and the bar is past half.
    const later = estimate({ steps: plan, done: 2, spentMs: 240_000, stepAt: T }, T + 60_000);
    expect(later.leftMs).toBe(180_000);
    expect(later.fraction).toBeCloseTo(0.625);
  });

  it('never says a step is over before the builder does, nor the bar passes it', () => {
    const e = estimate({ steps: plan, done: 2, spentMs: 240_000, stepAt: T }, T + 600_000);
    expect(e.leftMs).toBe(18_000 + 120_000);
    expect(e.fraction).toBeLessThan(0.75);
  });

  it('is full and done when every step is', () => {
    expect(estimate({ steps: plan, done: 4, spentMs: 1, stepAt: T }, T)).toEqual({ fraction: 1, leftMs: 0 });
  });

  it('reads short and plain', () => {
    expect(leftText(20_000)).toBe('<1 min left');
    expect(leftText(4 * 60_000 + 10_000)).toBe('~4 min left');
    expect(leftText(80 * 60_000)).toBe('~1 h 20 min left');
    expect(leftText(120 * 60_000)).toBe('~2 h left');
    expect(stepText({ steps: plan, done: 1, spentMs: 0, stepAt: T })).toBe('Step 2 of 4');
    expect(stepText({ steps: plan, done: 4, spentMs: 0, stepAt: T })).toBe('Step 4 of 4');
  });
});
