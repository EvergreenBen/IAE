// Wires the voice machinery into the app while a project is open:
//   - the lead's streaming reply → speech, sentence by sentence
//   - speech audible ↔ store.voice.speaking (and a stricter VAD meanwhile)
//   - settings.voice → hands-free, speak, rate, voice
//   - the controller's hooks → the caller's conversation logic

import { useEffect, useRef } from 'react';
import { bridge } from '../bridge';
import { ui, useIae } from '../state/store';
import type { Settings } from '@shared/model';
import { voice, type VoiceHooks } from './controller';
import { speechPulse } from './pulse';
import { tts } from './tts';

export function useVoice(hooks: VoiceHooks): void {
  const latest = useRef(hooks);
  latest.current = hooks;

  useEffect(() => {
    voice.hooks = {
      onStart: () => latest.current.onStart(),
      onInterim: (t) => latest.current.onInterim(t),
      onFinal: (t) => latest.current.onFinal(t),
      onDiscard: () => latest.current.onDiscard(),
    };

    tts.onSpeaking = (on) => {
      ui.voice({ speaking: on });
      voice.setLeadSpeaking(on);
    };

    const apply = (v: Settings['voice']) => {
      tts.opts = { enabled: v.speak, rate: v.rate, voice: v.ttsVoice };
      if (!v.speak) tts.cancel();
      void voice.setHandsFree(v.handsFree);
    };
    apply(useIae.getState().settings.voice);
    const offSettings = useIae.subscribe((s, prev) => {
      if (s.settings.voice !== prev.settings.voice) apply(s.settings.voice);
    });

    const offEvents = bridge.onEvent((e) => {
      if (e.type === 'lead/delta') {
        if (tts.opts.enabled && tts.supported) {
          // Never start speaking over someone who is talking.
          if (useIae.getState().voice.mic === 'hearing') tts.muteIfNew(e.turnId);
          tts.delta(e.turnId, e.text);
        } else if (/\S/.test(e.text)) speechPulse(0.6); // no voice: the mouth follows the words
      } else if (e.type === 'lead/done') {
        // Always passed on (even empty), so a skipped turn that said nothing still clears.
        if (tts.opts.enabled && tts.supported) tts.done(e.turnId, e.text);
      } else if (e.type === 'project/opened' || e.type === 'project/closed') {
        // Nothing queued, spoken or still transcribing for the last project carries over.
        tts.reset();
        voice.reset();
        if (e.type === 'project/opened') voice.prewarmSoon();
      }
    });
    // A project is open: for people who use voice, have the speech model ready before they need it.
    voice.prewarmSoon();

    return () => {
      offEvents();
      offSettings();
      tts.cancel();
      tts.onSpeaking = () => {};
      voice.dispose();
      voice.hooks = { onStart() {}, onInterim() {}, onFinal() {}, onDiscard() {} };
      ui.voice({ mic: 'off', speaking: false, level: 0, interim: '', loadProgress: undefined, error: undefined });
    };
  }, []);
}
