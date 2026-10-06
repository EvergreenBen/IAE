// Shapes produced by the per-scope layout (layout.ts) and read by the layers.
import type { EdgeKind, NodeKind } from '@shared/model';
import type { LabelTier } from './edgeLabels';
import type { Pt, Rect } from './geometry';

/* Nodes are discs: w === h is the diameter. Their summary and child chips sit in
   a caption centred underneath, so the disc itself only carries glyph, label and
   file count. CAPTION is the room that caption needs — ELK never sees it (the
   node it lays out is the disc's square), so node spacing leaves room for it and
   `withCaption` adds it back when measuring content bounds. */
export const LEAF = { w: 140, h: 140 };
export const CONTAINER = { w: 180, h: 180 };
export const CAPTION = { w: 212, h: 44 };
export const TILE = { w: 212, h: 72, meaningH: 92 };
export const STUB_H = 26;
export const FRAME_PAD = { top: 84, side: 56, bottom: 52 };

export type EdgeStyle = 'solid' | 'dashed' | 'dotted';

export interface NodeBox extends Rect {
  id: string;
  kind: NodeKind;
  container: boolean;
}

export interface EdgeRoute {
  id: string;
  from: string;
  to: string;
  d: string;
  pts: Pt[];
  kinds: EdgeKind[];
  style: EdgeStyle;
  /** Pill at the midpoint; `tier` is the zoom at which it shows (edgeLabels.ts). */
  label?: { text: string; tier?: LabelTier } & Rect;
  /** Edge ends at a boundary stub rather than a sibling. */
  stub?: boolean;
}

export interface Stub extends Rect {
  key: string;
  dir: 'in' | 'out';
  /** The outside node it leads to (navigates there on click). */
  target: string;
  label: string;
  /** Not wired to a child (leaf scopes): a plain pill on the frame. */
  free?: boolean;
}

export interface FileChip extends Rect {
  path: string;
  name: string;
  dir: string;
  note?: string;
}

export interface ScopeLayout {
  key: string;
  scopeId: string | null;
  signature: string;
  nodes: Record<string, NodeBox>;
  order: string[];
  edges: EdgeRoute[];
  stubs: Stub[];
  frame: Rect | null;
  shelf: FileChip[];
  shelfLabel?: Pt;
  tiles: FileChip[];
  /** Leaf scope with nothing in it yet. */
  emptyNote?: Rect;
  /** Everything worth fitting the camera to. null = empty canvas. */
  bounds: Rect | null;
}

export const scopeKey = (scopeId: string | null) => scopeId ?? '∅';

/** A node's full footprint: its disc plus the caption centred under it. */
export function withCaption(b: Rect): Rect {
  const over = Math.max(0, (CAPTION.w - b.w) / 2);
  return { x: b.x - over, y: b.y, w: b.w + over * 2, h: b.h + CAPTION.h };
}

export function edgeStyle(kinds: EdgeKind[]): EdgeStyle {
  if (kinds.some((k) => k === 'calls' || k === 'reads' || k === 'writes' || k === 'depends')) return 'solid';
  if (kinds.includes('events')) return 'dashed';
  if (kinds.includes('auth')) return 'dotted';
  return 'solid';
}

/** Question cards (Questions.tsx) and the right-margin room the camera keeps for one. */
export const QUESTION_CARD_W = 300;
export const QUESTION_MARGIN = QUESTION_CARD_W + 56;
