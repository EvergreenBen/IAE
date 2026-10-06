import { describe, expect, it } from 'vitest';
import { decidedBy } from './tools';

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
