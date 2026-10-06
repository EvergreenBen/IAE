// Shapes produced by the per-scope layout (layout.ts) and read by the layers.
import type { EdgeKind, NodeKind } from '@shared/model';
import type { LabelTier } from './edgeLabels';
import type { Pt, Rect } from './geometry';

export const LEAF = { w: 200, h: 72 };
export const CONTAINER = { w: 236, h: 120 };
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

export function edgeStyle(kinds: EdgeKind[]): EdgeStyle {
  if (kinds.some((k) => k === 'calls' || k === 'reads' || k === 'writes' || k === 'depends')) return 'solid';
  if (kinds.includes('events')) return 'dashed';
  if (kinds.includes('auth')) return 'dotted';
  return 'solid';
}

/** Question cards (Questions.tsx) and the right-margin room the camera keeps for one. */
export const QUESTION_CARD_W = 300;
export const QUESTION_MARGIN = QUESTION_CARD_W + 56;
