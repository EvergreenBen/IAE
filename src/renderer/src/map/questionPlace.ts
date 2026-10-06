// Where a question card goes: the free side of its node, kept inside the safe
// area (never over the chrome or the conversation at the bottom). Pure, so it
// can be tested. Units: world px for rects; "card px" for the card's own
// geometry, which the overlay counter-scales by `ov` (world px per card px).
//
// Hard rules: a card never covers another node (or its own), its leader never
// runs through one, and once the camera can't make room it stays inside the
// safe area. Within those, it prefers the right side, a short leader, and
// keeping clear of edges (strongly) and labels. When the full card has no room
// a compact one (narrower, options inline, `why` folded away) is tried; when
// even that has none, place() returns null and the card's accent dot stands in
// (clicking it asks again with `force`).
import type { Anchor } from './anchors';
import { overlaps, type Rect } from './geometry';
import { CAPTION, QUESTION_CARD_W, withCaption } from './layoutTypes';

export const CARD_W = QUESTION_CARD_W;
/** The compact card, for tight spots. */
export const COMPACT_W = 248;
export const LEADER = 30;
/** Side cards: the leader meets the card this far below its top (card px). */
export const HEAD = 24;
/** Below/above cards: the leader meets the card this far in from its right edge, at no slide (card px). */
export const NOTCH = 28;

export type Side = 'right' | 'left' | 'below' | 'above';

export interface Placement {
  side: Side;
  /** Leader length, card px. */
  lead: number;
  /** Where the leader leaves the node, world px below its top (side placements). */
  dy: number;
  /** How far the card slides along its side to stay in view, card px (up for side cards, right for below/above). */
  slide: number;
  /** Below/above: where the leader leaves the node, world px from its left (default: near the right corner). */
  dx?: number;
  /** The compact layout (narrower, options inline, `why` folded away). */
  compact?: boolean;
}

export interface PlaceInput {
  at: Anchor;
  /** Hard obstacles: other nodes, file tiles and shelf chips. */
  nodes: Rect[];
  /** Soft obstacles: stubs, edge labels, a frame's title row. */
  soft: Rect[];
  /** Edge segments (thin rects): a card shouldn't hide the wiring it's about. */
  lines: Rect[];
  /** Safe area in world px (null when unknown). */
  safe: Rect | null;
  /**
   * The camera may still ease to make room for this card (once, when the user
   * isn't steering): then a card may sit partly outside the safe area as long
   * as a pan can bring it and its node into view. Otherwise the safe area is a
   * hard rule.
   */
  canPan: boolean;
  ov: number;
  /** Card height, card px (measured, or estimated before the first measure). */
  h: number;
  /** Compact card height, card px (measured or estimated). Defaults to `h`. */
  hCompact?: number;
  /** A framed scope's right margin (world x), where a crowded card can go. */
  marginX: number | null;
  /** A framed scope's left margin (world x, right edge of the free area), for a card about the scope itself. */
  marginL: number | null;
  keep: Placement | null;
  /** Where edges meet the node on each side (world y), so the leader avoids them. */
  ports: { left: number[]; right: number[] };
  /** The user asked to see this card: never return null, take the least-bad spot. */
  force?: boolean;
}

const area = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
const grow = (r: Rect, d: number): Rect => ({ x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d });

export const cardW = (p: Pick<Placement, 'compact'>) => (p.compact ? COMPACT_W : CARD_W);

/** Where the leader leaves the anchor (world). */
export function anchorPoint(at: Anchor, side: Side, dy: number, dx?: number): { x: number; y: number } {
  const r = at.rect;
  if (at.frame) {
    const px = r.x + (dx ?? r.w - 40);
    if (side === 'right') return { x: r.x + r.w, y: r.y + dy };
    if (side === 'left') return { x: r.x, y: r.y + dy };
    if (side === 'below') return { x: px, y: r.y + 64 };
    return { x: px, y: r.y };
  }
  // A node is a disc, so the leader leaves from the rim rather than from the
  // corner of a bounding box — and below, from under the caption, so it never
  // crosses the node's own words on its way to the card.
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const rad = r.w / 2;
  if (side === 'right' || side === 'left') {
    const y = r.y + dy;
    const half = halfChord(rad, y - cy);
    return { x: side === 'right' ? cx + half : cx - half, y };
  }
  const x = dx === undefined ? cx : r.x + dx;
  const half = halfChord(rad, x - cx);
  return side === 'below' ? { x, y: cy + half + CAPTION.h } : { x, y: cy - half };
}

/** Half the chord of a circle of radius `rad` at distance `d` from its centre. */
const halfChord = (rad: number, d: number) => Math.sqrt(Math.max(0, rad * rad - d * d));

/** The card's rect in world px. Mirrors the inline styles in Questions.tsx. */
export function cardRect(at: Anchor, p: Placement, ov: number, h: number): Rect {
  const a = anchorPoint(at, p.side, p.dy, p.dx);
  const W = cardW(p);
  const w = W * ov;
  const hh = h * ov;
  if (p.side === 'right') return { x: a.x + p.lead * ov, y: a.y - (HEAD + p.slide) * ov, w, h: hh };
  if (p.side === 'left') return { x: a.x - (p.lead + W) * ov, y: a.y - (HEAD + p.slide) * ov, w, h: hh };
  const x = a.x + (NOTCH - W + p.slide) * ov;
  if (p.side === 'below') return { x, y: a.y + p.lead * ov, w, h: hh };
  return { x, y: a.y - (p.lead + h) * ov, w, h: hh };
}

/** The leader as a thin rect (world), from the node to the card. */
function leaderRect(at: Anchor, p: Placement, ov: number): Rect {
  const a = anchorPoint(at, p.side, p.dy, p.dx);
  const len = p.lead * ov;
  if (p.side === 'right') return { x: a.x + 2, y: a.y - 2, w: Math.max(0, len - 2), h: 4 };
  if (p.side === 'left') return { x: a.x - len, y: a.y - 2, w: Math.max(0, len - 2), h: 4 };
  if (p.side === 'below') return { x: a.x - 2, y: a.y + 2, w: 4, h: Math.max(0, len - 2) };
  return { x: a.x - 2, y: a.y - len, w: 4, h: Math.max(0, len - 2) };
}

/** Range the slide may take so the leader still meets the card's edge. */
function slideRange(side: Side, h: number, W: number): [number, number] {
  return side === 'right' || side === 'left' ? [0, Math.max(0, h - HEAD - 22)] : [-8, W - NOTCH - 22];
}

function steps(lo: number, hi: number, n: number): number[] {
  if (hi <= lo) return [lo];
  const out = new Set<number>();
  for (let i = 0; i <= n; i++) out.add(Math.round(lo + ((hi - lo) * i) / n));
  return [...out];
}

/** A leader height that doesn't run along an edge or through a pill on its way out. */
function leaderDy(at: Anchor, side: Side, lead: number, ov: number, ports: number[], pills: Rect[]): number {
  const r = at.rect;
  if (side !== 'right' && side !== 'left') return 26;
  const len = lead * ov;
  const x0 = side === 'right' ? r.x + r.w : r.x - len;
  const x1 = side === 'right' ? r.x + r.w + len : r.x;
  const crossing = pills.filter((p) => p.x < x1 && p.x + p.w > x0);
  let best = 26;
  let bestPen = Infinity;
  for (let dy = 18; dy <= r.h - 14; dy += 4) {
    const y = r.y + dy;
    let pen = Math.abs(dy - 26) * 0.5;
    // Never run alongside an edge leaving the same side: it would read as one more edge.
    for (const py of ports) if (Math.abs(py - y) < 16) pen += (16 - Math.abs(py - y)) * 20;
    for (const p of crossing) if (y > p.y - 6 && y < p.y + p.h + 6) pen += 400;
    if (pen < bestPen) {
      bestPen = pen;
      best = dy;
    }
  }
  return best;
}

interface Cand {
  side: Side;
  lead: number;
  pref: number;
}

/** Leader lengths tried on each side (card px): short first, long when the neighbourhood is crowded. */
const SIDE_LEADS = [LEADER, LEADER + 26, LEADER + 56, LEADER + 100, LEADER + 160, LEADER + 230];
const VERT_LEADS = [LEADER + 12, LEADER + 40, LEADER + 80, LEADER + 130];

function candidates(input: PlaceInput): Cand[] {
  const { at, ov, marginX, marginL } = input;
  const r = at.rect;
  if (at.frame) {
    // A card about the scope itself sits outside its frame (clear of the stubs), never over its children.
    const frameLead = (gap: number | null) => Math.max(LEADER, gap === null ? LEADER : gap / ov);
    const right = frameLead(marginX === null ? null : marginX - (r.x + r.w));
    const left = frameLead(marginL === null ? null : r.x - marginL);
    return [
      ...[0, 40, 100].map((d, i) => ({ side: 'right' as const, lead: right + d, pref: i * 400 })),
      ...[0, 40, 100].map((d, i) => ({ side: 'left' as const, lead: left + d, pref: 1500 + i * 400 })),
      { side: 'above', lead: LEADER, pref: 3000 },
      { side: 'below', lead: LEADER, pref: 6000 },
    ];
  }
  const out: Cand[] = [];
  SIDE_LEADS.forEach((lead, i) => {
    out.push({ side: 'right', lead, pref: i * 450 });
    out.push({ side: 'left', lead, pref: 1900 + i * 450 });
  });
  VERT_LEADS.forEach((lead, i) => {
    out.push({ side: 'below', lead, pref: 900 + i * 500 });
    out.push({ side: 'above', lead, pref: 2800 + i * 500 });
  });
  if (marginX !== null && marginX > r.x + r.w + LEADER * ov) out.push({ side: 'right', lead: (marginX - (r.x + r.w)) / ov, pref: 2400 });
  return out;
}

/** Every concrete placement for one candidate side and leader. */
function variants(input: PlaceInput, c: Cand, compact: boolean, h: number): Placement[] {
  const { at, ov, ports, soft } = input;
  const W = compact ? COMPACT_W : CARD_W;
  const [lo, hi] = slideRange(c.side, h, W);
  const out: Placement[] = [];
  if (c.side === 'right' || c.side === 'left') {
    const dy = leaderDy(at, c.side, c.lead, ov, c.side === 'left' ? ports.left : ports.right, soft);
    for (const slide of steps(lo, hi, 12)) out.push({ side: c.side, lead: c.lead, dy, slide, ...(compact ? { compact } : {}) });
    return out;
  }
  const r = at.rect;
  // Below/above: the leader can leave anywhere along the node (near its right corner by default).
  const dxs = at.frame ? [undefined] : [undefined, r.w / 2, NOTCH];
  for (const dx of dxs) for (const slide of steps(lo, hi, 10)) out.push({ side: c.side, lead: c.lead, dy: 26, slide, ...(dx !== undefined ? { dx } : {}), ...(compact ? { compact } : {}) });
  return out;
}

/** Hard-rule violations (0 = allowed) and the soft cost of one placement. */
function judge(input: PlaceInput, p: Placement, pref: number, h: number): { bad: number; cost: number } {
  const { at, nodes, soft, lines, safe, ov, canPan } = input;
  const card = cardRect(at, p, ov, h);
  const lead = leaderRect(at, p, ov);
  let bad = 0;
  let cost = pref + Math.abs(p.slide) * ov * 1.5 + p.lead * ov * 2;
  if (p.dx !== undefined) cost += 300;
  if (p.compact) cost += 40_000;
  const gap = 6 * ov;
  // Its own node counts as an obstacle including the caption under the disc —
  // the leader still points at the disc, but the card must clear the words.
  const own = at.frame ? [] : [withCaption(at.rect)];
  for (const n of [...nodes, ...own]) {
    if (overlaps(card, n, gap)) bad += area(grow(card, gap), n) + 100;
    else cost += area(grow(card, 18 * ov), n) * 2; // a little breathing room
  }
  for (const n of nodes) if (overlaps(lead, n)) bad += area(lead, n) + 50;
  for (const s of soft) cost += area(grow(card, 6 * ov), s) * 8;
  // Edges: strongly avoided (the card would hide the wiring it's about), but not forbidden.
  for (const l of lines) {
    cost += area(grow(card, 4 * ov), l) * 40;
    cost += area(lead, l) * 2;
  }
  if (safe) {
    const out = card.w * card.h - area(card, safe);
    if (canPan) {
      // The camera will ease once: allowed only if the card and its node fit in view together.
      const x0 = Math.min(card.x, at.rect.x);
      const y0 = Math.min(card.y, at.rect.y);
      const x1 = Math.max(card.x + card.w, at.rect.x + at.rect.w);
      const y1 = Math.max(card.y + card.h, at.rect.y + at.rect.h);
      if (x1 - x0 > safe.w || y1 - y0 > safe.h) bad += out + 1;
      else cost += out * 1.5;
    } else {
      const t = 3 * ov;
      if (out > 0 && (card.x < safe.x - t || card.y < safe.y - t || card.x + card.w > safe.x + safe.w + t || card.y + card.h > safe.y + safe.h + t)) bad += out;
    }
  }
  return { bad, cost };
}

const sameSpot = (a: Placement, b: Placement) => a.side === b.side && Math.abs(a.lead - b.lead) < 1 && !!a.compact === !!b.compact && a.dx === b.dx;

/**
 * The free side: never over a node, inside the safe area (or a pan away from
 * it), clear of edges, short leader preferred; compact when space is tight.
 * Null when nothing fits (the dot stands in), unless `force`.
 */
export function place(input: PlaceInput): Placement | null {
  const { keep, h, force } = input;
  const hC = input.hCompact ?? h;
  const cands = candidates(input);
  let best = null as { p: Placement; cost: number } | null;
  let kept = null as { p: Placement; cost: number } | null;
  let least = null as { p: Placement; bad: number; cost: number } | null;
  for (const compact of [false, true]) {
    const hh = compact ? hC : h;
    for (const c of cands) {
      for (const p of variants(input, c, compact, hh)) {
        const { bad, cost } = judge(input, p, c.pref, hh);
        if (bad > 0) {
          if (force && (!least || bad < least.bad || (bad === least.bad && cost < least.cost))) least = { p, bad, cost };
          continue;
        }
        if (!best || cost < best.cost) best = { p, cost };
        if (keep && sameSpot(keep, p) && (!kept || cost < kept.cost)) kept = { p, cost };
      }
    }
    // A full card that fits beats any compact one.
    if (best && !best.p.compact) break;
  }
  if (!best) return force && least ? least.p : null;
  // Hysteresis: a card that is still fine stays where it is.
  if (kept && kept.cost <= best.cost * 1.25 + 4000) return kept.p;
  return best.p;
}

/** Rough card height (card px) before the real one is measured. */
export function estimateCardH(prompt: string, why: string | undefined, options: string[], compact = false): number {
  const inner = (compact ? COMPACT_W : CARD_W) - 32;
  const lines = (text: string, perLine: number) => Math.max(1, Math.ceil(text.length / perLine));
  let h = compact ? 20 + 24 + lines(prompt, 33) * 19.3 : 26 + 26 + lines(prompt, 38) * 21.3;
  if (why && !compact) h += 6 + lines(why, 46) * 16.8;
  if (options.length) {
    const per = compact ? 6.2 : 6.9;
    const pad = compact ? 20 : 26;
    const rowH = compact ? 22 : 28;
    let rows = 1;
    let x = 0;
    for (const o of options) {
      const w = Math.min(inner, o.length * per + pad);
      if (x > 0 && x + w > inner) {
        rows++;
        x = 0;
      }
      x += w + (compact ? 5 : 6);
    }
    h += (compact ? 8 : 12) + rows * rowH + (rows - 1) * (compact ? 5 : 6);
  }
  return Math.round(h);
}
