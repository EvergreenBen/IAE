// Builders on the map: a token docked at the top-right of the node each one is
// working in (lifted to what's visible), gliding when it moves. Activity reads
// beneath the node when zoomed in; permission prompts hang off the token.
import { memo } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { AgentInfo } from '@shared/model';
import { CrewMark } from '../avatar/CrewMark';
import { bridge } from '../bridge';
import { ui, useIae, type PermissionRequest } from '../state/store';
import { useAnchorFn, type Anchor } from './anchors';
import { useCamera } from './context';
import { clamp, overlaps, type Rect } from './geometry';
import { useMapLocal } from './mapStore';
import { tokenPoint, tokensByAnchor, usePermsOnMap } from './permHome';
import { Permission } from './Permission';
import s from './Crew.module.css';

const GLIDE_X = { type: 'spring', stiffness: 120, damping: 18 } as const;
const GLIDE_Y = { type: 'spring', stiffness: 96, damping: 17 } as const;

export function Crew() {
  const agents = useIae((st) => st.agents);
  const permissions = useIae((st) => st.permissions);
  const selected = useIae((st) => st.selectedNodeId);
  const anchor = useAnchorFn();

  const groups = tokensByAnchor(Object.values(agents), anchor);
  const byAnchor = new Map([...groups].map(([id, g]) => [id, g.list]));
  const anchors = new Map([...groups].map(([id, g]) => [id, g.at]));
  const placed = [...groups.values()].flatMap(({ at, list }) => list.map((a, i) => ({ a, at, i })));
  // A prompt hangs off its token while the token is on screen; otherwise it shows in the chrome (permHome.ts).
  const onMap = usePermsOnMap();

  // A token's hover card opens above it, unless the question card is there: then below, so "Stop" stays in reach.
  const card = useMapLocal((st) => st.card);
  const cam = useCamera();
  const k = cam?.view.k ?? 1;
  const ov = clamp(k, 0.8, 1.2) / k;
  const tipBelow = (at: Anchor, i: number) => {
    if (!card) return false;
    const p = tokenPoint(at, i, ov);
    const tip: Rect = { x: p.x - 140 * ov, y: p.y - 120 * ov, w: 280 * ov, h: 110 * ov };
    return overlaps(tip, card);
  };

  return (
    <>
      <AnimatePresence>
        {placed.map(({ a, at, i }) => (
          <Token key={a.id} agent={a} at={at} index={i} perm={onMap.has(a.id) ? (permissions.find((p) => p.agentId === a.id) ?? null) : null} below={tipBelow(at, i)} />
        ))}
      </AnimatePresence>
      {[...byAnchor.entries()].map(([id, list]) => {
        const at = anchors.get(id)!;
        if (at.frame) return null;
        const lines = list.filter((a) => a.activity && a.status !== 'done');
        if (!lines.length) return null;
        return (
          <div
            key={`act:${id}`}
            className={s.activity}
            data-selected={selected === id || undefined}
            style={{ transform: `translate(${at.rect.x + 14}px, ${at.rect.y + at.rect.h + 9}px)`, width: Math.max(at.rect.w, 260) }}
          >
            {lines.map((a) => (
              <div key={a.id} className={s.line}>
                <span className={s.dot} style={{ background: `var(--agent-${a.hue % 6})` }} />
                <span className={s.text}>{a.activity}</span>
              </div>
            ))}
          </div>
        );
      })}
    </>
  );
}

const Token = memo(function Token({ agent, at, index, perm, below }: { agent: AgentInfo; at: Anchor; index: number; perm: PermissionRequest | null; below: boolean }) {
  // Dock on the top edge, inset from the right corner. Frames dock lower, beside the title row.
  const x = at.rect.x + at.rect.w - (at.frame ? 30 : 18);
  const y = at.rect.y + (at.frame ? 36 : 0);
  const state = perm ? 'waiting' : agent.status;
  return (
    <motion.div
      className={s.anchor}
      initial={{ x, y, opacity: 0 }}
      animate={{ x, y, opacity: agent.status === 'done' ? 0.55 : 1 }}
      exit={{ opacity: 0, transition: { duration: 0.24 } }}
      transition={{ x: GLIDE_X, y: GLIDE_Y, opacity: { duration: 0.3 } }}
    >
      <div className={s.ov}>
        <div className={s.slot} style={{ transform: `translate(${-11 - index * 24}px, -11px)` }}>
          <div className={s.agent} data-nopan>
            <button
              type="button"
              className={s.token}
              data-agent={agent.id}
              aria-label={`${agent.name}: ${agent.activity ?? agent.task}`}
              onClick={(e) => {
                e.stopPropagation();
                if (agent.nodeId) ui.select(at.frame ? null : at.id);
              }}
            >
              <CrewMark hue={agent.hue} name={agent.name} size={22} state={state} />
            </button>
            <AgentCard agent={agent} className={s.tip} below={below} />
          </div>
          <AnimatePresence>{perm && <Permission key={perm.id} perm={perm} keepInView />}</AnimatePresence>
        </div>
      </div>
    </motion.div>
  );
});

/**
 * What a builder is doing, and a quiet way to stop it. Shown on hover (or
 * keyboard focus) of its token, on the map and in the chrome.
 */
export function AgentCard({ agent, where, className, below }: { agent: AgentInfo; where?: string | null; className?: string; below?: boolean }) {
  const live = agent.status !== 'done' && agent.status !== 'failed' && agent.status !== 'stopped';
  const doing = agent.status === 'waiting' ? 'Waiting on you' : agent.status === 'done' ? (agent.result ?? 'Done') : agent.task;
  return (
    <span className={`${s.card} ${className ?? ''}`} data-below={below || undefined} onClick={(e) => e.stopPropagation()}>
      <span className={s.tipName}>
        {agent.name}
        {where && <span className={s.tipWhere}> · {where}</span>}
      </span>
      <span className={s.tipTask}>{doing}</span>
      {live && agent.activity && agent.activity !== agent.task && <span className={s.tipActivity}>{agent.activity}</span>}
      {live && (
        <button type="button" className={s.stop} onClick={() => void bridge.stopAgent(agent.id)}>
          Stop {agent.name}
        </button>
      )}
    </span>
  );
}
