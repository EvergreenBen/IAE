// Which face Archie wears, derived from the store. One place decides, so the
// intent line, Home and anything else that shows Archie agree.

import { useIae, type IaeState } from '../state/store';
import type { ArchieState } from './Archie';

export interface ArchieContext {
  /** The user is typing in the intent line (Archie reads along). */
  typing?: boolean;
}

/** Pure: store state → expression. Order matters: the user comes first. */
export function archieStateFrom(s: Pick<IaeState, 'voice' | 'lead' | 'agenda' | 'claude'>, ctx: ArchieContext = {}): ArchieState {
  const { mic, speaking, said } = s.voice;
  if (mic === 'hearing' || ctx.typing) return 'listening';
  // Their turn just ended: Archie shows he heard it at once, before a word comes back.
  if (mic === 'transcribing') return 'thinking';
  if (speaking) return 'speaking';
  if (s.lead.state === 'thinking') return 'thinking';
  if (s.lead.state === 'replying') {
    // The voice is still getting its first words ready: no mouth moving to words nobody hears yet.
    if (said && said.turnId === s.lead.turnId && !said.done && !said.chunk) return 'thinking';
    // Without a voice the mouth moves with the words as they stream.
    return 'speaking';
  }
  if (s.agenda.some((a) => a.status === 'open' && ((a.blocking?.length ?? 0) > 0 || a.priority >= 0.75))) return 'question';
  if (s.claude === 'unavailable') return 'away';
  return 'idle';
}

export function useArchieState(ctx: ArchieContext = {}): ArchieState {
  const typing = !!ctx.typing;
  return useIae((s) => archieStateFrom(s, { typing }));
}

/** Mic level for the listening squash, quantised so the avatar re-renders calmly. */
export function useArchieLevel(): number {
  return useIae((s) => (s.voice.mic === 'hearing' ? Math.round(s.voice.level * 20) / 20 : 0));
}

/** Builders are at work: Archie now and then glances at the map. */
export function useCrewWorking(): boolean {
  return useIae((s) => Object.values(s.agents).some((a) => a.role !== 'lead' && (a.status === 'working' || a.status === 'thinking')));
}
