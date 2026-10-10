// Dev only: when a builder changes code the window can't hot-swap, reload at
// the next quiet moment (nobody talking, Archie not replying, nothing half
// typed) rather than cutting a conversation off. The project, its builders and
// their progress survive the reload either way (resume).
import { useIae } from './state/store';
import { tts } from './voice/tts';

const QUIET_MS = 1200;
/** Past this, reload at the next gap in the conversation even if a file is open in the lens. */
const MAX_WAIT_MS = 5 * 60_000;

let waiting = false;

function busy(sinceAsked: number): boolean {
  const s = useIae.getState();
  if (s.screen !== 'project') return false;
  const v = s.voice;
  if (v.mic === 'hearing' || v.mic === 'transcribing' || v.speaking || tts.isActive || s.lead.state !== 'idle') return true;
  const a = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
  if (a && 'value' in a && typeof a.value === 'string' && a.value.trim()) return true;
  return !!s.openFile && performance.now() - sinceAsked < MAX_WAIT_MS;
}

export function reloadWhenQuiet(): void {
  if (waiting) return;
  waiting = true;
  const asked = performance.now();
  let quietSince = performance.now();
  const timer = setInterval(() => {
    if (busy(asked)) quietSince = performance.now();
    if (document.hidden || performance.now() - quietSince >= QUIET_MS) {
      clearInterval(timer);
      location.reload();
    }
  }, 250);
}
