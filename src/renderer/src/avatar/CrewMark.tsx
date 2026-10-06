// A builder: a small member of Archie's family, tinted with the agent's hue.
// Drawn on a 20-unit grid for 14–22px. Same silhouette as Archie (pebble body,
// two claws, tall eyes) with fewer details so it stays crisp when tiny.
//
//   working   one claw ticks now and then (slow, never a loop that pulls focus)
//   thinking  eyes glance up
//   waiting   one claw raised: needs the user
//   done      content, eyes closed in a smile
//   failed    eyes down, claws lowered
//   starting / stopped   faint

import styles from './CrewMark.module.css';

export interface CrewMarkProps {
  /** AgentInfo.hue → var(--agent-{hue % 6}) */
  hue: number;
  /** Agent name; the first letter may be shown. */
  name: string;
  /** Pixel size of the mark (default 18). */
  size?: number;
  /** 'working' animates subtly; 'waiting' shows it needs the user. */
  state?: 'starting' | 'thinking' | 'working' | 'waiting' | 'done' | 'failed' | 'stopped';
}

const STATE_LABEL: Record<NonNullable<CrewMarkProps['state']>, string> = {
  starting: 'starting',
  thinking: 'thinking',
  working: 'working',
  waiting: 'waiting on you',
  done: 'done',
  failed: 'stuck',
  stopped: 'stopped',
};

export function CrewMark({ hue, name, size = 18, state = 'working' }: CrewMarkProps) {
  const tint = `var(--agent-${((hue % 6) + 6) % 6})`;
  // Desynchronise crews so several on one node never tick in unison.
  const delay = `${-((name.charCodeAt(0) || 0) % 7) * 0.9}s`;
  return (
    <svg
      className={styles.mark}
      data-state={state}
      width={size}
      height={size}
      viewBox="0 0 20 20"
      role="img"
      aria-label={`${name}, ${STATE_LABEL[state]}`}
      style={{ color: tint, animationDelay: delay }}
    >
      <g className={`${styles.arm} ${styles.armL}`} style={{ animationDelay: delay }}>
        <path className={styles.limb} d="M5 11 Q3.5 10.5 2.9 9.2" />
        <path className={styles.claw} d="M4.175 6.568 A1.8 1.8 0 1 1 2.388 5.828 L2.808 7.347 Z" />
      </g>
      <g className={`${styles.arm} ${styles.armR}`} style={{ animationDelay: delay }}>
        <path className={styles.limb} d="M15 11 Q16.5 10.5 17.1 9.2" />
        <path className={styles.claw} d="M15.825 6.568 A1.8 1.8 0 1 0 17.612 5.828 L17.192 7.347 Z" />
      </g>
      <path className={styles.body} d="M10 7.1 C13.95 7.1 16.3 9.2 16.3 12.3 C16.3 15.3 13.8 16.8 10 16.8 C6.2 16.8 3.7 15.3 3.7 12.3 C3.7 9.2 6.05 7.1 10 7.1 Z" />
      <g className={styles.eyes}>
        <ellipse className={styles.eye} cx="7.85" cy="11.6" rx="1.1" ry="1.75" />
        <ellipse className={styles.eye} cx="12.15" cy="11.6" rx="1.1" ry="1.75" />
      </g>
      <path className={styles.smile} d="M6.75 11.8 Q7.85 10.6 8.95 11.8 M11.05 11.8 Q12.15 10.6 13.25 11.8" />
    </svg>
  );
}
