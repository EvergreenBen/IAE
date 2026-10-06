// The scope driver: makes what's on screen follow the store's scopeId, one
// continuous zoom at a time. A dive draws the child scope *inside* its node in
// the parent's coordinates, flies the camera into it, then rebases so the child
// becomes the world (nothing moves on screen). Surfacing is the reverse.
import type { D3ZoomEvent } from 'd3-zoom';
import { ancestorsOf } from '@shared/map';
import { useIae, ui, type CameraRequest } from '../state/store';
import { FLY_MS, type Camera } from './camera';
import { clamp, IDENTITY, mappingInto, viewToParent, type Mapping, type View } from './geometry';
import { layoutScope, QUESTION_MARGIN, scopeKey, type ScopeLayout } from './layout';
import { mapLocal, useMapLocal, type LayerSpec } from './mapStore';

const DIVE_K = 2.2;
const SURFACE_K = 0.55;
const AUTO_FIT_IDLE = 2500;
/** The lead's "look at this" waits this long after the user last steered (pan, zoom, dive). */
const LEAD_DEFERS = 8000;
const WORKING = new Set(['starting', 'thinking', 'working']);

const inverse = (m: Mapping): Mapping => ({ s: 1 / m.s, mx: -m.mx / m.s, my: -m.my / m.s });

export class Driver {
  private running = false;
  private focus: { nodeId: string | null; mode: 'show' | 'enter'; tries: number; select?: boolean } | null = null;
  /** A scope the driver itself asked for (so the change isn't counted as the user steering). */
  private expectScope: string | null | undefined = undefined;
  /** Last time the user changed scope themselves (dive, breadcrumb, Esc, palette). */
  private userNavAt = 0;
  private armedAt = 0;
  private disposed = false;
  private relayoutQueued = false;

  constructor(private cam: Camera) {}

  dispose() {
    this.disposed = true;
  }

  // ── layouts ────────────────────────────────────────────────────────────────

  async layoutFor(scopeId: string | null): Promise<ScopeLayout> {
    const s = useIae.getState();
    const l = await layoutScope(s.map, s.files, scopeId, s.meaning);
    if (useMapLocal.getState().layouts[l.key] !== l) useMapLocal.setState((st) => ({ layouts: { ...st.layouts, [l.key]: l } }));
    return l;
  }

  /** Re-run layout for the shown scope after map/files change. Glides; refits only when needed. */
  async relayout() {
    if (this.running) {
      this.relayoutQueued = true;
      return;
    }
    const shown = useMapLocal.getState().shown;
    if (shown === undefined) return;
    const prev = useMapLocal.getState().layouts[scopeKey(shown)];
    const next = await this.layoutFor(shown);
    // The scope may have changed while ELK thought: never frame a scope that's no longer shown.
    if (this.disposed || this.running || prev === next || useMapLocal.getState().shown !== shown) return;
    this.updateExtent(next);
    if (!next.bounds) return;
    const idle = performance.now() - this.cam.lastUserMove > AUTO_FIT_IDLE;
    const wasEmpty = !prev?.bounds;
    if (wasEmpty || (idle && !this.cam.inView(next.bounds))) {
      // Something was born outside the view: bring it in, gently.
      void this.cam.fly(this.fitView(next), wasEmpty ? FLY_MS : 600);
    }
  }

  private fitView(l: ScopeLayout): View {
    if (!l.bounds) return this.cam.centerOn(0, 0, 1);
    let b = l.bounds;
    // A question about something in this scope sits in the right margin when the
    // frame is crowded: keep that margin in view (and the stubs that poke out).
    const left = Math.min(b.x, ...l.stubs.map((s) => s.x));
    const right = Math.max(b.x + b.w, ...l.stubs.map((s) => s.x + s.w));
    b = { ...b, x: left, w: right - left };
    if (l.frame && this.questionInside(l.scopeId)) b = { ...b, w: b.w + QUESTION_MARGIN };
    return this.cam.fit(b, l.frame ? 1.1 : 1.15);
  }

  /** An open question in this scope that would show as a card (one put off with "later" doesn't need room). */
  private questionInside(scopeId: string | null): boolean {
    if (!scopeId) return false;
    const { agenda, map } = useIae.getState();
    const later = useMapLocal.getState().later;
    return agenda.some((a) => a.status === 'open' && !later.includes(a.id) && a.nodeId && (a.nodeId === scopeId || ancestorsOf(map, a.nodeId).some((n) => n.id === scopeId)));
  }

  private updateExtent(l: ScopeLayout) {
    const fk = this.fitView(l).k;
    this.cam.setExtent(Math.min(0.3, fk * 0.6), 6);
  }

  private surfaceK(l: ScopeLayout | undefined) {
    if (!l) return SURFACE_K;
    return Math.min(SURFACE_K, this.fitView(l).k * 0.72);
  }

  // ── camera requests from the lead / palette / crew ─────────────────────────

  /** The store's scope changed; if the driver didn't ask for it, the user is steering. */
  noteScope(scopeId: string | null) {
    if (this.expectScope !== undefined && scopeId === this.expectScope) this.expectScope = undefined;
    else this.userNavAt = performance.now();
  }

  private steeredRecently(): boolean {
    return performance.now() - Math.max(this.cam.lastUserMove, this.userNavAt) < LEAD_DEFERS;
  }

  /** Builders at work outside `nodeId`'s subtree: diving in would hide them. */
  private busyElsewhere(nodeId: string): boolean {
    const { agents, map } = useIae.getState();
    return Object.values(agents).some((a) => a.role !== 'lead' && WORKING.has(a.status) && a.nodeId && a.nodeId !== nodeId && !ancestorsOf(map, a.nodeId).some((n) => n.id === nodeId));
  }

  private setScope(target: string | null) {
    this.expectScope = target;
    ui.setScope(target);
  }

  onCameraRequest(req: CameraRequest) {
    const s = useIae.getState();
    if (req.source === 'lead') {
      if (this.steeredRecently()) {
        // The user is looking somewhere: don't take the camera. Point, if it's on screen.
        if (req.nodeId && s.map.nodes[req.nodeId]) mapLocal.highlight(req.nodeId);
        return;
      }
      if (req.mode === 'enter' && req.nodeId && this.busyElsewhere(req.nodeId)) req = { ...req, mode: 'show' };
    } else this.userNavAt = performance.now();
    if (!req.nodeId) {
      this.focus = { nodeId: null, mode: req.mode, tries: 0 };
      if (s.scopeId !== null) this.setScope(null);
      this.kick();
      return;
    }
    const node = s.map.nodes[req.nodeId];
    if (!node) {
      // The node may be a moment away (ops and focus arrive together). Try briefly.
      const tries = (this.focus?.nodeId === req.nodeId ? this.focus.tries : 0) + 1;
      if (tries <= 4) {
        this.focus = { nodeId: req.nodeId, mode: req.mode, tries, select: req.source === 'user' };
        setTimeout(() => !this.disposed && this.onCameraRequest(req), 250);
      }
      return;
    }
    const target = req.mode === 'enter' ? node.id : node.parentId;
    this.focus = { nodeId: node.id, mode: req.mode, tries: 0, select: req.source === 'user' };
    if (s.scopeId !== target) this.setScope(target);
    this.kick();
  }

  // ── semantic zoom ──────────────────────────────────────────────────────────

  onZoom(v: View, user: boolean, ev?: D3ZoomEvent<HTMLDivElement, unknown>) {
    if (!user || this.running) return;
    const se = ev?.sourceEvent as WheelEvent | undefined;
    if (!se || se.type !== 'wheel') return;
    const now = performance.now();
    if (now < this.armedAt) {
      // Still the same gesture that just carried us across a threshold: wait for it to end.
      this.armedAt = now + 320;
      return;
    }
    const shown = useMapLocal.getState().shown;
    if (shown === undefined) return;
    const L = useMapLocal.getState().layouts[scopeKey(shown)];
    if (!L) return;
    const { w, h } = this.cam.size();
    if (v.k > DIVE_K) {
      const rect = this.cam.el.getBoundingClientRect();
      const px = (se.clientX - rect.left - v.x) / v.k;
      const py = (se.clientY - rect.top - v.y) / v.k;
      const hit = Object.values(L.nodes).find((n) => px >= n.x && px <= n.x + n.w && py >= n.y && py <= n.y + n.h);
      if (hit && (hit.w * v.k >= w * 0.5 || hit.h * v.k >= h * 0.55)) {
        this.armedAt = now + 320;
        ui.setScope(hit.id);
        return;
      }
    }
    if (shown !== null && v.k < this.surfaceK(L)) {
      this.armedAt = now + 320;
      ui.setScope(useIae.getState().map.nodes[shown]?.parentId ?? null);
    }
  }

  // ── the loop ───────────────────────────────────────────────────────────────

  kick() {
    if (!this.running && !this.disposed) void this.run();
  }

  private target(): string | null {
    const s = useIae.getState();
    return s.scopeId && s.map.nodes[s.scopeId] ? s.scopeId : null;
  }

  private async run() {
    this.running = true;
    useMapLocal.setState({ busy: true });
    try {
      for (let guard = 0; guard < 16 && !this.disposed; guard++) {
        const target = this.target();
        const shown = useMapLocal.getState().shown;
        const map = useIae.getState().map;
        if (shown === undefined) {
          await this.jump(target, false);
          continue;
        }
        if (shown === target) break;
        if (shown !== null && !map.nodes[shown]) {
          await this.jump(target, true);
          continue;
        }
        const chain = target ? ancestorsOf(map, target).map((n) => n.id) : [];
        const remaining = (target ? chain.length + 1 : 0) + (shown ? ancestorsOf(map, shown).length + 1 : 0);
        const fast = remaining > 2;
        if (target !== null && (shown === null || chain.includes(shown))) {
          const idx = shown === null ? 0 : chain.indexOf(shown) + 1;
          const next = idx < chain.length ? chain[idx] : target;
          await this.dive(next, fast);
        } else {
          await this.surface(fast);
        }
      }
      if (!this.disposed) await this.settleFocus();
    } finally {
      this.running = false;
      useMapLocal.setState({ busy: false });
      this.cam.locked = false;
      this.armedAt = performance.now() + 320;
    }
    if (this.disposed) return;
    if (useMapLocal.getState().shown !== this.target()) this.kick();
    else {
      if (this.relayoutQueued) {
        this.relayoutQueued = false;
        void this.relayout();
      }
      // A question may have arrived mid-flight.
      setTimeout(() => !this.disposed && this.makeRoom(), 80);
    }
  }

  private setLayers(layers: LayerSpec[], shown?: string | null) {
    useMapLocal.setState(shown === undefined ? { layers } : { layers, shown });
  }

  /** Cut to a scope (first show, or when there's no sensible path to animate). */
  private async jump(scopeId: string | null, fade: boolean) {
    const l = await this.layoutFor(scopeId);
    const key = scopeKey(scopeId);
    this.cam.setMapping(key, IDENTITY);
    this.setLayers([{ key, scopeId, role: 'base', focusId: null, bornAt: fade ? performance.now() : performance.now() }], scopeId);
    this.updateExtent(l);
    this.cam.set(this.fitView(l));
  }

  private async dive(childId: string, fast: boolean) {
    const st = useMapLocal.getState();
    const outerKey = scopeKey(st.shown ?? null);
    const outer = st.layouts[outerKey] ?? (await this.layoutFor(st.shown ?? null));
    const inner = await this.layoutFor(childId);
    const box = outer.nodes[childId];
    if (!box || !inner.frame) return this.jump(childId, true);
    const m = mappingInto(inner.frame, box, 0.94);
    const innerKey = scopeKey(childId);
    const base = useMapLocal.getState().layers.find((l) => l.role === 'base') ?? { key: outerKey, scopeId: st.shown ?? null, role: 'base' as const, focusId: null, bornAt: 0 };
    this.cam.setMapping(innerKey, m);
    const born = performance.now();
    this.setLayers([
      { ...base, role: 'diveOuter', focusId: childId },
      { key: innerKey, scopeId: childId, role: 'diveInner', focusId: null, bornAt: born },
    ]);
    this.cam.locked = true;
    const fit = this.fitView(inner);
    await this.cam.fly(viewToParent(fit, m), fast ? 560 : FLY_MS);
    // Rebase: the child becomes the world. Nothing moves on screen.
    this.cam.setMapping(outerKey, inverse(m));
    this.cam.setMapping(innerKey, IDENTITY);
    this.cam.rebaseInto(m);
    this.setLayers([{ key: innerKey, scopeId: childId, role: 'base', focusId: null, bornAt: born }], childId);
    this.updateExtent(inner);
    this.cam.locked = false;
  }

  private async surface(fast: boolean) {
    const st = useMapLocal.getState();
    const shown = st.shown ?? null;
    if (shown === null) return;
    const parentId = useIae.getState().map.nodes[shown]?.parentId ?? null;
    const innerKey = scopeKey(shown);
    const inner = st.layouts[innerKey] ?? (await this.layoutFor(shown));
    const outer = await this.layoutFor(parentId);
    const box = outer.nodes[shown];
    if (!box || !inner.frame) return this.jump(parentId, true);
    const m = mappingInto(inner.frame, box, 0.94);
    const outerKey = scopeKey(parentId);
    const base = useMapLocal.getState().layers.find((l) => l.role === 'base');
    this.cam.setMapping(outerKey, IDENTITY);
    this.cam.setMapping(innerKey, m);
    this.cam.rebaseOut(m);
    this.setLayers([
      { key: outerKey, scopeId: parentId, role: 'surfaceOuter', focusId: shown, bornAt: performance.now() },
      { key: innerKey, scopeId: shown, role: 'surfaceInner', focusId: null, bornAt: base?.bornAt ?? 0 },
    ]);
    this.cam.locked = true;
    await this.cam.fly(this.fitView(outer), fast ? 560 : FLY_MS);
    this.setLayers([{ key: outerKey, scopeId: parentId, role: 'base', focusId: null, bornAt: performance.now() - 10_000 }], parentId);
    this.cam.forget(innerKey);
    this.updateExtent(outer);
    this.cam.locked = false;
  }

  private async settleFocus() {
    const f = this.focus;
    if (!f) return;
    const shown = useMapLocal.getState().shown;
    const map = useIae.getState().map;
    const want = f.nodeId === null ? null : f.mode === 'enter' ? f.nodeId : (map.nodes[f.nodeId]?.parentId ?? null);
    if (shown !== want) return;
    this.focus = null;
    const L = useMapLocal.getState().layouts[scopeKey(shown ?? null)];
    if (!L) return;
    if (f.nodeId === null || f.mode === 'enter') {
      if (f.nodeId === null) await this.cam.fly(this.fitView(L), 600);
      return;
    }
    const box = L.nodes[f.nodeId];
    if (!box) return;
    const v = this.cam.view;
    const fitK = this.fitView(L).k;
    if (!(this.cam.inView(box, 0) && v.k >= 0.8)) {
      // Close enough to read (labels show from 0.9×), not so close the neighbours vanish on a small window.
      const k = clamp(Math.max(v.k, 0.95), Math.min(fitK, 0.95), 1.35);
      await this.cam.fly(this.cam.centerOn(box.x + box.w / 2, box.y + box.h / 2, k), 640);
    }
    if (f.select) ui.select(f.nodeId);
    mapLocal.highlight(f.nodeId);
  }

  /**
   * Questions in this scope changed: make room in the margin for a new card, or
   * give the room back once it's answered or put off (only when the user isn't steering).
   */
  makeRoom() {
    const shown = useMapLocal.getState().shown;
    if (shown === undefined || shown === null || this.running) return;
    const L = useMapLocal.getState().layouts[scopeKey(shown)];
    if (!L?.frame) return;
    if (performance.now() - this.cam.lastUserMove < AUTO_FIT_IDLE) return;
    const to = this.fitView(L);
    const v = this.cam.view;
    if (Math.abs(to.k - v.k) / v.k < 0.03 && Math.abs(to.x - v.x) < 24 && Math.abs(to.y - v.y) < 24) return;
    void this.cam.fly(to, 640);
  }

  /** The window changed size: keep the scope framed unless the user has been steering. */
  onResize() {
    const shown = useMapLocal.getState().shown;
    if (shown === undefined || this.running) return;
    if (performance.now() - this.cam.lastUserMove < AUTO_FIT_IDLE * 4) return;
    const L = useMapLocal.getState().layouts[scopeKey(shown)];
    if (L) this.cam.set(this.fitView(L));
  }

  /** ⌘0 */
  fit() {
    const shown = useMapLocal.getState().shown;
    if (shown === undefined || this.running) return;
    const L = useMapLocal.getState().layouts[scopeKey(shown)];
    if (L) void this.cam.fly(this.fitView(L), 520);
  }
}
