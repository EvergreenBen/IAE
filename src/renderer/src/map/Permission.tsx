// A builder asking to do something: "Run `npm install fastify`?" with ✓ and ✕.
// The command shows without the builder's `cd <project> &&` prefix and with long
// paths shortened; the whole command is in the tooltip, and a click on it
// expands the pill. On the map the pill keeps itself on screen.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { bridge } from '../bridge';
import type { PermissionRequest } from '../state/store';
import { CONVERSATION_ZONE, SAFE } from './camera';
import { useCamera } from './context';
import { Mark } from './glyphs';
import { permissionText } from './permText';
import s from './Crew.module.css';

/** Nudge an element (in a scaled overlay) back inside the safe viewport; recheck when the camera rests. */
function useKeepInView(ref: React.RefObject<HTMLElement | null>, on: boolean, deps: unknown[]) {
  const cam = useCamera();
  const [tick, setTick] = useState(0);
  useEffect(() => cam?.onSettle(() => setTick((n) => n + 1)), [cam]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.translate = '';
    if (!on) return;
    const r = el.getBoundingClientRect();
    const scale = el.offsetWidth ? r.width / el.offsetWidth : 1;
    const x0 = SAFE.side;
    const x1 = window.innerWidth - SAFE.side;
    const y0 = SAFE.top;
    const y1 = window.innerHeight - CONVERSATION_ZONE;
    let dx = 0;
    let dy = 0;
    if (r.right > x1) dx = x1 - r.right;
    if (r.left + dx < x0) dx = x0 - r.left;
    // Pushed back over its token: lift it above the token (clear of the node too), or below when there's no room above.
    if (dx < -2) dy = r.top - (r.height + 4 * scale) >= y0 ? -(r.height + 4 * scale) : r.height + 4 * scale;
    if (r.bottom + dy > y1) dy = y1 - r.bottom;
    if (r.top + dy < y0) dy = y0 - r.top;
    if (dx || dy) el.style.translate = `${dx / scale}px ${dy / scale}px`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, on, ...deps]);
}

export function Permission({ perm, keepInView = false }: { perm: PermissionRequest; keepInView?: boolean }) {
  const t = permissionText(perm.tool, perm.summary, perm.detail);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const long = !!t.full && (t.full !== t.code || t.full.length > 30);
  useKeepInView(ref, keepInView, [open, perm.id]);
  return (
    <motion.div
      ref={ref}
      className={s.perm}
      data-open={open || undefined}
      data-nopan
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.16 } }}
      transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
      onClick={(e) => e.stopPropagation()}
    >
      <span className={s.permText} title={t.full}>
        {t.verb}
        {t.code && (
          <>
            {' '}
            {long ? (
              <button type="button" className={s.code} onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={open ? 'Show less' : 'Show the whole command'}>
                {open ? t.full : t.code}
              </button>
            ) : (
              <code className={s.code}>{t.code}</code>
            )}
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
