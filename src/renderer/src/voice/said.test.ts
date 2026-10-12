// The caption keeps pace with the voice: words show as they are said.
import { describe, expect, it } from 'vitest';
import type { Said } from '../state/store';
import { wordsEnd } from '../conversation/captionText';
import { SaidTracker, wordCount, wordsSaid } from './said';

describe('wordsSaid', () => {
  const base: Said = { turnId: 't', before: 0, chunk: null, done: false };

  it('shows nothing until the voice starts, then spreads a chunk across its length', () => {
    expect(wordsSaid(base, 0)).toBe(0);
    const s: Said = { ...base, before: 3, chunk: { words: 10, at: 1000, ms: 2000 } };
    expect(wordsSaid(s, 850)).toBe(3);
    expect(wordsSaid(s, 1000)).toBe(4); // a little ahead, never behind
    expect(wordsSaid(s, 2000)).toBe(9);
    expect(wordsSaid(s, 5000)).toBe(13);
  });

  it('shows everything once the voice is done, and a skipped chunk at once', () => {
    expect(wordsSaid({ ...base, done: true }, 0)).toBe(Infinity);
    expect(wordsSaid({ ...base, chunk: { words: 5, at: 0, ms: 0 } }, 0)).toBe(5);
  });
});

describe('SaidTracker', () => {
  it('counts the words of each chunk as it starts, for the reply it belongs to', () => {
    const out: (Said | null)[] = [];
    const t = new SaidTracker((s) => out.push(s));
    t.begin('t1');
    t.started('t1', 4, 900, 10);
    t.started('t0', 7, 900, 20); // a stale reply's chunk
    t.started('t1', 6, 1200, 30);
    expect(out.at(-1)).toEqual({ turnId: 't1', before: 4, chunk: { words: 6, at: 30, ms: 1200 }, done: false });
    t.end();
    expect(out.at(-1)?.done).toBe(true);
    t.started('t1', 3, 500, 40); // after the end: nothing changes
    expect(out.at(-1)?.done).toBe(true);
  });
});

describe('wordsEnd', () => {
  it('finds where the first n words end', () => {
    const text = 'The jobs worker checks a jobs table. It claims the oldest job.';
    expect(text.slice(0, wordsEnd(text, 3))).toBe('The jobs worker');
    expect(text.slice(0, wordsEnd(text, 7))).toBe('The jobs worker checks a jobs table.');
    expect(wordsEnd(text, 0)).toBe(0);
    expect(wordsEnd(text, Infinity)).toBe(text.length);
    expect(wordCount(' The  jobs worker ')).toBe(3);
  });
});
