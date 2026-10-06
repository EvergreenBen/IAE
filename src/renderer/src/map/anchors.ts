// Where things attach on the shown scope: a node's visible ancestor, or the
// scope's own frame when the thing is about the scope node itself.
import { useMemo } from 'react';
import { visibleAncestor } from '@shared/map';
import type { ArchMap } from '@shared/model';
import { useIae } from '../state/store';
import type { Rect } from './geometry';
import { scopeKey, type ScopeLayout } from './layout';
import { useMapLocal } from './mapStore';

export interface Anchor {
  /** Visible node id, or the scope id when anchored to the frame. */
  id: string;
  rect: Rect;
  frame: boolean;
}

export function resolveAnchor(map: ArchMap, layout: ScopeLayout | undefined, shown: string | null, nodeId: string | null | undefined): Anchor | null {
  if (!layout || !nodeId || !map.nodes[nodeId]) return null;
  if (nodeId === shown) return layout.frame ? { id: nodeId, rect: layout.frame, frame: true } : null;
  const v = visibleAncestor(map, nodeId, shown);
  if (!v) return null;
  const rect = layout.nodes[v];
  return rect ? { id: v, rect, frame: false } : null;
}

/** The layout of the scope currently shown as the base layer (undefined while none). */
export function useShownLayout(): { layout: ScopeLayout | undefined; shown: string | null; busy: boolean } {
  const shown = useMapLocal((s) => s.shown);
  const layout = useMapLocal((s) => (s.shown === undefined ? undefined : s.layouts[scopeKey(s.shown)]));
  const busy = useMapLocal((s) => s.busy);
  return { layout, shown: shown ?? null, busy };
}

export function useAnchorFn() {
  const { layout, shown } = useShownLayout();
  const map = useIae((s) => s.map);
  return useMemo(() => (nodeId: string | null | undefined) => resolveAnchor(map, layout, shown, nodeId), [map, layout, shown]);
}
