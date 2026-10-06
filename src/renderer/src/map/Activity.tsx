// Motion that means something happened: a soft bloom when an agent touches a
// file under a node, a single dot along an edge when work moves between nodes,
// a brief accent ring when the lead points at something. Nothing loops.
import { useEffect, useRef, useState } from 'react';
import { ownerOf } from '@shared/map';
import { useIae } from '../state/store';
import { useAnchorFn, useShownLayout } from './anchors';
import { roundedPath, type Rect } from './geometry';
import { useMapLocal } from './mapStore';
import s from './Activity.module.css';

interface Bloom {
  id: number;
  rect: Rect;
  hue: number;
  frame: boolean;
}
interface Travel {
  id: number;
  d: string;
  hue: number;
}

const BLOOM_GAP = 1400;
let seq = 0;

export function Activity() {
  const touches = useIae((st) => st.touches);
  const anchor = useAnchorFn();
  const { layout, busy } = useShownLayout();
  const [blooms, setBlooms] = useState<Bloom[]>([]);
  const [travels, setTravels] = useState<Travel[]>([]);
  const seen = useRef(Date.now());
  const lastBloom = useRef(new Map<string, number>());
  const lastNode = useRef(new Map<string, string>());

  useEffect(() => {
    // Only touches that happened while we were watching.
    const fresh = touches.filter((t) => t.at > seen.current);
    if (!fresh.length) return;
    seen.current = Math.max(...fresh.map((t) => t.at));
    if (busy) return;
    const st = useIae.getState();
    const now = performance.now();
    const addB: Bloom[] = [];
    const addT: Travel[] = [];
    for (const t of fresh) {
      const owner = st.files.find((f) => f.path === t.path)?.nodeId ?? ownerOf(st.map, t.path);
      const at = anchor(owner);
      const agent = st.agents[t.agentId];
      if (!at || !agent) continue;
      const prev = lastNode.current.get(t.agentId);
      lastNode.current.set(t.agentId, at.id);
      if ((lastBloom.current.get(at.id) ?? 0) + BLOOM_GAP < now) {
        lastBloom.current.set(at.id, now);
        addB.push({ id: ++seq, rect: at.rect, hue: agent.hue, frame: at.frame });
      }
      if (prev && prev !== at.id && layout) {
        const e = layout.edges.find((x) => (x.from === prev && x.to === at.id) || (x.from === at.id && x.to === prev));
        if (e) addT.push({ id: ++seq, d: e.from === prev ? e.d : roundedPath([...e.pts].reverse(), 10), hue: agent.hue });
      }
    }
    if (addB.length) setBlooms((b) => [...b, ...addB]);
    if (addT.length) setTravels((t) => [...t, ...addT]);
    // touches is the only trigger; anchor/layout are read fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [touches]);

  return (
    <>
      {blooms.map((b) => (
        <div
          key={b.id}
          className={s.bloom}
          data-frame={b.frame || undefined}
          style={{ transform: `translate(${b.rect.x}px, ${b.rect.y}px)`, width: b.rect.w, height: b.rect.h, ['--hue' as string]: `var(--agent-${b.hue % 6})` }}
          onAnimationEnd={() => setBlooms((all) => all.filter((x) => x.id !== b.id))}
        />
      ))}
      {travels.map((t) => (
        <div
          key={t.id}
          className={s.travel}
          style={{ offsetPath: `path("${t.d}")`, ['--hue' as string]: `var(--agent-${t.hue % 6})` }}
          onAnimationEnd={() => setTravels((all) => all.filter((x) => x.id !== t.id))}
        />
      ))}
      <Highlight />
    </>
  );
}

function Highlight() {
  const hl = useMapLocal((st) => st.highlight);
  const anchor = useAnchorFn();
  if (!hl) return null;
  const at = anchor(hl.id);
  if (!at) return null;
  // Positioned with left/top: the ring's own animation owns `transform` (a CSS
  // animation overrides an inline transform, which would pin it to the origin).
  return (
    <div
      key={hl.seq}
      className={s.highlight}
      data-frame={at.frame || undefined}
      style={{ left: at.rect.x, top: at.rect.y, width: at.rect.w, height: at.rect.h }}
      onAnimationEnd={() => useMapLocal.setState({ highlight: null })}
    />
  );
}
