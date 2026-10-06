// Text measurement for layout (pill and chip widths). Canvas-based; falls back
// to an average glyph width before fonts are ready.
let ctx: CanvasRenderingContext2D | null = null;
const cache = new Map<string, number>();

export const FONT_UI = '"Inter Variable", -apple-system, system-ui, sans-serif';
export const FONT_MONO = '"JetBrains Mono Variable", ui-monospace, Menlo, monospace';

export function textWidth(text: string, px: number, family = FONT_UI, weight = 450): number {
  const key = `${weight}|${px}|${family}|${text}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  if (!ctx) ctx = document.createElement('canvas').getContext('2d');
  let w: number;
  if (ctx) {
    ctx.font = `${weight} ${px}px ${family}`;
    w = ctx.measureText(text).width;
  } else {
    w = text.length * px * (family === FONT_MONO ? 0.6 : 0.55);
  }
  w = Math.ceil(w);
  cache.set(key, w);
  return w;
}

/** Forget measurements once real fonts load (widths change slightly). */
export function resetMeasure() {
  cache.clear();
}
