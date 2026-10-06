// The camera: one d3-zoom behaviour on the full-window container, applied as a
// CSS transform to a handful of world layers. Nothing in React re-renders while
// the camera moves. Layers register here with a Mapping so an inner scope can be
// drawn inside its parent node during dives (see driver.ts).
import { interpolateZoom } from 'd3-interpolate';
import { easeCubicInOut } from 'd3-ease';
import { select, type Selection } from 'd3-selection';
import { zoom as d3zoom, zoomIdentity, type ZoomBehavior, type D3ZoomEvent } from 'd3-zoom';
import { clamp, composed, IDENTITY, type Mapping, type Rect, type View } from './geometry';

export const FIT_PAD = { top: 64, bottom: 140, side: 48 };
export const FLY_MS = 720;

interface LayerEntry {
  el: HTMLElement | null;
  m: Mapping;
  /** Overlay layers get a gentle counter-scale (--ov) so tokens and cards stay readable. */
  overlay?: boolean;
  lod?: string;
}

type Listener = (v: View, user: boolean, ev?: D3ZoomEvent<HTMLDivElement, unknown>) => void;

// d3's typings put rho() on the interpolator; at runtime it lives on the factory.
const zoomInterp = (interpolateZoom as unknown as { rho(r: number): typeof interpolateZoom }).rho(1.25);

const reducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export class Camera {
  readonly el: HTMLDivElement;
  readonly zoom: ZoomBehavior<HTMLDivElement, unknown>;
  private sel: Selection<HTMLDivElement, unknown, null, undefined>;
  view: View = { k: 1, x: 0, y: 0 };
  private layers = new Map<string, LayerEntry>();
  private listeners = new Set<Listener>();
  private settleListeners = new Set<() => void>();
  private flight = 0;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private moving = false;
  /** Input is ignored while the camera is flying somewhere on purpose. */
  locked = false;
  /** Last time the user moved the camera themselves. */
  lastUserMove = 0;
  /** Infinite dot grid: absolute zoom factor and grid origin in base-world coordinates. */
  private grid = { z: 1, ox: 0, oy: 0 };
  private gridEls: [HTMLElement | null, HTMLElement | null] = [null, null];

  constructor(el: HTMLDivElement) {
    this.el = el;
    this.sel = select(el);
    this.zoom = d3zoom<HTMLDivElement, unknown>()
      .scaleExtent([0.15, 6])
      .clickDistance(4)
      .filter((ev: Event) => {
        if (this.locked) return false;
        const e = ev as MouseEvent & WheelEvent;
        if (e.type === 'wheel') return e.ctrlKey || e.metaKey;
        if (e.type === 'dblclick') return false;
        const t = e.target as HTMLElement | null;
        if (t?.closest?.('[data-nopan]')) return false;
        return (!e.ctrlKey || e.type === 'wheel') && !e.button;
      })
      .wheelDelta((ev: WheelEvent) => -ev.deltaY * (ev.deltaMode === 1 ? 0.05 : ev.deltaMode ? 1 : 0.002) * (ev.ctrlKey ? 8 : 1.6))
      .on('zoom', (ev: D3ZoomEvent<HTMLDivElement, unknown>) => {
        const t = ev.transform;
        this.view = { k: t.k, x: t.x, y: t.y };
        const user = !!ev.sourceEvent;
        if (user) this.lastUserMove = performance.now();
        this.apply();
        for (const l of this.listeners) l(this.view, user, ev);
      });
    this.sel.call(this.zoom).on('dblclick.zoom', null);
    el.addEventListener('wheel', this.onWheel, { passive: false });
  }

  destroy() {
    this.el.removeEventListener('wheel', this.onWheel);
    this.sel.on('.zoom', null);
    this.flight++;
  }

  /** Plain two-finger scroll pans (trackpad-native); ⌘/ctrl/pinch zooms via d3. */
  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (this.locked || e.ctrlKey || e.metaKey) return;
    const k = this.view.k;
    const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
    const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
    const mult = e.deltaMode === 1 ? 16 : 1;
    this.zoom.translateBy(this.sel, (-dx * mult) / k, (-dy * mult) / k);
    this.lastUserMove = performance.now();
  };

  onChange(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Called once the camera comes to rest. */
  onSettle(f: () => void): () => void {
    this.settleListeners.add(f);
    return () => this.settleListeners.delete(f);
  }

  size(): { w: number; h: number } {
    return { w: this.el.clientWidth || window.innerWidth, h: this.el.clientHeight || window.innerHeight };
  }

  // ── layers ────────────────────────────────────────────────────────────────

  attach(key: string, el: HTMLElement | null, overlay = false) {
    const cur = this.layers.get(key) ?? { el: null, m: IDENTITY };
    cur.el = el;
    cur.overlay = overlay;
    cur.lod = undefined;
    this.layers.set(key, cur);
    if (el) this.applyLayer(cur);
  }

  setMapping(key: string, m: Mapping) {
    const cur = this.layers.get(key) ?? { el: null, m };
    cur.m = m;
    this.layers.set(key, cur);
    this.applyLayer(cur);
  }

  forget(key: string) {
    this.layers.delete(key);
  }

  setGridEls(a: HTMLElement | null, b: HTMLElement | null) {
    this.gridEls = [a, b];
    this.applyGrid();
  }

  private applyLayer(l: LayerEntry) {
    if (!l.el) return;
    const v = composed(this.view, l.m);
    l.el.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.k})`;
    if (l.overlay) l.el.style.setProperty('--ov', String(clamp(v.k, 0.8, 1.2) / v.k));
    // Level of detail as attributes, so crossing a threshold restyles in CSS without React.
    const lod = v.k < 0.55 ? 'far' : v.k < 0.9 ? 'mid' : v.k < 1.3 ? 'near' : 'close';
    if (lod !== l.lod) {
      l.lod = lod;
      l.el.dataset.lod = lod;
    }
  }

  apply() {
    for (const l of this.layers.values()) this.applyLayer(l);
    this.applyGrid();
    if (!this.moving) {
      this.moving = true;
      for (const l of this.layers.values()) if (l.el) l.el.style.willChange = 'transform';
    }
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      // Re-rasterise crisply once the camera rests.
      this.moving = false;
      for (const l of this.layers.values()) if (l.el) l.el.style.willChange = 'auto';
      for (const f of this.settleListeners) f();
    }, 180);
  }

  private applyGrid() {
    const [a, b] = this.gridEls;
    if (!a || !b) return;
    const { k, x, y } = this.view;
    const gk = k * this.grid.z;
    const L = Math.log2(gk);
    const f = L - Math.floor(L);
    const big = 26 * Math.pow(2, f); // 26..52px on screen
    const ox = x + k * this.grid.ox;
    const oy = y + k * this.grid.oy;
    const fade = clamp((k - 0.28) / 0.35, 0, 1);
    a.style.backgroundSize = `${big}px ${big}px`;
    // Offset by half a cell so dots sit on the lattice points and both scales coincide.
    a.style.backgroundPosition = `${ox - big / 2}px ${oy - big / 2}px`;
    a.style.opacity = String(fade);
    b.style.backgroundSize = `${big / 2}px ${big / 2}px`;
    b.style.backgroundPosition = `${ox - big / 4}px ${oy - big / 4}px`;
    b.style.opacity = String(fade * f);
  }

  /**
   * Re-express the world in an inner layer's coordinates without moving
   * anything on screen. `m` maps the new base into the old one.
   */
  rebaseInto(m: Mapping) {
    this.grid = { z: this.grid.z / m.s, ox: (this.grid.ox - m.mx) / m.s, oy: (this.grid.oy - m.my) / m.s };
    this.set(composed(this.view, m));
  }

  /** Opposite of rebaseInto: the old base becomes an inner layer placed with `m`. */
  rebaseOut(m: Mapping) {
    this.grid = { z: this.grid.z * m.s, ox: this.grid.ox * m.s + m.mx, oy: this.grid.oy * m.s + m.my };
    const k = this.view.k / m.s;
    this.set({ k, x: this.view.x - k * m.mx, y: this.view.y - k * m.my });
  }

  // ── moving ────────────────────────────────────────────────────────────────

  set(v: View) {
    this.flight++;
    this.zoom.transform(this.sel, zoomIdentity.translate(v.x, v.y).scale(v.k));
  }

  /** Smooth zoom-and-pan (van Wijk & Nuij) to `to`. Resolves when done or superseded. */
  fly(to: View, ms = FLY_MS): Promise<boolean> {
    const id = ++this.flight;
    const { w, h } = this.size();
    const from = this.view;
    if (reducedMotion() || ms <= 0) {
      this.set(to);
      return Promise.resolve(true);
    }
    const toVec = (v: View): [number, number, number] => [(w / 2 - v.x) / v.k, (h / 2 - v.y) / v.k, w / v.k];
    const interp = zoomInterp(toVec(from), toVec(to));
    const t0 = performance.now();
    return new Promise((resolve) => {
      const step = (now: number) => {
        if (id !== this.flight) return resolve(false);
        const t = clamp((now - t0) / ms, 0, 1);
        const [cx, cy, vw] = interp(easeCubicInOut(t));
        const k = w / vw;
        this.zoom.transform(this.sel, zoomIdentity.translate(w / 2 - cx * k, h / 2 - cy * k).scale(k));
        if (t < 1) requestAnimationFrame(step);
        else resolve(true);
      };
      requestAnimationFrame(step);
    });
  }

  /** Stop any flight in progress. */
  halt() {
    this.flight++;
  }

  /** Camera that fits `r` inside the safe area (clear of chrome and intent line). */
  fit(r: Rect, maxK = 1.15): View {
    const { w, h } = this.size();
    const aw = Math.max(80, w - FIT_PAD.side * 2);
    const ah = Math.max(80, h - FIT_PAD.top - FIT_PAD.bottom);
    const k = Math.min(maxK, aw / Math.max(1, r.w), ah / Math.max(1, r.h));
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    return { k, x: FIT_PAD.side + aw / 2 - cx * k, y: FIT_PAD.top + ah / 2 - cy * k };
  }

  /** Camera centred on a world point (in the safe area) at zoom k. */
  centerOn(cx: number, cy: number, k: number): View {
    const { w, h } = this.size();
    const ah = h - FIT_PAD.top - FIT_PAD.bottom;
    return { k, x: w / 2 - cx * k, y: FIT_PAD.top + ah / 2 - cy * k };
  }

  setExtent(minK: number, maxK: number) {
    this.zoom.scaleExtent([minK, maxK]);
  }

  /** World rect → screen rect under the current camera (base layer). */
  toScreen(r: Rect): Rect {
    const { k, x, y } = this.view;
    return { x: r.x * k + x, y: r.y * k + y, w: r.w * k, h: r.h * k };
  }

  /** Is this world rect fully inside the safe viewport? */
  inView(r: Rect, slack = 8): boolean {
    const s = this.toScreen(r);
    const { w, h } = this.size();
    return s.x >= FIT_PAD.side / 2 - slack && s.y >= FIT_PAD.top - 20 - slack && s.x + s.w <= w - FIT_PAD.side / 2 + slack && s.y + s.h <= h - FIT_PAD.bottom + 40 + slack;
  }
}
