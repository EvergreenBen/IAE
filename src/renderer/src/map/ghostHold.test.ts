import { describe, expect, it } from 'vitest';
import type { GhostProposal } from '@shared/model';
import { holdGhosts, MAX_GHOSTS, MIN_SHOW_MS, type Held } from './ghostHold';

const g = (label: string, confidence = 0.7): GhostProposal => ({ key: label.toLowerCase().replace(/\s+/g, '-'), label, kind: 'module', confidence, source: 'sketch' });
const keys = (gs: GhostProposal[]) => gs.map((x) => x.label);
const never = () => false;

/** Run a sequence of frames through the hold, carrying its state like Ghosts.tsx does. */
function run(frames: { at: number; in: GhostProposal[]; real?: string[] }[]) {
  let held = new Map<string, Held>();
  return frames.map((f) => {
    const r = holdGhosts(held, f.in, f.at, (k) => (f.real ?? []).includes(k));
    held = r.held;
    return r;
  });
}

describe('ghost hold', () => {
  it('keeps a ghost at least a moment once shown (no flash while a word is half typed)', () => {
    const [, a, b] = run([
      { at: 0, in: [g('CLI')] },
      { at: 300, in: [] },
      { at: MIN_SHOW_MS + 10, in: [] },
    ]);
    expect(keys(a.shown)).toEqual(['CLI']);
    expect(a.wakeIn).toBe(MIN_SHOW_MS - 300);
    expect(keys(b.shown)).toEqual([]);
  });

  it('lets a ghost go at once when it became the real node', () => {
    const [, a] = run([
      { at: 0, in: [g('Polls')] },
      { at: 200, in: [], real: ['polls'] },
    ]);
    expect(a.shown).toEqual([]);
  });

  it('accumulates and caps at the most confident few', () => {
    const many = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((l, i) => g(`Idea ${l}`, 0.5 + i * 0.05));
    const [r] = run([{ at: 0, in: many }]);
    expect(r.shown).toHaveLength(MAX_GHOSTS);
    expect(keys(r.shown)).not.toContain('Idea A');
    expect(keys(r.shown)).not.toContain('Idea B');
  });

  it('a newer, likelier idea bumps the least likely one only after it has had its moment', () => {
    const six = ['A', 'B', 'C', 'D', 'E', 'F'].map((l) => g(`Idea ${l}`, 0.7));
    const low = g('Idea Low', 0.5);
    const [, early, late] = run([
      { at: 0, in: [...six.slice(0, 5), low] },
      { at: 400, in: [...six.slice(0, 5), low, six[5]] },
      { at: 2000, in: [...six.slice(0, 5), low, six[5]] },
    ]);
    // Low is still young at 400ms: it stays, so for a moment there are seven.
    expect(keys(early.shown)).toContain('Idea Low');
    expect(keys(late.shown)).not.toContain('Idea Low');
    expect(late.shown).toHaveLength(MAX_GHOSTS);
  });

  it('a ghost replaced by the same idea in other words hands over its spot', () => {
    const [, r] = run([
      { at: 0, in: [g('Payments')] },
      { at: 300, in: [g('Stripe Billing')] },
    ]);
    expect(keys(r.shown)).toEqual(['Stripe Billing']);
    expect(r.inherit.get('stripe-billing')).toBe('payments');
  });

  it('remembers when each ghost first showed', () => {
    const [, r] = run([
      { at: 0, in: [g('Polls')] },
      { at: 500, in: [g('Polls'), g('Maps')] },
    ]);
    expect(r.held.get('polls')!.since).toBe(0);
    expect(r.held.get('maps')!.since).toBe(500);
    expect(holdGhosts(new Map(), [], 0, never).shown).toEqual([]);
  });
});
