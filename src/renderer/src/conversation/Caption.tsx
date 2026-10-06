// The lead's words, centred above the intent line. Words fade in as they
// stream; the caption lingers ~6s after the voice stops, then fades. While the
// lead is only thinking there is no caption: Archie's face says it.
// Click opens the transcript.

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ui, useIae } from '../state/store';
import styles from './Caption.module.css';

const LINGER_MS = 6000;

function useCaption(): { text: string; turn: string } | null {
  const state = useIae((s) => s.lead.state);
  const text = useIae((s) => s.lead.text);
  const turn = useIae((s) => s.lead.turnId ?? '');
  const speaking = useIae((s) => s.voice.speaking);
  const open = useIae((s) => s.transcriptOpen);
  const [expired, setExpired] = useState<string | null>(null);

  // Once the reply is complete and the voice has stopped, linger, then go.
  const settled = state === 'idle' && !speaking;
  useEffect(() => {
    if (!settled || !text) return;
    const key = `${turn}:${text.length}`;
    const t = setTimeout(() => setExpired(key), LINGER_MS);
    return () => clearTimeout(t);
  }, [settled, text, turn]);

  if (open || state === 'thinking' || !text.trim()) return null;
  if (expired === `${turn}:${text.length}`) return null;
  return { text, turn };
}

export function Caption() {
  const caption = useCaption();
  const reduce = useReducedMotion();
  const box = useRef<HTMLButtonElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const inner = el.firstElementChild as HTMLElement | null;
    setOverflowing(!!inner && inner.scrollHeight > el.clientHeight + 1);
  }, [caption?.text]);

  const tokens = caption ? caption.text.split(/(\s+)/) : [];

  return (
    <AnimatePresence>
      {caption && (
        <motion.button
          key="caption"
          ref={box}
          type="button"
          className={styles.caption}
          data-overflow={overflowing || undefined}
          onClick={() => ui.setTranscript(true)}
          title="Open the transcript (⌘J)"
          initial={{ opacity: 0, y: reduce ? 0 : 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, transition: { duration: reduce ? 0 : 0.6 } }}
          transition={{ duration: reduce ? 0 : 0.24, ease: [0.22, 1, 0.36, 1] }}
        >
          <span className={styles.text}>
            {tokens.map((t, i) =>
              /^\s+$/.test(t) || !t ? (
                t
              ) : (
                <span key={`${caption.turn}-${i}`} className={styles.word}>
                  {t}
                </span>
              ),
            )}
          </span>
        </motion.button>
      )}
    </AnimatePresence>
  );
}
