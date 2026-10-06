import { describe, expect, it } from 'vitest';
import type { Anchor } from './anchors';
import { overlaps, type Rect, type View } from './geometry';
import { anchorPoint, cardRect, place, type PlaceInput, type Placement } from './questionPlace';

// The camera's safe area (camera.ts SAFE): clear of the chrome (top 60) and the
// conversation zone (bottom 168), 16px from the sides.
const safeWorld = (w: number, h: number, v: View): Rect => ({ x: (16 - v.x) / v.k, y: (60 - v.y) / v.k, w: (w - 32) / v.k, h: (h - 60 - 168) / v.k });
const ovOf = (k: number) => Math.min(1.2, Math.max(0.8, k)) / k;
/** Screen rect → world under view v. */
const world = (r: Rect, v: View): Rect => ({ x: (r.x - v.x) / v.k, y: (r.y - v.y) / v.k, w: r.w / v.k, h: r.h / v.k });

interface Scene {
  nodes: Record<string, Rect>;
  edges: [string, string][];
}

/** Straight-ish orthogonal edge (right side of a → left side of b) as thin rects, like Questions.segmentRects. */
function edgeRects(a: Rect, b: Rect): Rect[] {
  const p = { x: a.x + a.w, y: a.y + a.h / 2 };
  const q = { x: b.x, y: b.y + b.h / 2 };
  const mx = (p.x + q.x) / 2;
  const pts = [p, { x: mx, y: p.y }, { x: mx, y: q.y }, q];
  const out: Rect[] = [];
  for (let i = 1; i < pts.length; i++) {
    const s = pts[i - 1];
    const t = pts[i];
    out.push({ x: Math.min(s.x, t.x) - 3, y: Math.min(s.y, t.y) - 3, w: Math.abs(s.x - t.x) + 6, h: Math.abs(s.y - t.y) + 6 });
  }
  return out;
}

function input(scene: Scene, id: string, screen: { w: number; h: number }, v: View, extra: Partial<PlaceInput> = {}): PlaceInput {
  const nodes = Object.fromEntries(Object.entries(scene.nodes).map(([k, r]) => [k, world(r, v)]));
  const at: Anchor = { id, rect: nodes[id], frame: false };
  return {
    at,
    nodes: Object.entries(nodes)
      .filter(([k]) => k !== id)
      .map(([, r]) => r),
    soft: [],
    lines: scene.edges.flatMap(([a, b]) => edgeRects(nodes[a], nodes[b])),
    safe: safeWorld(screen.w, screen.h, v),
    canPan: false,
    ov: ovOf(v.k),
    h: 250,
    hCompact: 150,
    marginX: null,
    marginL: null,
    keep: null,
    ports: { left: [], right: [] },
    ...extra,
  };
}

/** What a placement breaks: nodes covered (incl. its own), leader through a node, outside the safe area. */
function problems(inp: PlaceInput, p: Placement): string[] {
  const h = p.compact ? (inp.hCompact ?? inp.h) : inp.h;
  const card = cardRect(inp.at, p, inp.ov, h);
  const out: string[] = [];
  for (const n of [...inp.nodes, inp.at.rect]) if (overlaps(card, n)) out.push(`covers node at ${Math.round(n.x)},${Math.round(n.y)}`);
  const a = anchorPoint(inp.at, p.side, p.dy, p.dx);
  const len = p.lead * inp.ov;
  const lead: Rect =
    p.side === 'right' ? { x: a.x + 2, y: a.y, w: len - 2, h: 1 } : p.side === 'left' ? { x: a.x - len, y: a.y, w: len - 2, h: 1 } : p.side === 'below' ? { x: a.x, y: a.y + 2, w: 1, h: len - 2 } : { x: a.x, y: a.y - len, w: 1, h: len - 2 };
  for (const n of inp.nodes) if (overlaps(lead, n)) out.push('leader crosses a node');
  const s = inp.safe!;
  const t = 3 * inp.ov + 0.01;
  if (!inp.canPan && (card.x < s.x - t || card.y < s.y - t || card.x + card.w > s.x + s.w + t || card.y + card.h > s.y + s.h + t)) out.push('outside the safe area');
  return out;
}

const crossesEdge = (inp: PlaceInput, p: Placement) => {
  const card = cardRect(inp.at, p, inp.ov, p.compact ? (inp.hCompact ?? inp.h) : inp.h);
  return inp.lines.some((l) => overlaps(card, l));
};

// Group trips at the top level, laid out left → right: nodes in a row at y≈300–500 (screen px, 1440×900).
const TRIPS: Scene = {
  nodes: {
    group: { x: 70, y: 372, w: 200, h: 72 },
    trips: { x: 350, y: 300, w: 236, h: 120 },
    auth: { x: 350, y: 456, w: 200, h: 72 },
    postgres: { x: 666, y: 318, w: 200, h: 72 },
    maps: { x: 666, y: 430, w: 200, h: 72 },
    places: { x: 946, y: 372, w: 200, h: 72 },
    push: { x: 1190, y: 330, w: 200, h: 72 },
  },
  edges: [
    ['group', 'trips'],
    ['group', 'auth'],
    ['trips', 'postgres'],
    ['trips', 'maps'],
    ['auth', 'postgres'],
    ['maps', 'places'],
    ['places', 'push'],
  ],
};

const ID: View = { k: 1, x: 0, y: 0 };

describe('question card placement', () => {
  for (const id of Object.keys(TRIPS.nodes)) {
    it(`never covers a node: card on ${id}, 1440×900, after the one pan is spent`, () => {
      const inp = input(TRIPS, id, { w: 1440, h: 900 }, ID);
      const p = place(inp);
      // Either a clean spot, or the dot stands in. Never a card over the map.
      if (p) expect(problems(inp, p)).toEqual([]);
    });
    it(`never covers a node: card on ${id}, 1440×900, camera may still pan`, () => {
      const inp = input(TRIPS, id, { w: 1440, h: 900 }, ID, { canPan: true });
      const p = place(inp);
      expect(p).not.toBeNull();
      expect(problems(inp, p!)).toEqual([]);
      // A pan can bring the card and its node into view together.
      const card = cardRect(inp.at, p!, inp.ov, p!.compact ? 150 : 250);
      const u = { y0: Math.min(card.y, inp.at.rect.y), y1: Math.max(card.y + card.h, inp.at.rect.y + inp.at.rect.h) };
      expect(u.y1 - u.y0).toBeLessThanOrEqual(inp.safe!.h);
    });
  }

  it('finds room for the Trips API card without covering Group App or Postgres', () => {
    const inp = input(TRIPS, 'trips', { w: 1440, h: 900 }, ID);
    const p = place(inp);
    expect(p).not.toBeNull();
    expect(problems(inp, p!)).toEqual([]);
  });

  it('at 1024×700 after ⌘0 (zoomed out to fit), still never covers a node', () => {
    // The same map fitted into a smaller window: k ≈ 0.68, so the overlay counter-scales the card (ov > 1).
    const v: View = { k: 0.68, x: 30, y: 128 };
    const scene: Scene = { ...TRIPS, nodes: Object.fromEntries(Object.entries(TRIPS.nodes).map(([k, r]) => [k, { x: r.x * 0.68 + 30, y: r.y * 0.68 + 128 - 80, w: r.w * 0.68, h: r.h * 0.68 }])) };
    let shown = 0;
    for (const id of Object.keys(scene.nodes)) {
      const inp = input(scene, id, { w: 1024, h: 700 }, v);
      const p = place(inp);
      if (p) {
        shown++;
        expect(problems(inp, p)).toEqual([]);
      }
    }
    expect(shown).toBeGreaterThan(0);
  });

  it('recipe box: the card on API keeps off Web App and the Web → API edge', () => {
    const scene: Scene = {
      nodes: {
        web: { x: 48, y: 262, w: 186, h: 94 },
        assistant: { x: 300, y: 344, w: 158, h: 56 },
        api: { x: 527, y: 278, w: 186, h: 94 },
        jobs: { x: 952, y: 342, w: 186, h: 94 },
        data: { x: 1206, y: 302, w: 186, h: 94 },
        google: { x: 1206, y: 212, w: 158, h: 56 },
        resend: { x: 1206, y: 428, w: 158, h: 56 },
      },
      edges: [
        ['web', 'api'],
        ['assistant', 'api'],
        ['api', 'jobs'],
        ['api', 'data'],
        ['api', 'google'],
        ['jobs', 'data'],
        ['jobs', 'resend'],
      ],
    };
    const inp = input(scene, 'api', { w: 1440, h: 900 }, ID);
    const p = place(inp);
    expect(p).not.toBeNull();
    expect(problems(inp, p!)).toEqual([]);
    expect(crossesEdge(inp, p!)).toBe(false);
    // A card on Web App mustn't sit over the edge it sends to API either.
    const w = input(scene, 'web', { w: 1440, h: 900 }, ID);
    const pw = place(w);
    expect(pw).not.toBeNull();
    expect(problems(w, pw!)).toEqual([]);
    expect(crossesEdge(w, pw!)).toBe(false);
  });

  it('prefers a spot clear of edges over a shorter leader across one', () => {
    // An edge runs right from the node; the right side would cover it, below is clear.
    const scene: Scene = { nodes: { a: { x: 300, y: 200, w: 200, h: 72 }, b: { x: 1100, y: 200, w: 200, h: 72 } }, edges: [['a', 'b']] };
    const inp = input(scene, 'a', { w: 1440, h: 900 }, ID, { h: 180 });
    const p = place(inp)!;
    expect(problems(inp, p)).toEqual([]);
    expect(crossesEdge(inp, p)).toBe(false);
  });

  it('falls back to the compact card when the full one has no room', () => {
    // A tight band: rows of nodes above and below leave ~190px of free height.
    const nodes: Record<string, Rect> = {};
    for (let i = 0; i < 6; i++) {
      nodes[`top${i}`] = { x: 40 + i * 236, y: 70, w: 200, h: 72 };
      nodes[`bot${i}`] = { x: 40 + i * 236, y: 520, w: 200, h: 72 };
    }
    nodes.mid = { x: 40, y: 300, w: 200, h: 72 };
    const inp = input({ nodes, edges: [] }, 'mid', { w: 1440, h: 900 }, ID, { h: 400, hCompact: 150 });
    const p = place(inp);
    expect(p).not.toBeNull();
    expect(p!.compact).toBe(true);
    expect(problems(inp, p!)).toEqual([]);
  });

  it('shows the dot when nothing fits, and the least-bad card when asked', () => {
    // A dense grid: no free gap anywhere big enough for even the compact card.
    const nodes: Record<string, Rect> = {};
    for (let r = 0; r < 6; r++) for (let c = 0; c < 7; c++) nodes[`n${r}-${c}`] = { x: 20 + c * 204, y: 64 + r * 112, w: 196, h: 104 };
    const inp = input({ nodes, edges: [] }, 'n2-3', { w: 1440, h: 900 }, ID);
    expect(place(inp)).toBeNull();
    expect(place({ ...inp, force: true })).not.toBeNull();
  });

  it('keeps the safe area once the pan is spent; may lean on the pan before', () => {
    // A node low on screen with nothing around it: below it is under the conversation zone.
    const scene: Scene = { nodes: { a: { x: 600, y: 600, w: 200, h: 72 } }, edges: [] };
    const strict = input(scene, 'a', { w: 1440, h: 900 }, ID);
    const p = place(strict)!;
    expect(problems(strict, p)).toEqual([]);
    const card = cardRect(strict.at, p, 1, p.compact ? 150 : 250);
    expect(card.y + card.h).toBeLessThanOrEqual(strict.safe!.y + strict.safe!.h + 3);
  });

  it('stays where it is while that spot is still fine', () => {
    const inp = input(TRIPS, 'trips', { w: 1440, h: 900 }, ID);
    const p = place(inp)!;
    const again = place({ ...inp, keep: p })!;
    expect(again.side).toBe(p.side);
    expect(again.lead).toBe(p.lead);
  });
});
