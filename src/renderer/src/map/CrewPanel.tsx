// The crew at a glance, top left: one row per agent at work. What it's doing
// now, a bar for how far through its plan it is, and roughly how long it has
// left. A row opens to show the plan, the files it changed (each opens the lens
// on its diff), where it's working, and Stop. A builder waiting for an OK shows
// the request here when its figure isn't on screen.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { AgentInfo, FileChange } from '@shared/model';
import { CrewMark } from '../avatar/CrewMark';
import { bridge } from '../bridge';
import { openChanges } from '../lens/control';
import { ui, useIae } from '../state/store';
import { useCamera } from './context';
import { estimate, leftText, stepText } from './crewTime';
import { usePermsOnMap } from './permHome';
import { Permission } from './Permission';
import s from './CrewPanel.module.css';

const SHOWN = new Set(['starting', 'thinking', 'working', 'waiting', 'done', 'failed']);
const QUEUED = 'Waiting for a free slot';
/** Changed files an opened row lists before "and N more". */
const SHOW_CHANGED = 8;

/** Re-renders every `ms` while `on`: the bars creep and the estimates count down. */
function useNow(on: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [on, ms]);
  return now;
}

/** Tells the camera where the list sits, so fitting keeps the map out from under it; a new arrival asks for room. */
function useCorner(count: number) {
  const ref = useRef<HTMLElement>(null);
  const cam = useCamera();
  const seen = useRef(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!cam || !el) {
      cam?.setCorner(null);
      seen.current = 0;
      return;
    }
    const report = (arrived: boolean) => {
      const r = el.getBoundingClientRect();
      cam.setCorner({ w: r.right, h: r.bottom }, arrived);
    };
    report(count > seen.current);
    seen.current = count;
    const ro = new ResizeObserver(() => report(false));
    ro.observe(el);
    return () => ro.disconnect();
  }, [cam, count]);
  useEffect(() => () => cam?.setCorner(null), [cam]);
  return ref;
}

function elapsedText(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`;
}

/** The right end of a row: how long is left, else where it is in its plan, else how long it has been going. */
function metaText(a: AgentInfo, leftMs: number | null, queued: boolean, now: number): string {
  if (a.status === 'done') return 'Done';
  if (a.status === 'failed') return 'Failed';
  if (queued) return 'Queued';
  if (leftMs !== null) return leftText(leftMs);
  return stepText(a.progress) ?? elapsedText(now - a.startedAt);
}

/** The line under a name: what it's doing, or what it needs. */
function lineText(a: AgentInfo, waiting: boolean, asking: boolean): string {
  if (a.status === 'failed') return a.result ?? 'It stopped with an error.';
  if (waiting) return asking ? 'Waiting for your OK' : 'Waiting for your answer';
  if (a.status === 'done') return a.result ?? '';
  return a.activity ?? '';
}

export function CrewPanel() {
  const agents = useIae((st) => st.agents);
  const permissions = useIae((st) => st.permissions);
  const permsOnMap = usePermsOnMap();
  const [open, setOpen] = useState<string | null>(null);
  const crew = Object.values(agents)
    .filter((a) => a.role !== 'lead' && SHOWN.has(a.status))
    .sort((a, b) => a.startedAt - b.startedAt);
  const now = useNow(crew.length > 0);
  const ref = useCorner(crew.length);
  if (!crew.length) return null;

  return (
    <section ref={ref} className={`${s.panel} no-drag`} aria-label="Crew">
      <AnimatePresence initial={false}>
        {crew.map((a) => {
          const perm = permissions.find((p) => p.agentId === a.id) ?? null;
          return (
            <motion.div
              key={a.id}
              layout="position"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, transition: { duration: 0.2 } }}
              transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
            >
              <Row agent={a} now={now} open={open === a.id} onToggle={() => setOpen((o) => (o === a.id ? null : a.id))} asking={!!perm} />
              {perm && !permsOnMap.has(a.id) && (
                <div className={s.perm}>
                  <Permission perm={perm} />
                </div>
              )}
            </motion.div>
          );
        })}
      </AnimatePresence>
    </section>
  );
}

function Row({ agent: a, now, open, onToggle, asking }: { agent: AgentInfo; now: number; open: boolean; onToggle: () => void; asking: boolean }) {
  const map = useIae((st) => st.map);
  const steps = useIae((st) => st.agentSteps[a.id]);
  const ended = a.status === 'done' || a.status === 'failed';
  const queued = a.status === 'starting' && a.activity === QUEUED;
  const waiting = asking || a.status === 'waiting';
  const est = a.status === 'done' ? { fraction: 1, leftMs: 0 } : estimate(a.progress, now);
  const where = a.nodeId ? map.nodes[a.nodeId]?.label : null;

  const meta = metaText(a, est.leftMs, queued, now);
  const line = lineText(a, waiting, asking);
  const changed = a.changes?.length ?? 0;
  // Collapsed, a row only says how many files; opened, it lists them.
  const total = changed > 0 && !open ? (changed === 1 ? '1 file' : `${changed} files`) : null;

  return (
    <div className={s.row} data-open={open || undefined} data-state={waiting ? 'waiting' : a.status}>
      <button type="button" className={s.head} onClick={onToggle} aria-expanded={open} aria-label={`${a.name}: ${a.task}. ${meta}.`}>
        <CrewMark hue={a.hue} name={a.name} size={18} state={waiting ? 'waiting' : a.status} />
        <span className={s.name}>{a.name}</span>
        <span className={s.task} title={a.task}>
          {a.task}
        </span>
        <span className={s.meta}>{meta}</span>
      </button>
      {(line || total) && (
        <p className={s.line}>
          <span className={s.lineText} title={line}>
            {line}
          </span>
          {total && <span className={s.total}>{total}</span>}
        </p>
      )}
      {a.role !== 'cartographer' && !queued && (
        <div className={s.track} aria-hidden>
          <div className={s.fill} style={{ width: `${Math.round(est.fraction * 1000) / 10}%`, background: `var(--agent-${a.hue % 6})` }} />
        </div>
      )}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            className={s.more}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            {a.progress ? (
              <ol className={s.plan}>
                {a.progress.steps.map((st, i) => (
                  <li key={i} data-done={i < a.progress!.done || undefined} data-now={(i === a.progress!.done && !ended) || undefined}>
                    {st}
                  </li>
                ))}
              </ol>
            ) : steps?.length ? (
              <ol className={s.recent}>
                {steps.slice(-4).map((st) => (
                  <li key={st.at + st.text}>{st.text}</li>
                ))}
              </ol>
            ) : null}
            {changed > 0 && <Changed changes={a.changes!} />}
            <div className={s.actions}>
              {where && (
                <button type="button" onClick={() => a.nodeId && ui.focus(a.nodeId, 'show')}>
                  Show {where}
                </button>
              )}
              {!ended && (
                <button type="button" className={s.stop} onClick={() => void bridge.stopAgent(a.id)}>
                  Stop {a.name}
                </button>
              )}
              {ended && (
                <button type="button" onClick={() => void bridge.clearAgent(a.id)}>
                  Clear
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** A file's name, with its folder when another changed file shares the name. */
function fileLabel(path: string, all: FileChange[]): string {
  const parts = path.split('/');
  const name = parts[parts.length - 1];
  const twin = all.some((c) => c.path !== path && c.path.endsWith(`/${name}`));
  return twin && parts.length > 1 ? `${parts[parts.length - 2]}/${name}` : name;
}

/** What the builder changed, newest first: each file opens the lens on its diff. */
function Changed({ changes }: { changes: FileChange[] }) {
  const shown = changes.slice(0, SHOW_CHANGED);
  const more = changes.length - shown.length;
  return (
    <div className={s.changed}>
      <p className={s.eyebrow}>Changed</p>
      <ul className={s.files}>
        {shown.map((c) => (
          <li key={c.path}>
            <button
              type="button"
              className={s.file}
              onClick={() => openChanges(c.path)}
              title={`${c.path}${c.created ? ' (new)' : ''}: show what changed`}
              aria-label={`${c.path}: ${c.added} added, ${c.removed} removed. Show what changed.`}
            >
              <span className={s.fileName}>{fileLabel(c.path, changes)}</span>
              {c.created && <span className={s.fileNew}>new</span>}
              <span className={s.counts}>
                {c.added > 0 && <span className={s.plus}>+{c.added}</span>}
                {c.removed > 0 && <span className={s.minus}>−{c.removed}</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {more > 0 && <p className={s.moreFiles}>and {more} more</p>}
    </div>
  );
}
