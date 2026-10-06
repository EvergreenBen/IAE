// Architecture autocomplete: tentative nodes sketched while the user talks.
// Dashed clay, serif italic, translucent. When the lead commits a node with the
// same id, the real node grows from the ghost's spot (see ScopeLayer).
import { useEffect, useMemo } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { GhostProposal } from '@shared/model';
import { useIae } from '../state/store';
import { resolveAnchor, useShownLayout, type Anchor } from './anchors';
import { inflate, overlaps, roundedPath, union, type Pt, type Rect } from './geometry';
import { KindGlyph } from './glyphs';
import { LEAF, scopeKey, type ScopeLayout } from './layout';
import { useMapLocal } from './mapStore';
import s from './Ghosts.module.css';

const W = LEAF.w;
const H = LEAF.h;

interface Placed extends Rect {
  g: GhostProposal;
}

function place(ghosts: GhostProposal[], layout: ScopeLayout | undefined, anchor: (id?: string | null) => Anchor | null): Placed[] {
  const nodes = layout ? Object.values(layout.nodes) : [];
  const occupied: Rect[] = [...nodes, ...(layout?.stubs ?? []), ...(layout?.tiles ?? [])];
  const content = union(nodes);
  const out: Placed[] = [];
  const sorted = [...ghosts].sort((a, b) => b.confidence - a.confidence || a.key.localeCompare(b.key));
  const free = (r: Rect) => !occupied.some((o) => overlaps(inflate(r, 18), o));

  if (!content) {
    // Empty canvas: a calm row in the middle.
    const n = sorted.length;
    sorted.forEach((g, i) => out.push({ g, x: -(n * W + (n - 1) * 48) / 2 + i * (W + 48), y: -H / 2, w: W, h: H }));
    return out;
  }
  for (const g of sorted) {
    const near = anchor(g.nearNodeId);
    const cands: Pt[] = [];
    if (near && !near.frame) {
      const r = near.rect;
      cands.push(
        { x: r.x + r.w + 76, y: r.y + (r.h - H) / 2 },
        { x: r.x + r.w + 76, y: r.y + r.h + 36 },
        { x: r.x, y: r.y + r.h + 44 },
        { x: r.x, y: r.y - H - 44 },
        { x: r.x - W - 76, y: r.y + (r.h - H) / 2 },
        { x: r.x + r.w + 76, y: r.y - H - 36 },
      );
    }
    // Fallback: a column just right of everything.
    for (let i = 0; i < 12; i++) cands.push({ x: content.x + content.w + 96, y: content.y + i * (H + 32) });
    const pick = cands.map((p) => ({ ...p, w: W, h: H })).find(free) ?? { x: content.x + content.w + 96, y: content.y, w: W, h: H };
    occupied.push(pick);
    out.push({ g, ...pick });
  }
  return out;
}

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

  const visible = useMemo(() => {
    // A ghost belongs here when it relates to something visible in this scope (or the map is bare).
    return Object.values(ghostMap).filter((g) => {
      if (map.nodes[g.key]) return false;
      if (!g.nearNodeId) return shown === null || !Object.keys(layout?.nodes ?? {}).length;
      return g.nearNodeId === shown || !!anchor(g.nearNodeId);
    });
  }, [ghostMap, map, shown, layout, anchor]);

  const placed = useMemo(() => place(visible, layout, anchor), [visible, layout, anchor]);

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
