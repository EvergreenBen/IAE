// Questions live where they apply. Exactly one card at a time: the most
// important open item visible in this scope, anchored to its node on the free
// side with a thin leader. Every other open item is a small clay dot.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { AgendaItem } from '@shared/model';
import { CrewMark } from '../avatar/CrewMark';
import { bridge } from '../bridge';
import { ui, useIae } from '../state/store';
import { setActiveAgendaId } from './activeAgenda';
import { useAnchorFn, useShownLayout, type Anchor } from './anchors';
import { useCamera } from './context';
import { clamp, union, type Rect } from './geometry';
import { Mark } from './glyphs';
import { useMapLocal } from './mapStore';
import { anchorPoint, CARD_W, cardRect, estimateCardH, HEAD, NOTCH, place, type Placement } from './questionPlace';
import s from './Questions.module.css';

/** Edge polylines as thin rects (one per segment), for placement to keep clear of. */
function segmentRects(pts: { x: number; y: number }[]): Rect[] {
  const out: Rect[] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    out.push({ x: Math.min(a.x, b.x) - 3, y: Math.min(a.y, b.y) - 3, w: Math.abs(a.x - b.x) + 6, h: Math.abs(a.y - b.y) + 6 });
  }
  return out;
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
    // A card speaks for its own node, or a child of a visible one ("In Groups").
    // Anything deeper is too far from what's on screen: its ancestor shows the dot.
    const near = (p: { item: AgendaItem; at: Anchor }) => p.at.frame || p.item.nodeId === p.at.id || map.nodes[p.item.nodeId ?? '']?.parentId === p.at.id;
    const pin = placed.find((p) => p.item.id === pinned && near(p));
    const card = pin ?? placed.find((p) => !later.includes(p.item.id) && near(p)) ?? null;
    const dotMap = new Map<string, { at: Anchor; items: AgendaItem[] }>();
    for (const p of placed) {
      if (p.item.id === card?.item.id) continue;
      const cur = dotMap.get(p.at.id) ?? { at: p.at, items: [] };
      cur.items.push(p.item);
      dotMap.set(p.at.id, cur);
    }
    return { active: card, dots: [...dotMap.values()] };
  }, [agenda, anchor, pinned, later, map]);

  const activeId = busy ? null : (active?.item.id ?? null);
  useEffect(() => setActiveAgendaId(activeId), [activeId]);
  useEffect(() => () => setActiveAgendaId(null), []);

  const cam = useCamera();
  const [settled, setSettled] = useState(0);
  useEffect(() => cam?.onSettle(() => setSettled((n) => n + 1)), [cam]);

  // The card's real height (card px), once it has rendered; an estimate until then.
  const [measured, setMeasured] = useState<{ id: string; h: number } | null>(null);
  const onMeasure = useCallback((id: string, h: number) => setMeasured((m) => (m?.id === id && Math.abs(m.h - h) < 2 ? m : { id, h })), []);
  const cardH = active ? (measured?.id === active.item.id ? measured.h : estimateCardH(active.item.prompt, active.item.why, active.item.options ?? [])) : 0;

  const last = useRef<{ id: string; p: Placement } | null>(null);
  const panned = useRef(new Set<string>());
  const placement = useMemo(() => {
    if (!active || !layout || busy) return null;
    const nodes = [...Object.values(layout.nodes).filter((n) => n.id !== active.at.id), ...layout.tiles];
    const head = layout.frame ? [{ x: layout.frame.x, y: layout.frame.y, w: layout.frame.w, h: 72 }] : [];
    const soft: Rect[] = [...layout.stubs, ...layout.shelf, ...head, ...layout.edges.flatMap((e) => (e.label ? [e.label] : []))];
    const lines = layout.edges.flatMap((e) => segmentRects(e.pts));
    const k = cam?.view.k ?? 1;
    const ov = clamp(k, 0.8, 1.2) / k;
    const marginX = layout.frame ? Math.max(layout.frame.x + layout.frame.w, ...layout.stubs.map((st) => st.x + st.w)) + 32 : null;
    const marginL = layout.frame ? Math.min(layout.frame.x, ...layout.stubs.map((st) => st.x)) - 32 : null;
    const key = `${active.item.id}@${active.at.id}`;
    const keep = last.current?.id === key ? last.current.p : null;
    const id = active.at.id;
    const ports = { left: [] as number[], right: [] as number[] };
    for (const e of layout.edges) {
      const a = e.pts[0];
      const b = e.pts[e.pts.length - 1];
      const r = active.at.rect;
      if (e.from === id) (Math.abs(a.x - r.x) < 2 ? ports.left : ports.right).push(a.y);
      if (e.to === id) (Math.abs(b.x - r.x) < 2 ? ports.left : ports.right).push(b.y);
    }
    const canPan = !!cam && !panned.current.has(key) && performance.now() - cam.lastUserMove > 2500;
    const p = place({ at: active.at, nodes, soft, lines, safe: cam?.safeWorld() ?? null, canPan, ov, h: cardH, marginX, marginL, keep, ports });
    // Only a placement made at rest, at the card's real size, is worth sticking to.
    if (cam?.resting && measured?.id === active.item.id) last.current = { id: key, p };
    return { p, ov };
    // Recompute when the question, its anchor, its size or the layout changes, or the camera settles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.item.id, active?.at.id, layout, cam, settled, cardH, busy]);

  // Ghosts keep clear of the card.
  const shownCard = active && placement && !busy ? cardRect(active.at, placement.p, placement.ov, cardH) : null;
  const cardKey = shownCard ? `${Math.round(shownCard.x)},${Math.round(shownCard.y)},${Math.round(shownCard.w)},${Math.round(shownCard.h)}` : '';
  useEffect(() => {
    useMapLocal.setState({ card: shownCard });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardKey]);
  useEffect(() => () => useMapLocal.setState({ card: null }), []);

  // A new card that can't sit fully in view where it belongs (its node is low,
  // or near an edge): ease the camera just enough, once, unless the user is steering.
  useEffect(() => {
    if (!cam || !active || !placement || busy || !cam.resting) return;
    const key = `${active.item.id}@${active.at.id}`;
    if (panned.current.has(key) || measured?.id !== active.item.id) return;
    panned.current.add(key);
    if (performance.now() - cam.lastUserMove < 2500) return;
    const card = cardRect(active.at, placement.p, placement.ov, cardH);
    const to = cam.panToShow(union([card, active.at.rect]) ?? card);
    if (to) void cam.fly(to, 560);
  }, [cam, active, placement, busy, measured, cardH]);

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
        {active && !busy && placement && <Card key={active.item.id} item={active.item} at={active.at} placement={placement.p} agents={agents} onMeasure={onMeasure} />}
      </AnimatePresence>
    </>
  );
}

function Card({
  item,
  at,
  placement,
  agents,
  onMeasure,
}: {
  item: AgendaItem;
  at: Anchor;
  placement: Placement;
  agents: ReturnType<typeof useIae.getState>['agents'];
  onMeasure: (id: string, h: number) => void;
}) {
  const { side, lead, dy, slide } = placement;
  const point = anchorPoint(at, side, dy);
  const waiting = (item.blocking ?? []).map((id) => agents[id]).filter(Boolean);
  const map = useIae.getState().map;
  const where = item.nodeId && item.nodeId !== at.id ? map.nodes[item.nodeId]?.label : null;
  const options = item.options?.length ? item.options : [];

  // Report the real height so placement can keep the whole card in view.
  const cardRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const report = () => onMeasure(item.id, el.offsetHeight);
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [item.id, onMeasure]);

  // Offsets inside the counter-scaled overlay (card px). Mirrors questionPlace.cardRect.
  const pos =
    side === 'right'
      ? { left: lead, top: -(HEAD + slide) }
      : side === 'left'
        ? { right: lead, top: -(HEAD + slide) }
        : side === 'below'
          ? { top: lead, left: NOTCH - CARD_W + slide }
          : { bottom: lead, left: NOTCH - CARD_W + slide };

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
          ref={cardRef}
          className={s.card}
          data-side={side}
          data-agenda={item.id}
          style={pos}
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
