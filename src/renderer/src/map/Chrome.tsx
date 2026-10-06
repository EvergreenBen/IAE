// The top strip: transparent, a window drag region. Breadcrumb on the left
// (after the traffic lights), the crew and a faint ⌘K on the right.
import { useMemo } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ancestorsOf } from '@shared/map';
import { CrewMark } from '../avatar/CrewMark';
import { ui, useIae } from '../state/store';
import { resolveAnchor, useShownLayout } from './anchors';
import { AgentCard, Permission } from './Crew';
import s from './Chrome.module.css';

const LIVE = new Set(['starting', 'thinking', 'working', 'waiting', 'done']);

export function Chrome() {
  const project = useIae((st) => st.project);
  const scopeId = useIae((st) => st.scopeId);
  const map = useIae((st) => st.map);
  const agents = useIae((st) => st.agents);
  const permissions = useIae((st) => st.permissions);

  const { layout, shown, busy } = useShownLayout();
  const crumbs = useMemo(() => {
    if (!scopeId || !map.nodes[scopeId]) return [];
    return [...ancestorsOf(map, scopeId), map.nodes[scopeId]];
  }, [map, scopeId]);

  const crew = Object.values(agents)
    .filter((a) => a.role !== 'lead' && LIVE.has(a.status))
    .sort((a, b) => a.startedAt - b.startedAt);

  return (
    <header className={`${s.strip} drag-region`}>
      <nav className={s.crumbs} aria-label="Where you are">
        <button type="button" className={`${s.project} no-drag`} data-current={!crumbs.length || undefined} onClick={() => ui.setScope(null)}>
          {project?.name ?? 'Untitled'}
        </button>
        <AnimatePresence initial={false}>
          {crumbs.map((n, i) => (
            <motion.span
              key={n.id}
              className={s.crumbWrap}
              initial={{ opacity: 0, x: -4 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, transition: { duration: 0.14 } }}
              transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
            >
              <span className={s.sep} aria-hidden>
                /
              </span>
              <button type="button" className={`${s.crumb} no-drag`} data-current={i === crumbs.length - 1 || undefined} onClick={() => ui.setScope(n.id)}>
                {n.label}
              </button>
            </motion.span>
          ))}
        </AnimatePresence>
      </nav>

      <div className={s.right}>
        <div className={s.crew}>
          <AnimatePresence initial={false}>
            {crew.map((a) => {
              const perm = permissions.find((p) => p.agentId === a.id) ?? null;
              const waiting = a.status === 'waiting' || !!perm;
              const where = a.nodeId ? map.nodes[a.nodeId]?.label : null;
              // A prompt hangs off the agent's token on the map; when that token isn't in view, it hangs here.
              const onMap = !busy && !!resolveAnchor(map, layout, shown, a.nodeId);
              return (
                <motion.div
                  key={a.id}
                  className={s.member}
                  data-done={a.status === 'done' || undefined}
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: a.status === 'done' ? 0.45 : 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.8, transition: { duration: 0.2 } }}
                  transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
                >
                  <button type="button" className={`${s.memberBtn} no-drag`} onClick={() => a.nodeId && ui.focus(a.nodeId, 'show')} aria-label={`${a.name}: ${a.task}. Show where.`}>
                    <CrewMark hue={a.hue} name={a.name} size={22} state={waiting ? 'waiting' : a.status} />
                  </button>
                  {!(perm && !onMap) && <AgentCard agent={waiting && a.status !== 'waiting' ? { ...a, status: 'waiting' } : a} where={where} className={`${s.tip} no-drag`} />}
                  {perm && !onMap && (
                    <span className={`${s.permHere} no-drag`}>
                      <Permission perm={perm} />
                    </span>
                  )}
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
        <button type="button" className={`${s.palette} no-drag`} onClick={() => ui.setPalette(true)} aria-label="Open command palette">
          ⌘K
        </button>
      </div>
    </header>
  );
}
