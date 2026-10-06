import { describe, expect, it } from 'vitest';
import { composed, labelPoint, mappingInto, roundedPath, simplify, viewToInner, viewToParent } from './geometry';

describe('scope mappings', () => {
  it('places an inner rect centred and uniformly scaled inside an outer one', () => {
    const m = mappingInto({ x: 0, y: 0, w: 1000, h: 500 }, { x: 100, y: 100, w: 200, h: 200 }, 1);
    expect(m.s).toBeCloseTo(0.2);
    // inner centre (500,250) lands on the outer centre (200,200)
    expect(500 * m.s + m.mx).toBeCloseTo(200);
    expect(250 * m.s + m.my).toBeCloseTo(200);
  });

  it('rebasing keeps every point where it was on screen', () => {
    const m = { s: 0.25, mx: 40, my: -12 };
    const parent = { k: 3, x: -120, y: 60 };
    const inner = viewToInner(parent, m);
    const c = { x: 333, y: -77 };
    const viaParent = { x: (c.x * m.s + m.mx) * parent.k + parent.x, y: (c.y * m.s + m.my) * parent.k + parent.y };
    expect(c.x * inner.k + inner.x).toBeCloseTo(viaParent.x);
    expect(c.y * inner.k + inner.y).toBeCloseTo(viaParent.y);
    const back = viewToParent(inner, m);
    expect(back.k).toBeCloseTo(parent.k);
    expect(back.x).toBeCloseTo(parent.x);
    expect(back.y).toBeCloseTo(parent.y);
    expect(composed(parent, m)).toEqual(inner);
  });
});

describe('edge paths', () => {
  it('drops collinear points and rounds only real corners', () => {
    const pts = simplify([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 40 },
      { x: 50, y: 40 },
      { x: 90, y: 40 },
    ]);
    expect(pts).toEqual([
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 40 },
      { x: 90, y: 40 },
    ]);
    const d = roundedPath(pts, 10);
    expect(d.startsWith('M0,0')).toBe(true);
    expect(d.match(/Q/g)?.length).toBe(2);
    expect(d.endsWith('L90,40')).toBe(true);
  });

  it('labels sit on the longest run', () => {
    expect(labelPoint([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 100 }])).toEqual({ x: 10, y: 50 });
  });
});
