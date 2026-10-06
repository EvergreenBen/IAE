// The lead's voice: speechSynthesis with the best installed English voice.
// Replies are spoken sentence by sentence as they stream, so speech starts
// after the first sentence, not after the whole reply. Word boundaries pulse
// Archie's mouth. Barge-in cancels everything at once.

import { speechPulse } from './pulse';
import { SentenceChunker, speakable } from './text';

export interface SpeakOptions {
  enabled: boolean;
  rate: number;
  /** Preferred voice name; empty → best available. */
  voice: string;
}

// Novelty voices that ship with macOS. Never pick these by default.
const NOVELTY =
  /^(albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|junior|ralph|kathy|fred|deranged|hysterical|pipe organ)\b/i;

/** Rank a voice: Premium/Enhanced/Siri first, then the good stock voices. */
export function scoreVoice(v: Pick<SpeechSynthesisVoice, 'name' | 'lang' | 'localService'>): number {
  if (!/^en([-_]|$)/i.test(v.lang)) return -1;
  if (NOVELTY.test(v.name)) return 0;
  let s = 1;
  if (/premium/i.test(v.name)) s += 100;
  else if (/enhanced/i.test(v.name)) s += 90;
  else if (/siri/i.test(v.name)) s += 80;
  if (/samantha/i.test(v.name)) s += 30;
  else if (/\bava\b/i.test(v.name)) s += 28;
  else if (/\bzoe\b/i.test(v.name)) s += 26;
  else if (/allison/i.test(v.name)) s += 24;
  if (/en[-_]us/i.test(v.lang)) s += 6;
  else if (/en[-_]gb/i.test(v.lang)) s += 4;
  if (v.localService) s += 3;
  return s;
}

export function pickVoice(voices: SpeechSynthesisVoice[], preferred: string): SpeechSynthesisVoice | null {
  if (preferred) {
    const exact = voices.find((v) => v.name === preferred);
    if (exact) return exact;
  }
  let best: SpeechSynthesisVoice | null = null;
  let bestScore = 0;
  for (const v of voices) {
    const s = scoreVoice(v);
    if (s > bestScore) {
      best = v;
      bestScore = s;
    }
  }
  return best;
}

class Speaker {
  private chunker = new SentenceChunker();
  private turnId: string | null = null;
  /** Turns the user talked over: late deltas for them are dropped. */
  private muted = new Set<string>();
  private live = new Set<SpeechSynthesisUtterance>();
  private gen = 0;
  private voices: SpeechSynthesisVoice[] = [];
  private audible = false;
  private quietTimer: ReturnType<typeof setTimeout> | undefined;
  opts: SpeakOptions = { enabled: true, rate: 1.05, voice: '' };
  /** Called when the voice becomes audible / falls silent. */
  onSpeaking: (speaking: boolean) => void = () => {};

  constructor() {
    if (!this.supported) return;
    const load = () => (this.voices = speechSynthesis.getVoices());
    load();
    speechSynthesis.addEventListener?.('voiceschanged', load);
  }

  get supported(): boolean {
    return typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined';
  }

  get speaking(): boolean {
    return this.audible;
  }

  /**
   * The person spoke up (or pressed ⌘.) before the reply in flight had begun:
   * the next turn to show up is that stale reply (the engine runs one turn at
   * a time), so it stays silent. Cleared once that turn appears, even if it
   * says nothing. 'soft' (they started talking) is lifted again if they turn
   * out to have said nothing; 'hard' (⌘.) never is.
   */
  private skipPending: false | 'soft' | 'hard' = false;

  skipPendingTurn(hard = false): void {
    if (!this.opts.enabled || !this.supported) return;
    this.skipPending = hard || this.skipPending === 'hard' ? 'hard' : 'soft';
  }

  /** They started talking but said nothing usable: a reply still on its way may speak after all. */
  releasePendingSkip(): void {
    if (this.skipPending === 'soft') this.skipPending = false;
  }

  /** A reply that would *start* now stays silent (someone is talking); one already speaking is left to barge-in. */
  muteIfNew(turnId: string): void {
    if (turnId !== this.turnId) this.muted.add(turnId);
  }

  /** Project switch: nothing queued or pending carries over. */
  reset(): void {
    this.cancel();
    this.skipPending = false;
    this.muted.clear();
    this.turnId = null;
  }

  private isMuted(turnId: string): boolean {
    if (this.muted.has(turnId)) return true;
    if (turnId !== this.turnId && this.skipPending) {
      this.skipPending = false;
      this.muted.add(turnId);
      return true;
    }
    return false;
  }

  /** A streamed piece of the lead's reply. */
  delta(turnId: string, text: string): void {
    if (this.isMuted(turnId)) return;
    if (turnId !== this.turnId) {
      this.turnId = turnId;
      this.chunker.reset();
    }
    for (const chunk of this.chunker.push(text)) this.say(chunk);
  }

  /** The reply is complete: speak what's left (or all of it, if nothing streamed). */
  done(turnId: string, text: string): void {
    if (this.isMuted(turnId)) return;
    if (turnId !== this.turnId) {
      this.turnId = turnId;
      this.chunker.reset();
      this.chunker.push(text);
    }
    for (const chunk of this.chunker.flush()) this.say(chunk);
  }

  say(raw: string): void {
    const text = speakable(raw);
    if (!text || !this.opts.enabled || !this.supported) return;
    const u = new SpeechSynthesisUtterance(text);
    const voice = pickVoice(this.voices, this.opts.voice);
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    }
    u.rate = this.opts.rate;
    const gen = this.gen;
    u.onstart = () => {
      if (gen === this.gen) this.setAudible(true);
    };
    u.onboundary = (e) => {
      if (gen === this.gen && e.name === 'word') speechPulse(Math.min(1, 0.45 + (e.charLength || 4) / 10));
    };
    const finish = () => {
      this.live.delete(u);
      if (gen === this.gen && this.live.size === 0) this.setAudible(false);
    };
    u.onend = finish;
    u.onerror = finish;
    // Hold a reference: Chrome drops events for utterances that get garbage-collected.
    this.live.add(u);
    speechSynthesis.speak(u);
  }

  /** Barge-in: stop mid-word, drop the queue, ignore the rest of this turn. */
  cancel(): void {
    this.gen++;
    if (this.turnId) this.muted.add(this.turnId);
    if (this.muted.size > 20) this.muted = new Set([...this.muted].slice(-10));
    this.chunker.reset();
    this.live.clear();
    if (this.supported) speechSynthesis.cancel();
    clearTimeout(this.quietTimer);
    if (this.audible) {
      this.audible = false;
      this.onSpeaking(false);
    }
  }

  private setAudible(on: boolean): void {
    clearTimeout(this.quietTimer);
    if (on) {
      if (!this.audible) {
        this.audible = true;
        this.onSpeaking(true);
      }
      return;
    }
    // A short grace so the gap between two sentences doesn't flicker.
    this.quietTimer = setTimeout(() => {
      if (this.live.size === 0 && this.audible) {
        this.audible = false;
        this.onSpeaking(false);
      }
    }, 160);
  }
}

export const tts = new Speaker();
