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
import { Mark } from './glyphs';
import s from './Crew.module.css';

const GLIDE_X = { type: 'spring', stiffness: 120, damping: 18 } as const;
const GLIDE_Y = { type: 'spring', stiffness: 96, damping: 17 } as const;

export function Crew() {
  const agents = useIae((st) => st.agents);
  const permissions = useIae((st) => st.permissions);
  const selected = useIae((st) => st.selectedNodeId);
  const anchor = useAnchorFn();

  const placed: { a: AgentInfo; at: Anchor; i: number; n: number }[] = [];
  const byAnchor = new Map<string, AgentInfo[]>();
  const anchors = new Map<string, Anchor>();
  for (const a of Object.values(agents)) {
    if (a.role === 'lead' || !a.nodeId) continue;
    const at = anchor(a.nodeId);
    if (!at) continue;
    anchors.set(at.id, at);
    byAnchor.set(at.id, [...(byAnchor.get(at.id) ?? []), a]);
  }
  for (const [id, list] of byAnchor) {
    list.sort((x, y) => x.startedAt - y.startedAt);
    list.forEach((a, i) => placed.push({ a, at: anchors.get(id)!, i, n: list.length }));
  }

  return (
    <>
      <AnimatePresence>
        {placed.map(({ a, at, i }) => (
          <Token key={a.id} agent={a} at={at} index={i} perm={permissions.find((p) => p.agentId === a.id) ?? null} />
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

const Token = memo(function Token({ agent, at, index, perm }: { agent: AgentInfo; at: Anchor; index: number; perm: PermissionRequest | null }) {
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
          <button
            type="button"
            className={s.token}
            data-nopan
            data-agent={agent.id}
            onClick={(e) => {
              e.stopPropagation();
              if (agent.nodeId) ui.select(at.frame ? null : at.id);
            }}
          >
            <CrewMark hue={agent.hue} name={agent.name} size={22} state={state} />
            <span className={s.tip}>
              <span className={s.tipName}>{agent.name}</span>
              <span className={s.tipTask}>{agent.activity ?? agent.task}</span>
            </span>
          </button>
          <AnimatePresence>{perm && index === 0 && <Permission key={perm.id} perm={perm} />}</AnimatePresence>
        </div>
      </div>
    </motion.div>
  );
});

function permissionText(p: PermissionRequest): { verb: string; code?: string } {
  const sum = p.summary.trim().replace(/\?$/, '');
  if (/^bash$/i.test(p.tool)) return { verb: 'Run', code: sum.replace(/^run\s+/i, '') };
  return { verb: sum };
}

export function Permission({ perm }: { perm: PermissionRequest }) {
  const t = permissionText(perm);
  return (
    <motion.div
      className={s.perm}
      data-nopan
      initial={{ opacity: 0, x: -4 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, transition: { duration: 0.16 } }}
      transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
      onClick={(e) => e.stopPropagation()}
    >
      <span className={s.permText}>
        {t.verb}
        {t.code && (
          <>
            {' '}
            <code className={s.code}>{t.code}</code>
          </>
        )}
        ?
      </span>
      <button type="button" className={s.allow} aria-label="Allow" title="Allow" onClick={() => void bridge.resolvePermission(perm.id, 'allow')}>
        <Mark name="check" size={12} />
      </button>
      <button type="button" className={s.deny} aria-label="Deny" title="Deny" onClick={() => void bridge.resolvePermission(perm.id, 'deny')}>
        <Mark name="cross" size={11} />
      </button>
    </motion.div>
  );
}
