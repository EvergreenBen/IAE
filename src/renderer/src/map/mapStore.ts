// Map-local UI state. Engine-derived state stays in the main store; this holds
// what only the map cares about: which scope layers are on screen, layouts,
// hover, the question the user pinned or deferred, transient highlights.
import { create } from 'zustand';
import type { Rect } from './geometry';
import type { ScopeLayout } from './layout';

/**
 * base         the interactive scope
 * diveOuter    parent being left (its focus node is where we dive)
 * diveInner    child arriving inside the focus node
 * surfaceOuter parent arriving around us
 * surfaceInner child being left (shrinks back into its node)
 */
export type LayerRole = 'base' | 'diveOuter' | 'diveInner' | 'surfaceOuter' | 'surfaceInner';

export interface LayerSpec {
  key: string;
  scopeId: string | null;
  role: LayerRole;
  /** The node the transition passes through (in the outer scope). */
  focusId: string | null;
  /** When the layer appeared — node enter staggers only on a fresh layer. */
  bornAt: number;
}

export interface MapLocal {
  /** Scope currently shown as the base layer. undefined until first layout. */
  shown: string | null | undefined;
  layers: LayerSpec[];
  layouts: Record<string, ScopeLayout>;
  busy: boolean;
  hovered: string | null;
  /** Agenda item the user asked to see (clicked its dot). */
  pinnedAgenda: string | null;
  /** Agenda items deferred with "later" (until the next new item). */
  later: string[];
  /** Brief clay ring when the lead says "look at this". */
  highlight: { id: string; seq: number } | null;
  /** Where ghosts were last drawn, so a committed node can grow from that spot. */
  ghostSpots: Record<string, { x: number; y: number; scope: string; at: number }>;
  /** The question card on the shown scope (world rect), so ghosts keep clear of it. */
  card: Rect | null;
}

export const useMapLocal = create<MapLocal>(() => ({
  shown: undefined,
  layers: [],
  layouts: {},
  busy: false,
  hovered: null,
  pinnedAgenda: null,
  later: [],
  highlight: null,
  ghostSpots: {},
  card: null,
}));

let hlSeq = 0;
export const mapLocal = {
  setHovered(hovered: string | null) {
    if (useMapLocal.getState().hovered !== hovered) useMapLocal.setState({ hovered });
  },
  highlight(id: string) {
    useMapLocal.setState({ highlight: { id, seq: ++hlSeq } });
  },
  reset() {
    useMapLocal.setState({ shown: undefined, layers: [], layouts: {}, busy: false, hovered: null, pinnedAgenda: null, later: [], highlight: null, ghostSpots: {}, card: null });
  },
};
