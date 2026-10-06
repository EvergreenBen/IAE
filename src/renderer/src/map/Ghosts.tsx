// Architecture autocomplete: tentative nodes sketched while the user talks.
// Dashed clay, serif italic, translucent. When the lead commits a node with the
// same id, the real node grows from the ghost's spot (see ScopeLayer).
import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useIae } from '../state/store';
import { resolveAnchor, useShownLayout } from './anchors';
import { useCamera } from './context';
import { roundedPath, union, type Rect } from './geometry';
import { dedupeGhosts } from './ghostDedupe';
import { holdGhosts, type Held } from './ghostHold';
import { GH, GW, placeOnBareCanvas, placeOnMap, type GhostSpot, type Slots } from './ghostPlace';
import { KindGlyph } from './glyphs';
import { scopeKey } from './layout';
import { useMapLocal } from './mapStore';
import s from './Ghosts.module.css';

const W = GW;
const H = GH;

function ghostEdge(from: Rect, to: Rect): string {
  const fc = from.x + from.w / 2;
  const tc = to.x + to.w / 2;
  const right = tc >= fc;
  const a = { x: right ? from.x + from.w : from.x, y: from.y + from.h / 2 };
  const b = { x: right ? to.x : to.x + to.w, y: to.y + to.h / 2 };
  if ((right && b.x - a.x < 24) || (!right && a.x - b.x < 24)) {
    // Stacked: go out the bottom and come in the top.
    const down = to.y > from.y;
    const p = { x: fc, y: down ? from.y + from.h : from.y };
    const q = { x: tc, y: down ? to.y : to.y + to.h };
    const my = (p.y + q.y) / 2;
    return roundedPath([p, { x: p.x, y: my }, { x: q.x, y: my }, q], 10);
  }
  const mx = (a.x + b.x) / 2;
  return roundedPath([a, { x: mx, y: a.y }, { x: mx, y: b.y }, b], 10);
}

export function Ghosts() {
  const ghostMap = useIae((st) => st.ghosts);
  const map = useIae((st) => st.map);
  const { layout, shown } = useShownLayout();
  const anchor = useMemo(() => (id?: string | null) => resolveAnchor(map, layout, shown, id), [map, layout, shown]);

  // Once shown, a ghost stays a moment (no flashes), and only the few likeliest show (ghostHold.ts).
  const held = useRef<Map<string, Held>>(new Map());
  const fresh = useMemo(() => {
    // One per proposal key (the model's sketch knows more than the lexicon), then:
    // a ghost belongs here when it relates to something visible in this scope (or the map is bare).
    const byKey = new Map<string, (typeof ghostMap)[string]>();
    for (const g of Object.values(ghostMap)) if (!byKey.has(g.key) || g.source === 'sketch') byKey.set(g.key, g);
    const here = [...byKey.values()].filter((g) => {
      if (map.nodes[g.key]) return false;
      // Related to nothing on the map (yet): it belongs at the top, or on a bare canvas.
      if (!g.nearNodeId || !map.nodes[g.nearNodeId]) return shown === null || !Object.keys(layout?.nodes ?? {}).length;
      return g.nearNodeId === shown || !!anchor(g.nearNodeId);
    });
    // Each idea once (the one already showing keeps its words), and never one that's already on the map.
    return dedupeGhosts(here, Object.values(map.nodes), new Set(held.current.keys()));
  }, [ghostMap, map, shown, layout, anchor]);
  const [tick, setTick] = useState(0);
  const hold = useMemo(() => {
    const r = holdGhosts(held.current, fresh, Date.now(), (k) => !!map.nodes[k]);
    held.current = r.held;
    return r;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fresh, map, tick]);
  useEffect(() => {
    if (hold.wakeIn === null) return;
    const t = setTimeout(() => setTick((n) => n + 1), hold.wakeIn + 30);
    return () => clearTimeout(t);
  }, [hold]);
  const visible = hold.shown;

  const cam = useCamera();
  const card = useMapLocal((st) => st.card);
  const [settled, setSettled] = useState(0);
  useEffect(() => cam?.onSettle(() => setSettled((n) => n + 1)), [cam]);
  const slots = useRef<Slots>(new Map());
  const prev = useRef<{ scope: string; spots: Map<string, Rect> }>({ scope: '', spots: new Map() });

  const placed = useMemo((): GhostSpot[] => {
    const key = scopeKey(shown);
    const nodes = layout ? Object.values(layout.nodes) : [];
    const content = union(nodes);
    // A ghost that takes over another's idea ("Payments" → "Stripe") takes its spot too.
    for (const [to, from] of hold.inherit) {
      const slot = slots.current.get(from);
      if (slot && !slots.current.has(to)) slots.current.set(to, slot);
      const spot = prev.current.spots.get(from);
      if (spot && !prev.current.spots.has(to)) prev.current.spots.set(to, spot);
    }
    if (!content) return placeOnBareCanvas(visible, slots.current);
    if (prev.current.scope !== key) prev.current = { scope: key, spots: new Map() };
    const head = layout?.frame ? [{ x: layout.frame.x, y: layout.frame.y, w: layout.frame.w, h: 72 }] : [];
    const out = placeOnMap({
      ghosts: visible,
      obstacles: [...nodes, ...(layout?.stubs ?? []), ...(layout?.tiles ?? []), ...(layout?.shelf ?? []), ...head, ...(card ? [card] : [])],
      lines: (layout?.edges ?? []).flatMap((e) => e.pts.slice(1).map((b, i) => ({ x: Math.min(e.pts[i].x, b.x), y: Math.min(e.pts[i].y, b.y), w: Math.abs(e.pts[i].x - b.x) || 1, h: Math.abs(e.pts[i].y - b.y) || 1 }))),
      content,
      anchorOf: (g) => {
        const at = anchor(g.nearNodeId);
        return at && !at.frame ? at.rect : null;
      },
      safe: cam?.safeWorld() ?? null,
      prev: prev.current.spots,
    });
    prev.current.spots = new Map(out.map((p) => [p.g.key, { x: p.x, y: p.y, w: p.w, h: p.h }]));
    return out;
    // Re-place when the camera settles too, so ghosts follow into view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, layout, anchor, card, cam, settled, shown]);

  useEffect(() => {
    if (!placed.length) return;
    const key = scopeKey(shown);
    const at = Date.now();
    useMapLocal.setState((st) => {
      const spots = { ...st.ghostSpots };
      for (const p of placed) spots[p.g.key] = { x: p.x, y: p.y, scope: key, at };
      return { ghostSpots: spots };
    });
  }, [placed, shown]);

  // Where a ghost goes when it is committed somewhere deeper than this scope.
  const exitTo = (key: string) => {
    if (!map.nodes[key]) return null;
    const at = anchor(key);
    if (!at || at.id === key) return null;
    return at.rect;
  };

  return (
    <>
      <svg className={s.svg} width="1" height="1" overflow="visible" aria-hidden>
        <AnimatePresence>
          {placed.flatMap((p) =>
            (p.g.connectsTo ?? []).map((t) => {
              const at = anchor(t);
              if (!at || at.frame) return null;
              return (
                <motion.path
                  key={`${p.g.key}->${t}`}
                  className={s.edge}
                  d={ghostEdge(p, at.rect)}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0, transition: { duration: 0.18 } }}
                  transition={{ duration: 0.4, delay: 0.12 }}
                />
              );
            }),
          )}
        </AnimatePresence>
      </svg>
      <AnimatePresence custom={exitTo}>
        {placed.map((p) => (
          <motion.div
            key={p.g.key}
            className={s.ghost}
            data-ghost={p.g.key}
            custom={exitTo}
            variants={{
              exit: (fn: typeof exitTo) => {
                const r = fn(p.g.key);
                return r
                  ? { x: r.x + r.w / 2 - W / 2, y: r.y + r.h / 2 - H / 2, scale: 0.4, opacity: 0, transition: { duration: 0.5, ease: [0.65, 0, 0.35, 1] } }
                  : { opacity: 0, transition: { duration: 0.22 } };
              },
            }}
            initial={{ opacity: 0, x: p.x, y: p.y, scale: 0.97 }}
            animate={{ opacity: 0.6, x: p.x, y: p.y, scale: 1 }}
            exit="exit"
            transition={{ duration: 0.36, ease: [0.22, 1, 0.36, 1] }}
            style={{ width: W, height: H }}
          >
            <KindGlyph kind={p.g.kind} tint="var(--clay-ink)" />
            <span className={s.label}>{p.g.label}</span>
          </motion.div>
        ))}
      </AnimatePresence>
    </>
  );
}
