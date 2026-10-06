// Where a question card goes: the free side of its node, kept inside the safe
// area (never over the chrome or the conversation at the bottom). Pure, so it
// can be tested. Units: world px for rects; "card px" for the card's own
// geometry, which the overlay counter-scales by `ov` (world px per card px).
import type { Anchor } from './anchors';
import { clamp, inflate, type Rect } from './geometry';
import { QUESTION_CARD_W } from './layoutTypes';

export const CARD_W = QUESTION_CARD_W;
export const LEADER = 30;
/** Side cards: the leader meets the card this far below its top (card px). */
export const HEAD = 24;
/** Below/above cards: the leader meets the card this far in from its right edge (card px). */
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
}

export interface PlaceInput {
  at: Anchor;
  /** Hard obstacles: other nodes, file tiles. */
  nodes: Rect[];
  /** Soft obstacles: stubs, the file shelf, edge labels, a frame's title row. */
  soft: Rect[];
  /** Edge segments (thin rects): a card shouldn't hide the wiring it's about. */
  lines: Rect[];
  /** Safe area in world px (null when unknown). */
  safe: Rect | null;
  /**
   * The camera may still ease to make room for this card (once, when the user
   * isn't steering): then leaving the safe area costs little and covering the
   * map costs more. Otherwise staying in view is close to a hard rule.
   */
  canPan: boolean;
  ov: number;
  /** Card height, card px (measured, or estimated before the first measure). */
  h: number;
  /** A framed scope's right margin (world x), where a crowded card can go. */
  marginX: number | null;
  /** A framed scope's left margin (world x, right edge of the free area), for a card about the scope itself. */
  marginL: number | null;
  keep: Placement | null;
  /** Where edges meet the node on each side (world y), so the leader avoids them. */
  ports: { left: number[]; right: number[] };
}

const area = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/** Where the leader leaves the anchor (world). */
export function anchorPoint(at: Anchor, side: Side, dy: number): { x: number; y: number } {
  const r = at.rect;
  const px = r.x + r.w - (at.frame ? 40 : NOTCH);
  if (side === 'right') return { x: r.x + r.w, y: r.y + dy };
  if (side === 'left') return { x: r.x, y: r.y + dy };
  if (side === 'below') return { x: px, y: at.frame ? r.y + 64 : r.y + r.h };
  return { x: px, y: r.y };
}

/** The card's rect in world px. Mirrors the inline styles in Questions.tsx. */
export function cardRect(at: Anchor, p: Placement, ov: number, h: number): Rect {
  const a = anchorPoint(at, p.side, p.dy);
  const w = CARD_W * ov;
  const hh = h * ov;
  if (p.side === 'right') return { x: a.x + p.lead * ov, y: a.y - (HEAD + p.slide) * ov, w, h: hh };
  if (p.side === 'left') return { x: a.x - (p.lead + CARD_W) * ov, y: a.y - (HEAD + p.slide) * ov, w, h: hh };
  const x = a.x + (NOTCH - CARD_W + p.slide) * ov;
  if (p.side === 'below') return { x, y: a.y + p.lead * ov, w, h: hh };
  return { x, y: a.y - (p.lead + h) * ov, w, h: hh };
}

/** Range the slide may take so the leader still meets the card's edge. */
function slideRange(side: Side, h: number): [number, number] {
  return side === 'right' || side === 'left' ? [0, Math.max(0, h - HEAD - 22)] : [-8, CARD_W - NOTCH - 22];
}

/** The smallest slide that keeps the card inside the safe area (or as close as it gets). */
function fitSlide(at: Anchor, c: Omit<Placement, 'slide'>, ov: number, h: number, safe: Rect): number {
  const [lo, hi] = slideRange(c.side, h);
  const r = cardRect(at, { ...c, slide: 0 }, ov, h);
  if (c.side === 'right' || c.side === 'left') {
    // Sliding up by s moves the card's top to r.y - s*ov.
    const needUp = (r.y + r.h - (safe.y + safe.h)) / ov; // ≥ this to clear the bottom
    const maxUp = (r.y - safe.y) / ov; // ≤ this to stay below the top
    let s = Math.max(0, needUp);
    if (s > maxUp) s = Math.max(0, maxUp);
    return clamp(s, lo, hi);
  }
  // Sliding right by s moves the card's left to r.x + s*ov.
  const needRight = (safe.x - r.x) / ov;
  const maxRight = (safe.x + safe.w - (r.x + r.w)) / ov;
  let s = 0;
  if (needRight > 0) s = needRight;
  else if (maxRight < 0) s = maxRight;
  return clamp(s, lo, hi);
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

/**
 * The free side: least overlap with nodes and stubs, inside the safe area,
 * short leader preferred. When the neighbourhood is crowded the card moves to
 * the scope's right margin (which the camera keeps clear, see Driver.fitView).
 */
export function place(input: PlaceInput): Placement {
  const { at, nodes, soft, lines, safe, ov, h, marginX, marginL, keep, ports, canPan } = input;
  const outside = canPan ? 1 : 10;
  const r = at.rect;
  // A card about the scope itself sits outside its frame (clear of the stubs), never over its children.
  const frameLead = (gap: number | null) => Math.max(LEADER, gap === null ? LEADER : gap / ov);
  const cands: { side: Side; lead: number; pref: number }[] = at.frame
    ? [
        { side: 'right', lead: frameLead(marginX === null ? null : marginX - (r.x + r.w)), pref: 0 },
        { side: 'left', lead: frameLead(marginL === null ? null : r.x - marginL), pref: 1500 },
        { side: 'below', lead: LEADER, pref: 6000 },
      ]
    : [
        { side: 'right', lead: LEADER, pref: 0 },
        { side: 'below', lead: LEADER + 12, pref: 900 },
        { side: 'right', lead: LEADER + 56, pref: 1600 },
        { side: 'left', lead: LEADER, pref: 1900 },
        { side: 'left', lead: LEADER + 56, pref: 2600 },
        { side: 'above', lead: LEADER, pref: 2800 },
        ...(marginX !== null && marginX > r.x + r.w + LEADER * ov ? [{ side: 'right' as const, lead: (marginX - (r.x + r.w)) / ov, pref: 2400 }] : []),
      ];

  const score = (p: Placement, pref: number) => {
    const card = cardRect(at, p, ov, h);
    const c = inflate(card, 10 * ov);
    let sc = pref + Math.abs(p.slide) * ov * 4 + p.lead * ov * 2;
    for (const n of nodes) sc += area(c, n) * 6;
    for (const n of soft) sc += area(c, n) * 3;
    for (const l of lines) sc += area(card, l) * 6;
    // Outside the safe area means under the chrome or the conversation (unless the camera will make room).
    if (safe) sc += (card.w * card.h - area(card, safe)) * outside;
    // A card that can't fit in view even after a pan (taller than the safe area) is a last resort.
    if (safe && canPan) sc += Math.max(0, card.h - safe.h) * card.w * 8;
    return sc;
  };
  const variants = (c0: { side: Side; lead: number }): Placement[] => {
    const dy = leaderDy(at, c0.side, c0.lead, ov, c0.side === 'left' ? ports.left : ports.right, soft);
    const base = { side: c0.side, lead: c0.lead, dy };
    // Slides: none, the one that keeps it in view, and (for side cards) lifts that dodge what's below.
    const slides = new Set([0]);
    if (safe && !canPan) slides.add(fitSlide(at, base, ov, h, safe));
    if (c0.side === 'right' || c0.side === 'left') {
      const [, hi] = slideRange(c0.side, h);
      slides.add(Math.round(hi / 2));
      slides.add(Math.round(hi));
    }
    return [...slides].map((slide) => ({ ...base, slide }));
  };

  let best: Placement = { side: cands[0].side, lead: cands[0].lead, dy: 26, slide: 0 };
  let bestScore = Infinity;
  let kept: { p: Placement; s: number } | null = null;
  for (const c0 of cands) {
    for (const p of variants(c0)) {
      const sc = score(p, c0.pref);
      if (sc < bestScore) {
        bestScore = sc;
        best = p;
      }
      if (keep && keep.side === p.side && Math.abs(keep.lead - p.lead) < 1 && (!kept || sc < kept.s)) kept = { p, s: sc };
    }
  }
  // Hysteresis: a card that is still fine stays on its side.
  if (kept && kept.s <= bestScore * 1.25 + 4000) return kept.p;
  return best;
}

/** Rough card height (card px) before the real one is measured. */
export function estimateCardH(prompt: string, why: string | undefined, options: string[]): number {
  const inner = CARD_W - 32;
  const lines = (text: string, perLine: number) => Math.max(1, Math.ceil(text.length / perLine));
  let h = 26 + 26 + lines(prompt, 38) * 21.3;
  if (why) h += 6 + lines(why, 46) * 16.8;
  if (options.length) {
    let rows = 1;
    let x = 0;
    for (const o of options) {
      const w = o.length * 6.9 + 26;
      if (x > 0 && x + w > inner) {
        rows++;
        x = 0;
      }
      x += w + 6;
    }
    h += 12 + rows * 28 + (rows - 1) * 6;
  }
  return Math.round(h);
}
