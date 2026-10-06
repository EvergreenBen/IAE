// Small, pure geometry helpers for the map. World units are CSS px at zoom 1.

export interface Pt {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A camera transform: screen = world * k + (x, y). */
export interface View {
  k: number;
  x: number;
  y: number;
}

/** Maps an inner scope's coordinates into its parent's: p = c * s + (mx, my). */
export interface Mapping {
  s: number;
  mx: number;
  my: number;
}

export const IDENTITY: Mapping = { s: 1, mx: 0, my: 0 };

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function union(rects: Rect[]): Rect | null {
  if (!rects.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function inflate(r: Rect, top: number, right = top, bottom = top, left = right): Rect {
  return { x: r.x - left, y: r.y - top, w: r.w + left + right, h: r.h + top + bottom };
}

export function overlaps(a: Rect, b: Rect, gap = 0): boolean {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
}

export const center = (r: Rect): Pt => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

/** Place `inner` centred inside `outer`, uniformly scaled to fit (times `fill`). */
export function mappingInto(inner: Rect, outer: Rect, fill = 0.9): Mapping {
  const s = Math.min(outer.w / inner.w, outer.h / inner.h) * fill;
  const c = center(outer);
  return { s, mx: c.x - (inner.x + inner.w / 2) * s, my: c.y - (inner.y + inner.h / 2) * s };
}

/** The camera that shows an inner layer exactly as `inner` does, expressed in the parent's space. */
export function viewToParent(inner: View, m: Mapping): View {
  const k = inner.k / m.s;
  return { k, x: inner.x - k * m.mx, y: inner.y - k * m.my };
}

/** Inverse of viewToParent: parent camera → the camera of an inner layer placed with `m`. */
export function viewToInner(parent: View, m: Mapping): View {
  return { k: parent.k * m.s, x: parent.x + parent.k * m.mx, y: parent.y + parent.k * m.my };
}

/** Compose: a layer drawn with mapping `m` under camera `v` has this effective transform. */
export const composed = viewToInner;

/** Rounded orthogonal polyline as an SVG path. */
export function roundedPath(pts: Pt[], r = 10): string {
  if (pts.length < 2) return '';
  const f = (n: number) => Math.round(n * 10) / 10;
  let d = `M${f(pts[0].x)},${f(pts[0].y)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p0 = pts[i - 1];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const d1 = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const d2 = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const rr = Math.min(r, d1 / 2, d2 / 2);
    if (rr < 0.5) {
      d += ` L${f(p1.x)},${f(p1.y)}`;
      continue;
    }
    const a = { x: p1.x + ((p0.x - p1.x) / d1) * rr, y: p1.y + ((p0.y - p1.y) / d1) * rr };
    const b = { x: p1.x + ((p2.x - p1.x) / d2) * rr, y: p1.y + ((p2.y - p1.y) / d2) * rr };
    d += ` L${f(a.x)},${f(a.y)} Q${f(p1.x)},${f(p1.y)} ${f(b.x)},${f(b.y)}`;
  }
  const last = pts[pts.length - 1];
  d += ` L${f(last.x)},${f(last.y)}`;
  return d;
}

/** Drop collinear and duplicate points so corners are only drawn where the path turns. */
export function simplify(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev.x - p.x) < 0.5 && Math.abs(prev.y - p.y) < 0.5) continue;
    out.push(p);
  }
  for (let i = out.length - 2; i > 0; i--) {
    const a = out[i - 1];
    const b = out[i];
    const c = out[i + 1];
    if ((Math.abs(a.x - b.x) < 0.5 && Math.abs(b.x - c.x) < 0.5) || (Math.abs(a.y - b.y) < 0.5 && Math.abs(b.y - c.y) < 0.5)) out.splice(i, 1);
  }
  return out;
}

/** Midpoint of the longest segment — a calm place for a label. */
export function labelPoint(pts: Pt[]): Pt {
  let best = 0;
  let at: Pt = pts[0] ?? { x: 0, y: 0 };
  for (let i = 1; i < pts.length; i++) {
    const len = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (len > best) {
      best = len;
      at = { x: (pts[i].x + pts[i - 1].x) / 2, y: (pts[i].y + pts[i - 1].y) / 2 };
    }
  }
  return at;
}
