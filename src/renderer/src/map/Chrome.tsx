// The top strip: transparent, a window drag region. Breadcrumb on the left
// (after the traffic lights) with the crew under it, then Restart (when
// Arxitect's own code changed), Auto and a faint ⌘K on the right.
import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ancestorsOf } from '@shared/map';
import { bridge } from '../bridge';
import { ui, useIae } from '../state/store';
import { AutoMode } from './AutoMode';
import { CrewPanel } from './CrewPanel';
import s from './Chrome.module.css';

export function Chrome() {
  const project = useIae((st) => st.project);
  const scopeId = useIae((st) => st.scopeId);
  const map = useIae((st) => st.map);
  const crumbs = useMemo(() => {
    if (!scopeId || !map.nodes[scopeId]) return [];
    return [...ancestorsOf(map, scopeId), map.nodes[scopeId]];
  }, [map, scopeId]);

  return (
    <>
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
          <Restart />
          <AutoMode className="no-drag" />
          <button type="button" className={`${s.palette} no-drag`} onClick={() => ui.setPalette(true)} aria-label="Open command palette">
            ⌘K
          </button>
        </div>
      </header>
      <CrewPanel />
    </>
  );
}

/** Arxitect's own main-process code changed (it's building itself): one click loads it, and nobody loses their place. */
function Restart() {
  const stale = useIae((st) => st.stale);
  const [busy, setBusy] = useState(false);
  if (!stale.length) return null;
  const files = stale.length === 1 ? stale[0] : `${stale.length} files, including ${stale[0]}`;
  return (
    <button
      type="button"
      className={`${s.restart} no-drag`}
      disabled={busy}
      title={`Changed since launch: ${files}. Builders pick up where they left off.`}
      onClick={() => {
        setBusy(true);
        bridge.restartApp().catch(() => setBusy(false));
      }}
    >
      {busy ? 'Restarting…' : 'Restart to load changes'}
    </button>
  );
}
