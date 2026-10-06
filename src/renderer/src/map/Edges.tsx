// Edges of one scope: rounded orthogonal routes from ELK, small arrowheads,
// label pills (shown only when zoomed in enough — CSS reads the layer's LOD),
// and boundary stubs on the frame.
import { memo, useId, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ui } from '../state/store';
import { Mark } from './glyphs';
import type { EdgeRoute, Stub } from './layout';
import s from './Edges.module.css';

const EASE_IO = [0.65, 0, 0.35, 1] as const;
const template = (d: string) => d.replace(/-?\d+(\.\d+)?/g, '#');

interface EdgesProps {
  edges: EdgeRoute[];
  /** Node ids whose edges are emphasised (hovered / selected). */
  hot: string;
  /** Seconds to wait before drawing on a freshly shown scope. */
  delay: number;
}

function EdgesImpl({ edges, hot, delay }: EdgesProps) {
  const uid = useId().replace(/:/g, '');
  const hotSet = new Set(hot ? hot.split(',') : []);
  return (
    <>
      <svg className={s.svg} width="1" height="1" overflow="visible" aria-hidden>
        <defs>
          <marker id={`${uid}a`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto">
            <path d="M0.6 0.9 7.4 4 0.6 7.1 2 4Z" className={s.head} />
          </marker>
          <marker id={`${uid}h`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto">
            <path d="M0.6 0.9 7.4 4 0.6 7.1 2 4Z" className={s.headHot} />
          </marker>
        </defs>
        <AnimatePresence initial={false}>
          {edges.map((e) => {
            const hi = hotSet.has(e.from) || hotSet.has(e.to);
            // Edges into an outgoing stub hand over to the pill's own arrow.
            const marker = e.to.startsWith('stub:') ? undefined : `url(#${uid}${hi ? 'h' : 'a'})`;
            return <EdgePath key={`${e.id}|${template(e.d)}`} e={e} hi={hi} marker={marker} delay={delay} />;
          })}
        </AnimatePresence>
      </svg>
      {edges.map((e) =>
        e.label ? (
          <motion.div
            key={`l:${e.id}`}
            className={s.label}
            data-edge-label
            data-tier={e.label.tier}
            data-hi={hotSet.has(e.from) || hotSet.has(e.to) || undefined}
            initial={{ opacity: 0, x: e.label.x, y: e.label.y }}
            animate={{ opacity: 1, x: e.label.x, y: e.label.y }}
            transition={{ x: { duration: 0.42, ease: EASE_IO }, y: { duration: 0.42, ease: EASE_IO }, opacity: { duration: 0.3, delay: delay + 0.1 } }}
            style={{ width: e.label.w }}
          >
            {e.label.text}
          </motion.div>
        ) : null,
      )}
    </>
  );
}

function EdgePath({ e, hi, marker, delay }: { e: EdgeRoute; hi: boolean; marker?: string; delay: number }) {
  const first = useRef(true);
  const wasFirst = first.current;
  first.current = false;
  return (
    <motion.path
      className={s.edge}
      data-style={e.style}
      data-hi={hi || undefined}
      data-edge-id={e.id}
      markerEnd={marker}
      initial={{ opacity: 0, d: e.d }}
      animate={{ opacity: 1, d: e.d }}
      exit={{ opacity: 0, transition: { duration: 0.14 } }}
      transition={{ d: { duration: 0.42, ease: EASE_IO }, opacity: { duration: 0.32, delay: wasFirst ? delay + 0.12 : 0 } }}
    />
  );
}

export const Edges = memo(EdgesImpl);

// ── stubs ────────────────────────────────────────────────────────────────────

export const Stubs = memo(function Stubs({ stubs, interactive, delay }: { stubs: Stub[]; interactive: boolean; delay: number }) {
  return (
    <>
      {stubs.map((st) => (
        <motion.button
          key={st.key}
          type="button"
          className={s.stub}
          data-dir={st.dir}
          data-nopan
          tabIndex={interactive ? 0 : -1}
          title={st.dir === 'out' ? `Goes to ${st.label}` : `Comes from ${st.label}`}
          initial={{ opacity: 0, x: st.x, y: st.y }}
          animate={{ opacity: 1, x: st.x, y: st.y }}
          transition={{ x: { duration: 0.42, ease: EASE_IO }, y: { duration: 0.42, ease: EASE_IO }, opacity: { duration: 0.3, delay: delay + 0.15 } }}
          style={{ width: st.w, height: st.h }}
          onClick={(ev) => {
            ev.stopPropagation();
            ui.focus(st.target, 'show');
          }}
        >
          {st.dir === 'out' && (
            <span className={s.arrow}>
              <Mark name="arrow" size={12} />
            </span>
          )}
          <span className={s.stubLabel}>{st.label}</span>
          {st.dir === 'in' && (
            <span className={s.arrow}>
              <Mark name="arrow" size={12} />
            </span>
          )}
        </motion.button>
      ))}
    </>
  );
});
