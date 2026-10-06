// Quiet toasts for engine notices, bottom-right. Each leaves on its own after
// a few seconds (longer for errors) and waits while you hover it.
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { ui, useIae, type Notice } from '../state/store';
import { CloseIcon } from '../ui/icons';
import s from './Notices.module.css';

const LIFETIME = { info: 5000, warn: 6500, error: 9000 } as const;

export function Notices() {
  const notices = useIae((st) => st.notices);
  return (
    <div className={s.stack} aria-live="polite">
      <AnimatePresence initial={false}>
        {notices.slice(-3).map((n) => (
          <Toast key={n.id} notice={n} />
        ))}
      </AnimatePresence>
    </div>
  );
}

function Toast({ notice }: { notice: Notice }) {
  const [held, setHeld] = useState(false);

  useEffect(() => {
    if (held) return;
    const t = setTimeout(() => ui.dismissNotice(notice.id), LIFETIME[notice.level]);
    return () => clearTimeout(t);
  }, [held, notice.id, notice.level]);

  return (
    <motion.div
      layout
      className={`${s.toast} ${s[notice.level] ?? ''}`}
      role={notice.level === 'error' ? 'alert' : 'status'}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, transition: { duration: 0.18 } }}
      transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
    >
      <span className={s.dot} aria-hidden="true" />
      <span className={s.text}>{notice.text}</span>
      <button type="button" className={s.close} onClick={() => ui.dismissNotice(notice.id)} aria-label="Dismiss">
        <CloseIcon size={12} />
      </button>
    </motion.div>
  );
}
