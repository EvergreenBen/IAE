import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

// Layered Escape handling for overlays (palette, lens, inline fields).
//
// One capturing listener on window runs before any other key handler (it is
// installed when this module is first imported, before components mount).
// Layers register a handler with a priority; on Escape the highest-priority,
// most recent handler that returns true consumes the key, and propagation
// stops, so the map underneath doesn't also surface a scope. When no layer
// consumes it, Escape flows on as normal.

export const ESC = {
  /** Inline editing inside an overlay (an add-row field, a search panel). */
  field: 30,
  /** The command palette (and its sub-views). */
  palette: 20,
  /** The file lens. */
  lens: 10,
} as const;

type Handler = (e: KeyboardEvent) => boolean;
interface Layer {
  handler: Handler;
  priority: number;
  order: number;
}

interface Registry {
  layers: Layer[];
  order: number;
}

// Survive hot module reloads: one registry and one listener per window.
const g = globalThis as unknown as { __iaeEscape?: Registry };
const reg: Registry = g.__iaeEscape ?? (g.__iaeEscape = { layers: [], order: 0 });

if (typeof window !== 'undefined' && !(window as unknown as { __iaeEscapeBound?: boolean }).__iaeEscapeBound) {
  (window as unknown as { __iaeEscapeBound?: boolean }).__iaeEscapeBound = true;
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      const sorted = [...reg.layers].sort((a, b) => b.priority - a.priority || b.order - a.order);
      for (const l of sorted) {
        if (l.handler(e)) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }
    },
    true,
  );
}

/** Register an Escape handler. Return true from it to consume the key. Returns an unregister function. */
export function onEscape(handler: Handler, priority: number): () => void {
  const layer: Layer = { handler, priority, order: ++reg.order };
  reg.layers.push(layer);
  return () => {
    const i = reg.layers.indexOf(layer);
    if (i !== -1) reg.layers.splice(i, 1);
  };
}

/** True when the keyboard event's modifier is ⌘ on macOS (Ctrl elsewhere). */
export const isMod = (e: KeyboardEvent | ReactKeyboardEvent): boolean => (IS_MAC ? e.metaKey : e.ctrlKey);

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
