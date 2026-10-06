// The whole conversation on one calm sheet (⌘J, or click the caption).
// Not chat bubbles: the lead in serif, the user in sans, times faint.

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useLayoutEffect, useRef } from 'react';
import type { TranscriptEntry } from '@shared/model';
import { ui, useIae } from '../state/store';
import { CloseIcon } from '../ui/icons';
import { onEscape } from '../ui/escape';
import styles from './Transcript.module.css';

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** Show a time only when it moves on (a new minute, or after a pause). */
function showTime(e: TranscriptEntry, prev: TranscriptEntry | undefined): boolean {
  if (!prev) return true;
  return e.at - prev.at > 120_000 || time(e.at) !== time(prev.at);
}

function Sheet() {
  const transcript = useIae((s) => s.transcript);
  const leadName = useIae((s) => s.settings.leadName || 'Archie');
  const streaming = useIae((s) => (s.lead.state === 'replying' ? s.lead.text : ''));
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => onEscape(() => (ui.setTranscript(false), true), 12), []);

  // Stay pinned to the newest line unless the user scrolled up to read.
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [transcript.length, streaming]);

  return (
    <div className={styles.sheet} data-transcript role="dialog" aria-label="Transcript">
      <header className={styles.head}>
        <span className={styles.title}>Conversation</span>
        <span className={styles.kbd}>⌘J</span>
        <button type="button" className={styles.close} onClick={() => ui.setTranscript(false)} aria-label="Close transcript">
          <CloseIcon size={14} />
        </button>
      </header>
      <div
        ref={scroller}
        className={styles.scroll}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {transcript.length === 0 && !streaming ? (
          <p className={styles.empty}>Nothing said yet. Describe what you’re building, or hold Space and say it.</p>
        ) : (
          <ol className={styles.list}>
            {transcript.map((e, i) => (
              <li key={e.id} className={styles.entry} data-who={e.who}>
                {showTime(e, transcript[i - 1]) && <time className={styles.time}>{time(e.at)}</time>}
                {e.who === 'lead' && <span className="sr-only">{leadName}: </span>}
                {e.who === 'user' && <span className="sr-only">You: </span>}
                <p className={styles.text}>{e.text}</p>
              </li>
            ))}
            {streaming && (
              <li className={styles.entry} data-who="lead" data-live>
                <p className={styles.text}>{streaming}</p>
              </li>
            )}
          </ol>
        )}
      </div>
    </div>
  );
}

export function Transcript() {
  const open = useIae((s) => s.transcriptOpen);
  const reduce = useReducedMotion();
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="transcript"
          className={styles.dock}
          initial={{ opacity: 0, y: reduce ? 0 : 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: reduce ? 0 : 6 }}
          transition={{ duration: reduce ? 0 : 0.26, ease: [0.22, 1, 0.36, 1] }}
        >
          <Sheet />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
