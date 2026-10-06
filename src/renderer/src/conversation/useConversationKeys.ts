// Conversation keys, on window (capture phase, so Space never types itself):
//
//   ⌘J      transcript
//   ⌘.      interrupt the lead (stops the voice and the reply in flight)
//   Space   push-to-talk, held. Outside text fields it starts at once. In the
//           intent line it counts only when the line is empty and Space is
//           held ≥ 200ms, so typing spaces is never affected. Text fields,
//           CodeMirror, the lens and the palette are left alone.

import { useEffect } from 'react';
import { ui, useIae } from '../state/store';
import { isMod } from '../ui/escape';
import { voice } from '../voice/controller';
import { focusIntentLine, INTENT_INPUT } from './IntentLine';

const HOLD_MS = 200;
const TEXT_INPUTS = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number', '']);

type Where = 'intent-empty' | 'editable' | 'free';

function whereIsFocus(el: Element | null): Where {
  if (!el || el === document.body || el === document.documentElement) return 'free';
  if (el.hasAttribute(INTENT_INPUT)) return (el as HTMLInputElement).value === '' ? 'intent-empty' : 'editable';
  if (el instanceof HTMLInputElement) return TEXT_INPUTS.has(el.type) ? 'editable' : 'free';
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return 'editable';
  if ((el as HTMLElement).isContentEditable || el.closest('.cm-editor, [contenteditable="true"]')) return 'editable';
  return 'free';
}

export function useConversationKeys(): void {
  useEffect(() => {
    let armTimer: ReturnType<typeof setTimeout> | undefined;
    let armed = false;
    let held = false;

    const disarm = () => {
      clearTimeout(armTimer);
      armed = false;
    };
    const release = () => {
      disarm();
      if (held) {
        held = false;
        voice.pttUp();
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const s = useIae.getState();

      if (isMod(e) && !e.altKey && !e.shiftKey) {
        if (e.key === 'j' || e.key === 'J') {
          // The lens and palette sit above the transcript: ⌘J there would open a sheet Esc can't see.
          if (s.paletteOpen || s.openFile) return;
          e.preventDefault();
          ui.setTranscript(!s.transcriptOpen);
          if (s.transcriptOpen) focusIntentLine();
          return;
        }
        if (e.key === '.') {
          e.preventDefault();
          voice.bargeIn(true);
          return;
        }
      }

      if (e.code !== 'Space') {
        // Another key during the hold window means they are typing, not talking.
        if (armed) disarm();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.repeat) {
        if (armed || held) {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
      if (s.openFile || s.paletteOpen) return;
      const where = whereIsFocus(document.activeElement);
      if (where === 'editable') return;

      e.preventDefault();
      e.stopPropagation();
      if (where === 'free') {
        held = true;
        void voice.pttDown();
        return;
      }
      armed = true;
      voice.warm();
      armTimer = setTimeout(() => {
        armed = false;
        held = true;
        void voice.pttDown();
      }, HOLD_MS);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || (!held && !armed)) return;
      e.preventDefault();
      e.stopPropagation();
      release();
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', release);
      release();
    };
  }, []);
}
