// Archie: the lead's companion. A small, round clay creature with two raised
// claws and two tall ink eyes. Hand-authored SVG on a 40-unit grid, so it is
// pixel-true at 40px (intent line) and scales cleanly to 96px (home).
//
// Expressions are small and physical (docs/DESIGN.md §6):
//   idle       still; blinks every 3–6s; eyes drift toward the cursor
//   listening  leans toward the input, eyes widen, body squashes with mic level
//   thinking   eyes glance up and aside, one claw taps slowly
//   speaking   a small mouth opens and closes with the speech
//   question   one claw raised, like a hand
//   away       eyes closed, claws lowered

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useIae } from '../state/store';
import { onSpeechPulse } from '../voice/pulse';
import styles from './Archie.module.css';

export type ArchieState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'question' | 'away';

export interface ArchieProps {
  /** Pixel size (square). 40 on the intent line, 96 on Home. */
  size?: number;
  state?: ArchieState;
  /** 0..1 mic level, used while listening. */
  level?: number;
  /** Client coordinates to look at. Defaults to following the cursor. */
  lookAt?: { x: number; y: number } | null;
  /** The crew is working: now and then Archie glances up at the map. */
  glance?: boolean;
  className?: string;
  title?: string;
}

const LABEL: Record<ArchieState, string> = {
  idle: 'here',
  listening: 'listening',
  thinking: 'thinking',
  speaking: 'speaking',
  question: 'has a question for you',
  away: 'away',
};

/** Fixed gaze per state, in viewBox units; null → follow the cursor. */
const GAZE: Partial<Record<ArchieState, [number, number]>> = {
  listening: [1.5, 0.5],
  thinking: [-1.5, -1.9],
  away: [0, 0.6],
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** A small D-shaped mouth: flat top, round bottom; `open` 0..1. */
function mouthPath(open: number): string {
  const w = 1.75 + open * 0.25;
  const h = 0.45 + open * 1.6;
  return `M${(20 - w).toFixed(2)} 28.2 A${w.toFixed(2)} ${h.toFixed(2)} 0 0 0 ${(20 + w).toFixed(2)} 28.2 Z`;
}

function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function Archie({ size = 40, state = 'idle', level = 0, lookAt, glance = false, className, title }: ArchieProps) {
  const root = useRef<SVGSVGElement>(null);
  const mouth = useRef<SVGPathElement>(null);
  const [blink, setBlink] = useState(false);

  // Blink every 3–6s; now and then a double blink.
  useEffect(() => {
    if (state === 'away') return;
    let t: ReturnType<typeof setTimeout>;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const once = (delay: number) => {
      timers.push(setTimeout(() => setBlink(true), delay));
      timers.push(setTimeout(() => setBlink(false), delay + 130));
    };
    const schedule = () => {
      t = setTimeout(
        () => {
          once(0);
          if (Math.random() < 0.18) once(260);
          schedule();
        },
        3000 + Math.random() * 3000,
      );
    };
    schedule();
    return () => {
      clearTimeout(t);
      timers.forEach(clearTimeout);
      setBlink(false);
    };
  }, [state]);

  // Gaze: fixed per state, else toward lookAt / the cursor, with an occasional
  // glance at the map while the crew works. Written straight to CSS variables
  // so pointer moves never re-render React.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const set = (x: number, y: number) => {
      el.style.setProperty('--ex', x.toFixed(2));
      el.style.setProperty('--ey', y.toFixed(2));
    };
    const fixed = GAZE[state];
    if (fixed) {
      set(fixed[0], fixed[1]);
      return;
    }
    const toward = (px: number, py: number) => {
      const r = el.getBoundingClientRect();
      const dx = px - (r.left + r.width / 2);
      const dy = py - (r.top + r.height / 2);
      const d = Math.hypot(dx, dy) || 1;
      const reach = clamp(d / 260, 0, 1);
      set((dx / d) * 1.5 * reach, (dy / d) * 1.1 * reach);
    };
    if (lookAt) {
      toward(lookAt.x, lookAt.y);
      return;
    }
    let raf = 0;
    let last: { x: number; y: number } | null = null;
    let glancing = false;
    const onMove = (e: PointerEvent) => {
      last = { x: e.clientX, y: e.clientY };
      if (raf || glancing) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (last && !glancing) toward(last.x, last.y);
      });
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    let gt: ReturnType<typeof setTimeout> | undefined;
    if (glance) {
      const look = () => {
        gt = setTimeout(
          () => {
            glancing = true;
            set(Math.random() < 0.5 ? -1.3 : 1.3, -1.6);
            gt = setTimeout(() => {
              glancing = false;
              if (last) toward(last.x, last.y);
              else set(0, 0);
              look();
            }, 1400);
          },
          7000 + Math.random() * 6000,
        );
      };
      look();
    }
    return () => {
      window.removeEventListener('pointermove', onMove);
      cancelAnimationFrame(raf);
      clearTimeout(gt);
    };
  }, [state, lookAt?.x, lookAt?.y, glance]); // eslint-disable-line react-hooks/exhaustive-deps

  // Mouth: opens on each spoken word (speech boundary pulses), decays between
  // them. Without pulses for a moment, a soft syllable rhythm takes over.
  useEffect(() => {
    const m = mouth.current;
    if (!m || state !== 'speaking') return;
    const reduce = reducedMotion();
    let open = 0.55;
    let target = 0.55;
    let lastPulse = performance.now();
    let nextSoft = 0;
    let raf = 0;
    const off = onSpeechPulse((strength) => {
      lastPulse = performance.now();
      target = clamp(0.45 + strength * 0.55, 0.3, 1);
    });
    const frame = (now: number) => {
      if (!reduce) {
        if (now - lastPulse > 380 && now > nextSoft) {
          target = 0.35 + Math.random() * 0.6;
          nextSoft = now + 140 + Math.random() * 120;
        }
        open += (target - open) * 0.45;
        target *= 0.86;
      } else open = 0.5;
      m.setAttribute('d', mouthPath(open));
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      off();
      cancelAnimationFrame(raf);
      m.setAttribute('d', mouthPath(0));
    };
  }, [state]);

  const lv = state === 'listening' ? clamp(level, 0, 1) : 0;
  const cls = [styles.archie, className].filter(Boolean).join(' ');
  const leadName = useIae((st) => st.settings.leadName || 'Archie');

  return (
    <svg
      ref={root}
      className={cls}
      data-state={state}
      data-blink={blink || undefined}
      style={{ '--lv': lv.toFixed(3) } as CSSProperties}
      width={size}
      height={size}
      viewBox="0 0 40 40"
      role="img"
      aria-label={title ?? `${leadName}, ${LABEL[state]}`}
    >
      <g className={styles.lean}>
        <g className={styles.squash}>
          {/* feet */}
          <rect className={styles.foot} x="12.4" y="31.2" width="4.2" height="4.4" rx="2" />
          <rect className={styles.foot} x="23.4" y="31.2" width="4.2" height="4.4" rx="2" />

          {/* claws: shoulder → wrist, then a little pincer opening upward */}
          <g className={`${styles.arm} ${styles.armL}`}>
            <path className={styles.limb} d="M10 22 Q7 21 5.8 18.4" />
            <path className={styles.claw} d="M8.349 13.135 A3.6 3.6 0 1 1 4.775 11.655 L5.615 14.694 Z" />
          </g>
          <g className={`${styles.arm} ${styles.armR}`}>
            <path className={styles.limb} d="M30 22 Q33 21 34.2 18.4" />
            <path className={styles.claw} d="M31.651 13.135 A3.6 3.6 0 1 0 35.225 11.655 L34.385 14.694 Z" />
          </g>

          {/* body: a wide, soft pebble */}
          <path className={styles.body} d="M20 14.2 C27.9 14.2 32.6 18.4 32.6 24.6 C32.6 30.6 27.6 33.6 20 33.6 C12.4 33.6 7.4 30.6 7.4 24.6 C7.4 18.4 12.1 14.2 20 14.2 Z" />

          {/* face */}
          <g className={styles.gaze}>
            <g className={styles.eyes}>
              <g className={styles.eye}>
                <ellipse className={styles.pupil} cx="15.7" cy="23" rx="1.95" ry="3.45" />
                <circle className={styles.glint} cx="16.3" cy="21.45" r="0.7" />
              </g>
              <g className={styles.eye}>
                <ellipse className={styles.pupil} cx="24.3" cy="23" rx="1.95" ry="3.45" />
                <circle className={styles.glint} cx="24.9" cy="21.45" r="0.7" />
              </g>
            </g>
            <path ref={mouth} className={styles.mouth} d={mouthPath(0)} />
          </g>
        </g>
      </g>
    </svg>
  );
}
