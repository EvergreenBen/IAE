// Edge labels with restraint. Where several edges converge, ELK stacks their
// pills in one channel and the map starts to read like a list. Each label gets
// the zoom tier at which it can show without crowding a more important one
// (earlier in model order wins). The rest appear only while one of their ends
// is hovered or selected (Edges.module.css reads the tier).
import type { Rect } from './geometry';

export type LabelTier = 'near' | 'close' | 'hover';

/** Minimum distance between pill centres in one channel, world px, per tier. */
const NEAR_GAP = 54;
const CLOSE_GAP = 30;

function crowds(a: Rect, b: Rect, gapY: number, padX: number): boolean {
  if (a.x >= b.x + b.w + padX || b.x >= a.x + a.w + padX) return false;
  return Math.abs(a.y + a.h / 2 - (b.y + b.h / 2)) < gapY;
}

/** Tier per label id, in priority order (first = most important). */
export function labelTiers(labels: (Rect & { id: string })[]): Map<string, LabelTier> {
  const out = new Map<string, LabelTier>();
  const near: Rect[] = [];
  const close: Rect[] = [];
  for (const l of labels) {
    if (!near.some((a) => crowds(l, a, NEAR_GAP, 16))) {
      out.set(l.id, 'near');
      near.push(l);
      close.push(l);
    } else if (!close.some((a) => crowds(l, a, CLOSE_GAP, 8))) {
      out.set(l.id, 'close');
      close.push(l);
    } else out.set(l.id, 'hover');
  }
  return out;
}
