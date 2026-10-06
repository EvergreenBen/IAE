// The human ↔ lead conversation, layered over the map at the bottom centre:
// the transcript sheet (when open), the lead's caption and the intent line.
// Everything outside those elements lets the map through (pointer-events).

import { useEffect } from 'react';
import { useIae } from '../state/store';
import { useVoice } from '../voice/useVoice';
import { Caption } from './Caption';
import { focusIntentLine, IntentLine } from './IntentLine';
import { Transcript } from './Transcript';
import { useConversationKeys } from './useConversationKeys';
import { abandon, draft, send, setSpeaking } from './utterance';
import styles from './ConversationLayer.module.css';

/** Keep the intent line focused unless the user is somewhere that needs the keyboard. */
function useKeepFocus(): void {
  useEffect(() => {
    const blocked = () => {
      const s = useIae.getState();
      return !!s.openFile || s.paletteOpen;
    };
    const reclaim = () =>
      setTimeout(() => {
        const a = document.activeElement;
        const selecting = !(window.getSelection()?.isCollapsed ?? true);
        if (!blocked() && !selecting && (!a || a === document.body)) focusIntentLine();
      }, 0);
    const onPointerUp = (e: PointerEvent) => {
      if ((e.target as Element | null)?.closest?.('[data-transcript]')) return;
      reclaim();
    };
    window.addEventListener('pointerup', onPointerUp);
    document.addEventListener('focusout', reclaim);
    const unsub = useIae.subscribe((s, p) => {
      const closed = (p.openFile && !s.openFile) || (p.paletteOpen && !s.paletteOpen) || (p.transcriptOpen && !s.transcriptOpen);
      if (closed) reclaim();
    });
    return () => {
      window.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('focusout', reclaim);
      unsub();
    };
  }, []);
}

export function ConversationLayer() {
  useConversationKeys();
  useKeepFocus();
  useVoice({
    onStart: () => setSpeaking(true),
    onInterim: (text) => draft(text),
    onFinal: (text) => {
      setSpeaking(false);
      send(text, 'voice');
    },
    onDiscard: () => {
      setSpeaking(false);
      abandon();
    },
  });

  return (
    <div className={styles.layer}>
      <Transcript />
      <div className={styles.dock}>
        <Caption />
        <IntentLine />
      </div>
    </div>
  );
}
