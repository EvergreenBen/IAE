// The project surface: one full-bleed, zoomable architecture map.
// Camera (camera.ts) moves a few world layers by CSS transform; the driver
// (driver.ts) animates between scopes; layers and overlays render the data.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, MotionConfig } from 'motion/react';
import { bridge } from '../bridge';
import { ui, useIae, type IaeState } from '../state/store';
import { Activity } from './Activity';
import { Camera } from './camera';
import { Chrome } from './Chrome';
import { CameraContext, useCamera } from './context';
import { Crew } from './Crew';
import { Driver } from './driver';
import { Ghosts } from './Ghosts';
import { clearLayoutCache } from './layout';
import { mapLocal, useMapLocal } from './mapStore';
import { resetMeasure } from './measure';
import { Questions } from './Questions';
import { ScopeLayer } from './ScopeLayer';
import { useMapKeys } from './useMapKeys';
import s from './MapView.module.css';

export function MapView() {
  const rootRef = useRef<HTMLDivElement>(null);
  const gridA = useRef<HTMLDivElement>(null);
  const gridB = useRef<HTMLDivElement>(null);
  const [cam, setCam] = useState<Camera | null>(null);
  const [driver, setDriver] = useState<Driver | null>(null);
  const layers = useMapLocal((st) => st.layers);

  useLayoutEffect(() => {
    const c = new Camera(rootRef.current!);
    c.setGridEls(gridA.current, gridB.current);
    const d = new Driver(c);
    const off = c.onChange((v, user, ev) => d.onZoom(v, user, ev));
    setCam(c);
    setDriver(d);
    // Dev/audit handle for scripted camera checks (scripts/shoot.mjs --eval).
    if (import.meta.env.DEV) (window as unknown as { __iaeMap: unknown }).__iaeMap = { camera: c, driver: d, local: useMapLocal };
    return () => {
      off();
      d.dispose();
      c.destroy();
      mapLocal.reset();
      setCam(null);
      setDriver(null);
    };
  }, []);

  // Scope follows the store; a new project starts fresh.
  const scopeId = useIae((st) => st.scopeId);
  const root = useIae((st) => st.project?.root);
  const lastRoot = useRef(root);
  useEffect(() => {
    if (!driver) return;
    if (lastRoot.current !== root) {
      lastRoot.current = root;
      mapLocal.reset();
    }
    driver.kick();
  }, [driver, scopeId, root]);
  const lastScope = useRef(scopeId);
  useEffect(() => {
    if (!driver || lastScope.current === scopeId) return;
    lastScope.current = scopeId;
    driver.noteScope(scopeId);
  }, [driver, scopeId]);

  // Camera requests ("look at this").
  const camReq = useIae((st) => st.camera);
  const seenSeq = useRef(useIae.getState().camera?.seq ?? 0);
  useEffect(() => {
    if (!driver || !camReq || camReq.seq <= seenSeq.current) return;
    seenSeq.current = camReq.seq;
    driver.onCameraRequest(camReq);
  }, [driver, camReq]);

  // Structure changed → lay out again (cached by signature, so cheap when nothing moved).
  const map = useIae((st) => st.map);
  const files = useIae((st) => st.files);
  const meaning = useIae((st) => st.meaning);
  useEffect(() => {
    void driver?.relayout();
  }, [driver, map, files, meaning]);

  // Questions may need room in the margin of a framed scope.
  const openQs = useIae((st) => st.agenda.filter((a) => a.status === 'open').map((a) => `${a.id}:${a.nodeId}`).join(','));
  const later = useMapLocal((st) => st.later.join(','));
  const seenQs = useRef('');
  useEffect(() => {
    const key = `${openQs}|${later}`;
    if (!driver || key === seenQs.current) return;
    const first = !seenQs.current;
    seenQs.current = key;
    if (first && !openQs) return;
    const t = setTimeout(() => driver.makeRoom(), 60);
    return () => clearTimeout(t);
  }, [driver, openQs, later]);

  // Real fonts change text widths: measure again once they're in.
  useEffect(() => {
    if (!driver) return;
    let live = true;
    void document.fonts?.ready.then(() => {
      if (!live) return;
      resetMeasure();
      clearLayoutCache();
      void driver.relayout();
    });
    return () => {
      live = false;
    };
  }, [driver]);

  // Tell the engine what the user is looking at.
  useEffect(() => {
    let prev = '';
    const send = (st: IaeState) => {
      const v = { scopeId: st.scopeId, selectedNodeId: st.selectedNodeId, openFile: st.openFile };
      const key = `${v.scopeId}|${v.selectedNodeId}|${v.openFile}`;
      if (key === prev) return;
      prev = key;
      void bridge.setView(v);
    };
    send(useIae.getState());
    return useIae.subscribe(send);
  }, []);

  // Window resized → reframe (quietly, only if the user isn't steering).
  useEffect(() => {
    const el = rootRef.current;
    if (!driver || !el) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    let first = true;
    const ro = new ResizeObserver(() => {
      if (first) return void (first = false);
      clearTimeout(t);
      t = setTimeout(() => driver.onResize(), 120);
    });
    ro.observe(el);
    return () => {
      clearTimeout(t);
      ro.disconnect();
    };
  }, [driver]);

  useMapKeys(driver);

  return (
    <MotionConfig reducedMotion="user">
      <CameraContext.Provider value={cam}>
        <div
          ref={rootRef}
          className={s.root}
          data-map
          onClick={() => {
            if (useIae.getState().selectedNodeId) ui.select(null);
          }}
        >
          <div ref={gridA} className={s.grid} aria-hidden />
          <div ref={gridB} className={s.grid} aria-hidden />
          {cam && layers.map((l) => <ScopeLayer key={l.key} spec={l} />)}
          {cam && <Overlay />}
        </div>
        <EmptyHint />
        <Chrome />
      </CameraContext.Provider>
    </MotionConfig>
  );
}

/** Things anchored to the shown scope: activity, ghosts, crew, questions. */
function Overlay() {
  const cam = useCamera();
  const busy = useMapLocal((st) => st.busy);
  const shown = useMapLocal((st) => st.shown);
  return (
    <div ref={(el) => cam?.attach('overlay', el, true)} className={s.overlay} data-busy={busy || undefined} key={String(shown)}>
      <Activity />
      <Ghosts />
      <Crew />
      <Questions />
    </div>
  );
}

function EmptyHint() {
  const empty = useIae((st) => st.screen === 'project' && Object.keys(st.map.nodes).length === 0 && Object.keys(st.ghosts).length === 0);
  return (
    <AnimatePresence>
      {empty && (
        <motion.div className={s.empty} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}>
          <p className={s.emptyLine}>Describe it. The map will follow.</p>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
