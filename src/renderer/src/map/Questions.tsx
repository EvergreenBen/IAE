// Questions live where they apply. Exactly one card at a time: the most
// important open item visible in this scope, anchored to its node on the free
// side with a thin leader. Every other open item is a small clay dot.
import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { AgendaItem } from '@shared/model';
import { CrewMark } from '../avatar/CrewMark';
import { bridge } from '../bridge';
import { ui, useIae } from '../state/store';
import { setActiveAgendaId } from './activeAgenda';
import { useAnchorFn, useShownLayout, type Anchor } from './anchors';
import { useCamera } from './context';
import { inflate, type Rect } from './geometry';
import { Mark } from './glyphs';
import { QUESTION_CARD_W } from './layoutTypes';
import { useMapLocal } from './mapStore';
import s from './Questions.module.css';

const CARD_W = QUESTION_CARD_W;
const CARD_H = 196;
const LEADER = 30;

type Side = 'right' | 'left' | 'below' | 'above';

interface Placement {
  side: Side;
  lead: number;
  /** Where the leader leaves the node (offset from its top), for side placements. */
  dy: number;
}

const area = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/** Card rect (world, at zoom 1) for a side and leader length. Mirrors the CSS below. */
function cardRect(r: Rect, side: Side, lead: number, frame: boolean, dy = 26): Rect {
  if (side === 'right') return { x: r.x + r.w + lead, y: r.y + dy - 24, w: CARD_W, h: CARD_H };
  if (side === 'left') return { x: r.x - lead - CARD_W, y: r.y + dy - 24, w: CARD_W, h: CARD_H };
  const px = r.x + r.w - (frame ? 40 : 28);
  if (side === 'below') return { x: px + 28 - CARD_W, y: (frame ? r.y + 64 : r.y + r.h) + lead, w: CARD_W, h: CARD_H };
  return { x: px + 28 - CARD_W, y: r.y - lead - CARD_H, w: CARD_W, h: CARD_H };
}

/** A leader height that doesn't run along an edge or through a pill on its way out. */
function leaderDy(r: Rect, side: Side, lead: number, ports: number[], pills: Rect[]): number {
  if (side !== 'right' && side !== 'left') return 26;
  const x0 = side === 'right' ? r.x + r.w : r.x - lead;
  const x1 = side === 'right' ? r.x + r.w + lead : r.x;
  const crossing = pills.filter((p) => p.x < x1 && p.x + p.w > x0);
  let best = 26;
  let bestPen = Infinity;
  for (let dy = 18; dy <= r.h - 14; dy += 4) {
    const y = r.y + dy;
    let pen = Math.abs(dy - 26) * 0.5;
    for (const py of ports) if (Math.abs(py - y) < 10) pen += (10 - Math.abs(py - y)) * 20;
    for (const p of crossing) if (y > p.y - 6 && y < p.y + p.h + 6) pen += 400;
    if (pen < bestPen) {
      bestPen = pen;
      best = dy;
    }
  }
  return best;
}

/**
 * The free side: least overlap with nodes and stubs, kept on screen, short
 * leader preferred. When the neighbourhood is crowded the card moves to the
 * scope's right margin (which the camera keeps clear — see Driver.fitView).
 */
function place(at: Anchor, nodes: Rect[], soft: Rect[], view: Rect | null, marginX: number | null, keep: Placement | null, ports: { left: number[]; right: number[] }): Placement {
  const r = at.rect;
  const cands: { side: Side; lead: number; pref: number }[] = at.frame
    ? [{ side: 'below', lead: LEADER, pref: 0 }]
    : [
        { side: 'right', lead: LEADER, pref: 0 },
        { side: 'below', lead: LEADER + 12, pref: 900 },
        { side: 'right', lead: LEADER + 56, pref: 1600 },
        { side: 'left', lead: LEADER, pref: 1900 },
        { side: 'above', lead: LEADER, pref: 2800 },
        ...(marginX !== null && marginX > r.x + r.w + LEADER ? [{ side: 'right' as const, lead: marginX - (r.x + r.w), pref: 2400 }] : []),
      ];
  const dyFor = (c0: { side: Side; lead: number }) => leaderDy(r, c0.side, c0.lead, c0.side === 'left' ? ports.left : ports.right, soft);
  const score = (c0: { side: Side; lead: number; pref: number }) => {
    const c = inflate(cardRect(r, c0.side, c0.lead, at.frame, dyFor(c0)), 10);
    let sc = c0.pref;
    for (const n of nodes) sc += area(c, n) * 3;
    for (const n of soft) sc += area(c, n) * 3;
    if (view) sc += (c.w * c.h - area(c, view)) * 2;
    return sc;
  };
  let best: Placement = { side: cands[0].side, lead: cands[0].lead, dy: 26 };
  let bestScore = Infinity;
  for (const c0 of cands) {
    const sc = score(c0);
    if (sc < bestScore) {
      bestScore = sc;
      best = { side: c0.side, lead: c0.lead, dy: dyFor(c0) };
    }
  }
  // Hysteresis: a card that is still fine stays where it is.
  if (keep) {
    const k0 = cands.find((c) => c.side === keep.side && Math.abs(c.lead - keep.lead) < 1);
    if (k0 && score(k0) <= bestScore * 1.25 + 4000) return keep;
  }
  return best;
}

export function Questions() {
  const agenda = useIae((st) => st.agenda);
  const agents = useIae((st) => st.agents);
  const map = useIae((st) => st.map);
  const anchor = useAnchorFn();
  const { layout, busy } = useShownLayout();
  const pinned = useMapLocal((st) => st.pinnedAgenda);
  const later = useMapLocal((st) => st.later);

  const { active, dots } = useMemo(() => {
    const open = agenda.filter((a) => a.status === 'open');
    const placed = open.map((item) => ({ item, at: anchor(item.nodeId) })).filter((x): x is { item: AgendaItem; at: Anchor } => !!x.at);
    const rank = (x: { item: AgendaItem }) => x.item.priority - (later.includes(x.item.id) ? 10 : 0);
    placed.sort((a, b) => rank(b) - rank(a) || a.item.createdAt - b.item.createdAt);
    const pin = placed.find((p) => p.item.id === pinned);
    const best = pin ?? placed.find((p) => !later.includes(p.item.id)) ?? null;
    const dotMap = new Map<string, { at: Anchor; items: AgendaItem[] }>();
    for (const p of placed) {
      if (p.item.id === best?.item.id) continue;
      const cur = dotMap.get(p.at.id) ?? { at: p.at, items: [] };
      cur.items.push(p.item);
      dotMap.set(p.at.id, cur);
    }
    return { active: best, dots: [...dotMap.values()] };
  }, [agenda, anchor, pinned, later]);

  const activeId = busy ? null : (active?.item.id ?? null);
  useEffect(() => setActiveAgendaId(activeId), [activeId]);
  useEffect(() => () => setActiveAgendaId(null), []);

  const cam = useCamera();
  const [settled, setSettled] = useState(0);
  useEffect(() => cam?.onSettle(() => setSettled((n) => n + 1)), [cam]);
  const last = useRef<{ id: string; p: Placement } | null>(null);
  const placement = useMemo(() => {
    if (!active || !layout) return null;
    const nodes = [...Object.values(layout.nodes).filter((n) => n.id !== active.at.id), ...layout.tiles];
    const soft: Rect[] = [...layout.stubs, ...layout.shelf, ...layout.edges.flatMap((e) => (e.label ? [e.label] : []))];
    let view: Rect | null = null;
    if (cam) {
      const { w, h } = cam.size();
      const v = cam.view;
      view = { x: (16 - v.x) / v.k, y: (60 - v.y) / v.k, w: (w - 32) / v.k, h: (h - 60 - 120) / v.k };
    }
    const marginX = layout.frame ? Math.max(layout.frame.x + layout.frame.w, ...layout.stubs.map((st) => st.x + st.w)) + 32 : null;
    const keep = last.current?.id === `${active.item.id}@${active.at.id}` ? last.current.p : null;
    const id = active.at.id;
    const ports = { left: [] as number[], right: [] as number[] };
    for (const e of layout.edges) {
      const a = e.pts[0];
      const b = e.pts[e.pts.length - 1];
      const r = active.at.rect;
      if (e.from === id) (Math.abs(a.x - r.x) < 2 ? ports.left : ports.right).push(a.y);
      if (e.to === id) (Math.abs(b.x - r.x) < 2 ? ports.left : ports.right).push(b.y);
    }
    const p = place(active.at, nodes, soft, view, marginX, keep, ports);
    last.current = { id: `${active.item.id}@${active.at.id}`, p };
    return p;
    // Recompute when the question, its anchor or the layout changes, or the camera settles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.item.id, active?.at.id, layout, cam, settled]);

  return (
    <>
      {dots.map(({ at, items }) => (
        <motion.button
          key={`dot:${at.id}`}
          type="button"
          className={s.dotAnchor}
          data-nopan
          initial={{ opacity: 0, x: at.rect.x, y: at.rect.y }}
          animate={{ opacity: 1, x: at.rect.x, y: at.rect.y }}
          title={items[0].prompt}
          onClick={(e) => {
            e.stopPropagation();
            const item = items[0];
            useMapLocal.setState((st) => ({ pinnedAgenda: item.id, later: st.later.filter((x) => x !== item.id) }));
            if (item.nodeId && item.nodeId !== at.id && map.nodes[item.nodeId] && !at.frame) ui.focus(item.nodeId, 'show');
          }}
        >
          <span className={s.ov}>
            <span className={s.dot} data-frame={at.frame || undefined}>
              {items.length > 1 && <span className={s.dotCount}>{items.length}</span>}
            </span>
          </span>
        </motion.button>
      ))}
      {active && (
        // Zoomed far out the card steps aside; its dot stands in for it.
        <button
          type="button"
          className={s.dotAnchor}
          data-active
          data-nopan
          style={{ transform: `translate(${active.at.rect.x}px, ${active.at.rect.y}px)` }}
          title={active.item.prompt}
          onClick={(e) => {
            e.stopPropagation();
            if (cam) void cam.fly(cam.centerOn(active.at.rect.x + active.at.rect.w / 2 + 160, active.at.rect.y + 90, 1), 640);
          }}
        >
          <span className={s.ov}>
            <span className={s.dot} data-frame={active.at.frame || undefined} />
          </span>
        </button>
      )}
      <AnimatePresence>
        {active && !busy && placement && <Card key={active.item.id} item={active.item} at={active.at} placement={placement} agents={agents} />}
      </AnimatePresence>
    </>
  );
}

function Card({ item, at, placement, agents }: { item: AgendaItem; at: Anchor; placement: Placement; agents: ReturnType<typeof useIae.getState>['agents'] }) {
  const r = at.rect;
  const { side, lead, dy } = placement;
  const px = r.x + r.w - (at.frame ? 40 : 28);
  const point =
    side === 'right' ? { x: r.x + r.w, y: r.y + dy } : side === 'left' ? { x: r.x, y: r.y + dy } : side === 'below' ? { x: px, y: at.frame ? r.y + 64 : r.y + r.h } : { x: px, y: r.y };
  const waiting = (item.blocking ?? []).map((id) => agents[id]).filter(Boolean);
  const map = useIae.getState().map;
  const where = item.nodeId && item.nodeId !== at.id ? map.nodes[item.nodeId]?.label : null;
  const options = item.options?.length ? item.options : [];

  return (
    <motion.div
      className={s.anchor}
      initial={{ x: point.x, y: point.y }}
      animate={{ x: point.x, y: point.y }}
      transition={{ duration: 0.42, ease: [0.65, 0, 0.35, 1] }}
      data-nopan
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <div className={s.ov} style={{ ['--lead' as string]: `${lead}px` }}>
        <div className={s.leader} data-side={side} />
        <motion.div
          className={s.card}
          data-side={side}
          data-agenda={item.id}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 4, transition: { duration: 0.18 } }}
          transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
        >
          <div className={s.head}>
            {waiting.length ? (
              <span className={s.eyebrow}>
                <CrewMark hue={waiting[0].hue} name={waiting[0].name} size={15} state="waiting" />
                {waiting.length === 1 ? `${waiting[0].name} is waiting` : `${waiting.map((a) => a.name).join(' and ')} are waiting`}
              </span>
            ) : (
              <span className={s.eyebrow}>{where ? `In ${where}` : item.kind === 'risk' ? 'A risk' : item.kind === 'idea' ? 'An idea' : 'Your call'}</span>
            )}
            <span className={s.actions}>
              <button
                type="button"
                className={s.later}
                onClick={() => useMapLocal.setState((st) => ({ later: [...st.later.filter((x) => x !== item.id), item.id], pinnedAgenda: st.pinnedAgenda === item.id ? null : st.pinnedAgenda }))}
              >
                later
              </button>
              <button type="button" className={s.close} aria-label="Dismiss" title="Dismiss" onClick={() => void bridge.dismiss(item.id)}>
                <Mark name="cross" size={11} />
              </button>
            </span>
          </div>
          <p className={s.prompt}>{item.prompt}</p>
          {item.why && <p className={s.why}>{item.why}</p>}
          {options.length > 0 && (
            <div className={s.options}>
              {options.map((o, i) => (
                <button key={o} type="button" className={s.option} data-rec={i === 0 || undefined} onClick={() => void bridge.answer(item.id, o)}>
                  {o}
                </button>
              ))}
            </div>
          )}
        </motion.div>
      </div>
    </motion.div>
  );
}
