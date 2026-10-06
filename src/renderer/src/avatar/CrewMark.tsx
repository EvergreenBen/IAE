// PLACEHOLDER — the avatar module replaces this with a tiny Archie-family
// creature. Keep the props stable: the map renders crew with it.
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

export function CrewMark({ hue, name, size = 18 }: CrewMarkProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" aria-label={name}>
      <circle cx="9" cy="9" r="8" fill={`var(--agent-${hue % 6})`} />
      <text x="9" y="12.5" textAnchor="middle" fontSize="9" fontWeight="600" fill="white" fontFamily="var(--font-ui)">
        {name.slice(0, 1)}
      </text>
    </svg>
  );
}
