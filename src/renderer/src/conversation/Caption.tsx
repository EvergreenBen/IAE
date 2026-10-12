// The lead's words, centred above the intent line. Words fade in as they are
// said (as they stream, when the voice isn't speaking them); the caption
// lingers after the voice stops (longer for longer replies), then fades. While
// the lead is only thinking there is no caption: Archie's face says it. Click
// opens the transcript.
//
// At most three lines. A reply that outgrows them shows its latest *whole*
// sentences (measured, not guessed), so the caption never starts mid-line.

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { ui, useIae } from '../state/store';
import { wordsSaid } from '../voice/said';
import { lingerMs, sentenceStarts, tokens, wordsEnd, wordStarts } from './captionText';
import styles from './Caption.module.css';

const MAX_LINES = 3;

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
    const t = setTimeout(() => setExpired(key), lingerMs(text));
    return () => clearTimeout(t);
  }, [settled, text, turn]);

  const said = useSaid(turn, text);
  const shown = said === null ? text : text.slice(0, wordsEnd(text, said));
  if (open || state === 'thinking' || !shown.trim()) return null;
  if (expired === `${turn}:${text.length}`) return null;
  return { text: shown, turn };
}

/**
 * How many of this reply's words the voice has said, or null when the voice
 * isn't speaking it (then the caption shows the words as they stream).
 * Re-renders while a chunk is being spoken, so its words appear in step.
 */
function useSaid(turn: string, text: string): number | null {
  const said = useIae((s) => s.voice.said);
  const voiced = said && said.turnId === turn && !said.done ? said : null;
  const [now, setNow] = useState(() => performance.now());
  const chunk = voiced?.chunk;
  useEffect(() => {
    if (!chunk) return;
    setNow(performance.now());
    const t = setInterval(() => {
      const at = performance.now();
      setNow(at);
      if (at > chunk.at + chunk.ms) clearInterval(t);
    }, 80);
    return () => clearInterval(t);
  }, [chunk]);
  if (!voiced) return null;
  // `text` is read so a reply that grows mid-chunk re-renders with the same count.
  return text ? wordsSaid(voiced, now) : 0;
}

interface Fit {
  turn: string;
  /** Offset of the first character shown. */
  start: number;
  /** One sentence was too long even alone: its start is trimmed to whole words. */
  cut: boolean;
  width: number;
}

/** Where the shown part of the reply starts so it fits in MAX_LINES. */
function useFit(caption: { text: string; turn: string } | null, measure: RefObject<HTMLSpanElement | null>): Fit {
  const [win, setWin] = useState<Fit>({ turn: '', start: 0, cut: false, width: 0 });
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const on = () => setWidth(window.innerWidth);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);

  useLayoutEffect(() => {
    const el = measure.current;
    if (!el || !caption) return;
    const { text, turn } = caption;
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 24;
    const fits = (s: string) => {
      el.textContent = s;
      return el.offsetHeight <= lh * MAX_LINES + 2;
    };
    const set = (start: number, cut: boolean) => {
      if (win.turn !== turn || win.start !== start || win.cut !== cut || win.width !== width) setWin({ turn, start, cut, width });
    };
    // Replies only grow, so within a turn (same window size) the start only moves forward.
    const from = win.turn === turn && win.width === width ? win.start : 0;
    const starts = sentenceStarts(text);
    for (const s of starts) {
      if (s < from) continue;
      if (fits(text.slice(s))) return set(s, false);
    }
    // Even the newest sentence alone is too long: keep its newest whole words.
    const last = starts[starts.length - 1] ?? 0;
    const ws = wordStarts(text, last);
    let lo = 0;
    let hi = Math.max(0, ws.length - 1);
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (fits(`… ${text.slice(ws[mid])}`)) hi = mid;
      else lo = mid + 1;
    }
    set(ws[lo] ?? last, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caption?.text, caption?.turn, width]);

  return caption && win.turn === caption.turn ? win : { turn: caption?.turn ?? '', start: 0, cut: false, width };
}

export function Caption() {
  const caption = useCaption();
  const reduce = useReducedMotion();
  const measure = useRef<HTMLSpanElement>(null);
  const win = useFit(caption, measure);
  const shown = caption ? tokens(caption.text).filter((t) => t.at >= win.start) : [];

  return (
    <>
      <span ref={measure} className={styles.measure} aria-hidden="true" />
      <AnimatePresence>
        {caption && (
          <motion.button
            key="caption"
            type="button"
            className={styles.caption}
            onClick={() => ui.setTranscript(true)}
            title="Open the transcript (⌘J)"
            aria-label={`${caption.text} (open the transcript)`}
            initial={{ opacity: 0, y: reduce ? 0 : 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: reduce ? 0 : 0.6 } }}
            transition={{ duration: reduce ? 0 : 0.24, ease: [0.22, 1, 0.36, 1] }}
          >
            <span className={styles.text}>
              {win.cut && <span className={styles.more}>… </span>}
              {shown.map((t, i) =>
                t.space ? (
                  i === 0 ? null : t.text
                ) : (
                  <span key={`${caption.turn}-${t.at}`} className={styles.word}>
                    {t.text}
                  </span>
                ),
              )}
            </span>
          </motion.button>
        )}
      </AnimatePresence>
    </>
  );
}
