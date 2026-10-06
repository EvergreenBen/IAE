// Where ghosts sit. On a bare canvas: a calm centred grid, one column per role
// (clients, then services and modules, then data and externals), so committed
// nodes glide forward rather than across. On a map: near the node each one
// relates to, in free space inside the visible safe area, clear of the
// question card. A ghost keeps its spot while it still fits, so ghosts never
// reshuffle as more of them arrive.
import type { GhostProposal, NodeKind } from '@shared/model';
import { inflate, overlaps, type Rect } from './geometry';
import { LEAF } from './layoutTypes';

export const GW = LEAF.w;
export const GH = LEAF.h;
const GAP_X = 48;
const GAP_Y = 28;

const COLUMN: Record<NodeKind, number> = { client: 0, system: 1, ai: 1, service: 1, module: 1, queue: 1, config: 1, infra: 1, data: 2, external: 2 };

export interface GhostSpot extends Rect {
  g: GhostProposal;
}

/** Bare canvas slots, kept across renders by the caller: key → column and order within it. */
export type Slots = Map<string, { col: number; order: number }>;

let orderSeq = 0;

export function placeOnBareCanvas(ghosts: GhostProposal[], slots: Slots): GhostSpot[] {
  for (const k of [...slots.keys()]) if (!ghosts.some((g) => g.key === k)) slots.delete(k);
  for (const g of ghosts) if (!slots.has(g.key)) slots.set(g.key, { col: COLUMN[g.kind], order: ++orderSeq });
  const cols = [...new Set(ghosts.map((g) => slots.get(g.key)!.col))].sort((a, b) => a - b);
  const byCol = cols.map((c) => ghosts.filter((g) => slots.get(g.key)!.col === c).sort((a, b) => slots.get(a.key)!.order - slots.get(b.key)!.order));
  const width = cols.length * GW + (cols.length - 1) * GAP_X;
  const out: GhostSpot[] = [];
  byCol.forEach((list, ci) => {
    // Each column is centred on the canvas's middle line, like a layered layout.
    const colH = list.length * GH + (list.length - 1) * GAP_Y;
    list.forEach((g, ri) => out.push({ g, x: -width / 2 + ci * (GW + GAP_X), y: -colH / 2 + ri * (GH + GAP_Y), w: GW, h: GH }));
  });
  return out;
}

export interface MapPlaceInput {
  ghosts: GhostProposal[];
  /** Nodes, stubs, tiles, the frame's title row, the question card. */
  obstacles: Rect[];
  /** Edge segments: avoided when there's a choice (a ghost on a line reads as part of it). */
  lines?: Rect[];
  /** Union of the scope's nodes. */
  content: Rect;
  /** The visible node a ghost relates to (null: none on screen). */
  anchorOf: (g: GhostProposal) => Rect | null;
  /** Visible safe area (world). Ghosts stay inside it when they can. */
  safe: Rect | null;
  /** Where each ghost was last drawn in this scope. */
  prev: Map<string, Rect>;
}

export function placeOnMap({ ghosts, obstacles, lines = [], content, anchorOf, safe, prev }: MapPlaceInput): GhostSpot[] {
  const occupied = [...obstacles];
  const free = (r: Rect) => !occupied.some((o) => overlaps(inflate(r, 16), o));
  const clear = (r: Rect) => !lines.some((l) => overlaps(inflate(r, 6), l));
  const inside = (r: Rect) => !safe || (r.x >= safe.x && r.y >= safe.y && r.x + r.w <= safe.x + safe.w && r.y + r.h <= safe.y + safe.h);
  const box = (x: number, y: number): Rect => ({ x, y, w: GW, h: GH });

  // Ghosts that already have a spot claim it first (stability), then the rest by confidence.
  const order = [...ghosts].sort((a, b) => Number(prev.has(b.key)) - Number(prev.has(a.key)) || b.confidence - a.confidence || a.key.localeCompare(b.key));
  const out: GhostSpot[] = [];
  for (const g of order) {
    const near = anchorOf(g);
    const cands: Rect[] = [];
    const was = prev.get(g.key);
    if (was) cands.push(box(was.x, was.y));
    if (near) {
      cands.push(
        box(near.x + near.w + 76, near.y + (near.h - GH) / 2),
        box(near.x + near.w + 76, near.y + near.h + 36),
        box(near.x, near.y + near.h + 44),
        box(near.x, near.y - GH - 44),
        box(near.x - GW - 76, near.y + (near.h - GH) / 2),
        box(near.x + near.w + 76, near.y - GH - 36),
      );
    }
    // Free space in view, nearest to what it's about first.
    if (safe) {
      const c = near ? { x: near.x + near.w / 2, y: near.y + near.h / 2 } : { x: content.x + content.w / 2, y: content.y + content.h / 2 };
      const grid: Rect[] = [];
      for (let x = safe.x + 12; x + GW <= safe.x + safe.w - 12; x += (GW + 24) / 2) for (let y = safe.y + 12; y + GH <= safe.y + safe.h - 12; y += (GH + 24) / 2) grid.push(box(x, y));
      grid.sort((a, b) => Math.hypot(a.x + GW / 2 - c.x, a.y + GH / 2 - c.y) - Math.hypot(b.x + GW / 2 - c.x, b.y + GH / 2 - c.y));
      cands.push(...grid);
    }
    const pick =
      cands.find((r) => free(r) && inside(r) && (r === cands[0] && was ? true : clear(r))) ??
      cands.find((r) => free(r) && inside(r)) ??
      cands.find(free) ??
      // Nowhere free in view: a column just right of everything.
      Array.from({ length: 12 }, (_, i) => box(content.x + content.w + 96, content.y + i * (GH + 32))).find(free) ??
      box(content.x + content.w + 96, content.y);
    occupied.push(pick);
    out.push({ g, ...pick });
  }
  return out;
}
