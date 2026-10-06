import { describe, expect, it } from 'vitest';
import { lingerMs, sentenceStarts, tokens, wordStarts } from './captionText';

describe('caption text', () => {
  it('finds sentence starts', () => {
    const t = "I've sketched a web app. Is mobile enough? Or native — “really”? Yes.";
    const s = sentenceStarts(t);
    expect(s.map((i) => t.slice(i, i + 3))).toEqual(["I'v", 'Is ', 'Or ', 'Yes']);
  });

  it('does not split inside names like Node.js or a trailing period', () => {
    expect(sentenceStarts('Hono on Node.js talks to Postgres.')).toEqual([0]);
  });

  it('keeps token offsets stable', () => {
    const t = 'One two.  Three';
    const words = tokens(t).filter((x) => !x.space);
    expect(words.map((w) => [w.text, w.at])).toEqual([
      ['One', 0],
      ['two.', 4],
      ['Three', 10],
    ]);
    expect(tokens(t).map((x) => x.text).join('')).toBe(t);
  });

  it('lists word starts from an offset', () => {
    expect(wordStarts('a bb ccc', 2)).toEqual([2, 5]);
  });

  it('lingers longer for longer replies, within bounds', () => {
    expect(lingerMs('Short.')).toBe(6000);
    expect(lingerMs(Array(30).fill('word').join(' '))).toBe(7800);
    expect(lingerMs(Array(200).fill('word').join(' '))).toBe(12_000);
  });
});
