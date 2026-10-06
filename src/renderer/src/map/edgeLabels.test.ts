import { describe, expect, it } from 'vitest';
import { labelTiers } from './edgeLabels';

const pill = (id: string, x: number, y: number, w = 80) => ({ id, x, y, w, h: 20 });

describe('edge label tiers', () => {
  it('keeps well-spaced labels at the near tier', () => {
    const t = labelTiers([pill('a', 0, 0), pill('b', 0, 80), pill('c', 300, 10)]);
    expect([...t.values()]).toEqual(['near', 'near', 'near']);
  });

  it('thins a stacked channel: every other label waits for a closer zoom', () => {
    const t = labelTiers([pill('a', 0, 0), pill('b', 0, 40), pill('c', 0, 80), pill('d', 0, 120)]);
    expect(Object.fromEntries(t)).toEqual({ a: 'near', b: 'close', c: 'near', d: 'close' });
  });

  it('labels that would touch even up close show only on hover', () => {
    const t = labelTiers([pill('a', 0, 0), pill('b', 10, 12)]);
    expect(t.get('b')).toBe('hover');
  });

  it('earlier labels win', () => {
    const t = labelTiers([pill('late', 0, 40), pill('a', 0, 0)]);
    expect(t.get('late')).toBe('near');
    expect(t.get('a')).toBe('close');
  });
});
