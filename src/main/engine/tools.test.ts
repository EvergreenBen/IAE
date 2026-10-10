import { afterEach, describe, expect, it, vi } from 'vitest';
import { CameraWalk, decidedBy, END_HINT, FOCUS_STEP_MS, hinted, SAY_HINT } from './tools';

describe('decidedBy', () => {
  it('takes what the lead says about whose call it was', () => {
    expect(decidedBy('person', false)).toBe('person');
    expect(decidedBy(' Person ', false)).toBe('person');
    expect(decidedBy('me', true)).toBe('lead');
    expect(decidedBy('lead', true)).toBe('lead');
  });

  it("otherwise: the person's when they answered a question this turn, else the lead's own call", () => {
    expect(decidedBy(undefined, true)).toBe('person');
    expect(decidedBy(undefined, false)).toBe('lead');
    expect(decidedBy('both of us', false)).toBe('lead');
  });
});

describe('CameraWalk', () => {
  afterEach(() => vi.useRealTimers());
  const setup = () => {
    vi.useFakeTimers();
    let active = 0;
    const moves: string[] = [];
    const walk = new CameraWalk(
      (id) => moves.push(id ?? 'top'),
      (since) => active > since,
      () => Date.now(),
    );
    return { walk, moves, touch: () => (active = Date.now()) };
  };

  it('walks through one batch in order, a step at a time', () => {
    const { walk, moves } = setup();
    expect(walk.go('web', 'show')).toBe(0);
    expect(walk.go('api', 'show')).toBe(FOCUS_STEP_MS);
    expect(walk.go('jobs', 'show')).toBe(2 * FOCUS_STEP_MS);
    expect(moves).toEqual(['web']);
    vi.advanceTimersByTime(FOCUS_STEP_MS);
    expect(moves).toEqual(['web', 'api']);
    vi.advanceTimersByTime(FOCUS_STEP_MS);
    expect(moves).toEqual(['web', 'api', 'jobs']);
  });

  it('drops the rest of a walk when the person does something', () => {
    const { walk, moves, touch } = setup();
    walk.go('web', 'show');
    walk.go('api', 'show');
    vi.advanceTimersByTime(1000);
    touch();
    vi.advanceTimersByTime(FOCUS_STEP_MS);
    expect(moves).toEqual(['web']);
  });

  it('a later turn starts a new walk at once', () => {
    const { walk, moves } = setup();
    walk.go('web', 'show');
    walk.go('api', 'show');
    vi.advanceTimersByTime(2500);
    expect(walk.go('postgres', 'show')).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(moves).toEqual(['web', 'postgres']);
  });
});

describe('hinted', () => {
  it('tells the lead whether its words after the tools are heard', () => {
    expect(hinted('Camera on api.', true)).toBe(`Camera on api.${END_HINT}`);
    expect(hinted('Camera on api.', false)).toBe(`Camera on api.${SAY_HINT}`);
    expect(hinted('Camera on api.', undefined)).toBe('Camera on api.');
  });
});
