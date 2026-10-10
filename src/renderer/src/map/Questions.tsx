// Questions live where they apply. Exactly one card at a time: the most
// important open item visible in this scope, anchored to its node on the free
// side with a thin leader. Every other open item is a small accent dot.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { DEFAULT_SETTINGS, type AgendaItem } from '@shared/model';
import { CrewMark } from '../avatar/CrewMark';
import { bridge } from '../bridge';
import { ui, useIae } from '../state/store';
import { setActiveAgendaId } from './activeAgenda';
import { orderAgenda } from './agendaPick';
import { useAnchorFn, useShownLayout, type Anchor } from './anchors';
import { useCamera } from './context';
import { clamp, union, type Rect } from './geometry';
import { Mark } from './glyphs';
import { withCaption } from './layoutTypes';
import { useMapLocal } from './mapStore';
import { anchorPoint, cardRect, cardW, estimateCardH, HEAD, NOTCH, place, type Placement } from './questionPlace';
import s from './Questions.module.css';

const leadNameOf = () => useIae.getState().settings.leadName || DEFAULT_SETTINGS.leadName;

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

  // The card that is up now: it stays up until something fresher or more urgent arrives (agendaPick.ts).
  const current = useRef<string | null>(null);
  const { active, dots } = useMemo(() => {
    const open = agenda.filter((a) => a.status === 'open');
    const placed = open.map((item) => ({ item, at: anchor(item.nodeId) })).filter((x): x is { item: AgendaItem; at: Anchor } => !!x.at);
    const live = (id: string) => {
      const a = agents[id];
      return !!a && a.status !== 'done' && a.status !== 'failed' && a.status !== 'stopped';
    };
    const ordered = orderAgenda(placed, { now: Date.now(), later, current: current.current, blocking: (i) => (i.blocking ?? []).some(live) });
    // A card speaks for its own node, or a child of a visible one ("In Groups").
    // Anything deeper is too far from what's on screen: its ancestor shows the dot.
    const near = (p: { item: AgendaItem; at: Anchor }) => p.at.frame || p.item.nodeId === p.at.id || map.nodes[p.item.nodeId ?? '']?.parentId === p.at.id;
    const pin = ordered.find((p) => p.item.id === pinned && near(p));
    const card = pin ?? ordered.find((p) => !later.includes(p.item.id) && near(p)) ?? null;
    const dotMap = new Map<string, { at: Anchor; items: AgendaItem[] }>();
    for (const p of ordered) {
      if (p.item.id === card?.item.id) continue;
      const cur = dotMap.get(p.at.id) ?? { at: p.at, items: [] };
      cur.items.push(p.item);
      dotMap.set(p.at.id, cur);
    }
    return { active: card, dots: [...dotMap.values()] };
  }, [agenda, agents, anchor, pinned, later, map]);
  current.current = active?.item.id ?? null;

  const activeId = busy ? null : (active?.item.id ?? null);
  useEffect(() => setActiveAgendaId(activeId), [activeId]);
  useEffect(() => () => setActiveAgendaId(null), []);

  const cam = useCamera();
  const [settled, setSettled] = useState(0);
  useEffect(() => cam?.onSettle(() => setSettled((n) => n + 1)), [cam]);
  useEffect(() => cam?.onCorner(() => setSettled((n) => n + 1)), [cam]);

  // The card's real height (card px) in each layout, once it has rendered; an estimate until then.
  const [measured, setMeasured] = useState<Record<string, number>>({});
  const onMeasure = useCallback((id: string, compact: boolean, h: number) => {
    const k = `${id}|${compact ? 1 : 0}`;
    setMeasured((m) => (m[k] !== undefined && Math.abs(m[k] - h) < 2 ? m : { ...m, [k]: h }));
  }, []);
  const opts = active?.item.options ?? [];
  const cardH = active ? (measured[`${active.item.id}|0`] ?? estimateCardH(active.item.prompt, active.item.why, opts)) : 0;
  const compactH = active ? (measured[`${active.item.id}|1`] ?? estimateCardH(active.item.prompt, active.item.why, opts, true)) : 0;
  const heightOf = (p: Placement) => (p.compact ? compactH : cardH);
  const isMeasured = (id: string, p: Placement) => measured[`${id}|${p.compact ? 1 : 0}`] !== undefined;

  // Nothing fits without covering the map: the dot stands in, and clicking it opens the card anyway.
  const [forced, setForced] = useState<string | null>(null);

  const last = useRef<{ id: string; p: Placement } | null>(null);
  const panned = useRef(new Set<string>());
  const placement = useMemo(() => {
    if (!active || !layout || busy) return null;
    // Files are things you click: a card never covers them either. Nor does it hide under the crew list.
    const crew = cam?.cornerWorld();
    const nodes = [...Object.values(layout.nodes).filter((n) => n.id !== active.at.id).map(withCaption), ...layout.tiles, ...layout.shelf, ...(crew ? [crew] : [])];
    const head = layout.frame ? [{ x: layout.frame.x, y: layout.frame.y, w: layout.frame.w, h: 72 }] : [];
    const soft: Rect[] = [...layout.stubs, ...head, ...layout.edges.flatMap((e) => (e.label ? [e.label] : []))];
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
    const force = forced === active.item.id;
    const p = place({ at: active.at, nodes, soft, lines, safe: cam?.safeWorld() ?? null, canPan, ov, h: cardH, hCompact: compactH, marginX, marginL, keep, ports, force });
    // Nothing fits while the user steers: worth another look once they let go (the camera may then make room).
    if (!p) return { p: null, ov, retry: !!cam && !panned.current.has(key) && !canPan };
    // Only a placement made at rest, at the card's real size, is worth sticking to.
    if (cam?.resting && isMeasured(active.item.id, p)) last.current = { id: key, p };
    return { p, ov, retry: false };
    // Recompute when the question, its anchor, its size or the layout changes, or the camera settles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.item.id, active?.at.id, layout, cam, settled, cardH, compactH, busy, forced]);

  // No room while the user was steering: look again once they've let go (the camera may then make room).
  const retry = !!placement?.retry;
  useEffect(() => {
    if (!cam || !retry) return;
    const t = setTimeout(() => setSettled((n) => n + 1), Math.max(200, 2600 - (performance.now() - cam.lastUserMove)));
    return () => clearTimeout(t);
  }, [cam, retry, settled]);

  // Ghosts keep clear of the card.
  const shownCard = active && placement?.p && !busy ? cardRect(active.at, placement.p, placement.ov, heightOf(placement.p)) : null;
  const cardKey = shownCard ? `${Math.round(shownCard.x)},${Math.round(shownCard.y)},${Math.round(shownCard.w)},${Math.round(shownCard.h)}` : '';
  useEffect(() => {
    useMapLocal.setState({ card: shownCard });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardKey]);
  useEffect(() => () => useMapLocal.setState({ card: null }), []);

  // A new card that can't sit fully in view where it belongs (its node is low,
  // or near an edge): ease the camera just enough, once, unless the user is steering.
  useEffect(() => {
    if (!cam || !active || !placement?.p || busy || !cam.resting) return;
    const key = `${active.item.id}@${active.at.id}`;
    if (panned.current.has(key) || !isMeasured(active.item.id, placement.p)) return;
    panned.current.add(key);
    if (performance.now() - cam.lastUserMove < 2500) return;
    const card = cardRect(active.at, placement.p, placement.ov, heightOf(placement.p));
    const to = cam.panToShow(union([card, active.at.rect]) ?? card);
    if (to) void cam.fly(to, 560);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cam, active, placement, busy, measured, cardH, compactH]);

  // A forced card is forced once: the next question places normally.
  useEffect(() => {
    if (forced && forced !== active?.item.id) setForced(null);
  }, [forced, active?.item.id]);

  const fallback = !!active && !busy && !!placement && !placement.p;

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
          data-fallback={fallback || undefined}
          data-nopan
          style={{ transform: `translate(${active.at.rect.x}px, ${active.at.rect.y}px)` }}
          title={active.item.prompt}
          onClick={(e) => {
            e.stopPropagation();
            // Open the card: centre its node with room beside it, and show it even if it has to cover something.
            setForced(active.item.id);
            // (No closer than 1×: zoomed in on a crowded map there is no room beside anything.)
            if (cam) void cam.fly(cam.centerOn(active.at.rect.x + active.at.rect.w / 2 + 160, active.at.rect.y + 90, Math.min(cam.view.k, 1)), 640);
          }}
        >
          <span className={s.ov}>
            <span className={s.dot} data-frame={active.at.frame || undefined} />
          </span>
        </button>
      )}
      <AnimatePresence>
        {active && !busy && placement?.p && <Card key={active.item.id} item={active.item} at={active.at} placement={placement.p} agents={agents} onMeasure={onMeasure} />}
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
  onMeasure: (id: string, compact: boolean, h: number) => void;
}) {
  const { side, lead, dy, dx, slide } = placement;
  const compact = !!placement.compact;
  const W = cardW(placement);
  const point = anchorPoint(at, side, dy, dx);
  const waiting = (item.blocking ?? []).map((id) => agents[id]).filter(Boolean);
  const map = useIae.getState().map;
  const where = item.nodeId && item.nodeId !== at.id ? map.nodes[item.nodeId]?.label : null;
  const options = item.options?.length ? item.options : [];

  // Report the real height so placement can keep the whole card in view.
  const cardRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const report = () => onMeasure(item.id, compact, el.offsetHeight);
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [item.id, compact, onMeasure]);

  // Offsets inside the counter-scaled overlay (card px). Mirrors questionPlace.cardRect.
  const pos =
    side === 'right'
      ? { left: lead, top: -(HEAD + slide) }
      : side === 'left'
        ? { right: lead, top: -(HEAD + slide) }
        : side === 'below'
          ? { top: lead, left: NOTCH - W + slide }
          : { bottom: lead, left: NOTCH - W + slide };

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
          data-compact={compact || undefined}
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
                title="Put it off: it comes back when it matters"
                onClick={() => useMapLocal.setState((st) => ({ later: [...st.later.filter((x) => x !== item.id), item.id], pinnedAgenda: st.pinnedAgenda === item.id ? null : st.pinnedAgenda }))}
              >
                later
              </button>
              <button type="button" className={s.close} aria-label="Drop this question" title="Drop this question" onClick={() => void bridge.dismiss(item.id)}>
                <Mark name="cross" size={11} />
              </button>
            </span>
          </div>
          {/* Compact (tight spots): the why folds into the prompt's tooltip. */}
          <p className={s.prompt} title={compact && item.why ? item.why : undefined}>
            {item.prompt}
          </p>
          {item.why && !compact && <p className={s.why}>{item.why}</p>}
          {options.length > 0 && (
            <div className={s.options}>
              {options.map((o, i) => (
                <button key={o} type="button" className={s.option} data-rec={i === 0 || undefined} title={i === 0 ? `${leadNameOf()}'s pick` : undefined} onClick={() => void bridge.answer(item.id, o)}>
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
