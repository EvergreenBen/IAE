// The right end of the intent line: a mic glyph that toggles hands-free.
// While listening (hands-free, or Space held) it becomes a three-bar meter.

import { useIae } from '../state/store';
import styles from './IntentLine.module.css';

// At rest (hands-free, nobody talking) the bars stand at a meter's silhouette;
// while someone talks they follow the voice.
const BAR_REST = [6, 10, 7];
const BAR_GAIN = [0.7, 1, 0.82];

export function MicButton({ onToggle }: { onToggle: () => void }) {
  const handsFree = useIae((s) => s.settings.voice.handsFree);
  const mic = useIae((s) => s.voice.mic);
  const level = useIae((s) => (s.voice.mic === 'hearing' ? Math.round(s.voice.level * 24) / 24 : 0));
  const hearing = mic === 'hearing';
  const meter = handsFree || hearing;
  const label = handsFree ? 'Hands-free is on. Click to turn it off.' : 'Turn on hands-free (or hold Space to talk)';

  return (
    <button type="button" className={styles.mic} data-on={handsFree || undefined} data-hearing={hearing || undefined} onClick={onToggle} aria-pressed={handsFree} aria-label={label} title={label}>
      {meter ? (
        <span className={styles.meter} aria-hidden="true">
          {BAR_GAIN.map((g, i) => (
            <span key={i} className={styles.bar} style={{ height: `${hearing ? 4 + Math.min(1, level * g * 1.25) * 12 : BAR_REST[i]}px` }} />
          ))}
        </span>
      ) : (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
          <rect x="5.75" y="1.75" width="4.5" height="8" rx="2.25" />
          <path d="M3.25 7.75a4.75 4.75 0 0 0 9.5 0M8 12.5v1.75" />
        </svg>
      )}
    </button>
  );
}
