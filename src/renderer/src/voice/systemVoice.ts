// The fallback voice: speechSynthesis with the best installed English voice.
// Speaks while Kokoro is still loading, when it can't load, or when the
// person picked the system voice. Word boundaries pulse Archie's mouth.

import { speechPulse } from './pulse';

/** How often to reset the synthesiser's watchdog while it has work queued. */
const KEEPALIVE_MS = 10_000;

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

/** What a voice reports back about one sentence. */
export interface Sink {
  start(): void;
  end(): void;
}

export class SystemVoice {
  private live = new Set<SpeechSynthesisUtterance>();
  private voices: SpeechSynthesisVoice[] = [];
  private keepAlive: ReturnType<typeof setInterval> | undefined;
  private gen = 0;

  constructor() {
    if (!this.supported) return;
    const load = () => (this.voices = speechSynthesis.getVoices());
    load();
    speechSynthesis.addEventListener?.('voiceschanged', load);
  }

  get supported(): boolean {
    return typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined';
  }

  say(text: string, opts: { voice: string; rate: number }, sink: Sink): void {
    const u = new SpeechSynthesisUtterance(text);
    const voice = pickVoice(this.voices, opts.voice);
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    }
    u.rate = opts.rate;
    const gen = this.gen;
    u.onstart = () => sink.start();
    u.onboundary = (e) => {
      if (gen === this.gen && e.name === 'word') speechPulse(Math.min(1, 0.45 + (e.charLength || 4) / 10));
    };
    const finish = () => {
      this.live.delete(u);
      if (this.live.size === 0) this.stopKeepAlive();
      sink.end();
    };
    u.onend = finish;
    u.onerror = finish;
    // Hold a reference: Chrome drops events for utterances that get garbage-collected.
    this.live.add(u);
    // A cancel() (or a stalled keep-alive ping) can leave the synthesiser
    // paused; anything queued onto it then never starts.
    if (speechSynthesis.paused) speechSynthesis.resume?.();
    speechSynthesis.speak(u);
    this.startKeepAlive();
  }

  /**
   * Chromium stops speaking after roughly fifteen seconds of a continuous run
   * and leaves the rest of the queue stuck — the voice starts, then simply
   * falls silent part-way through a reply. A pause/resume pair resets that
   * watchdog and is inaudible, so ping it while anything is still outstanding.
   */
  private startKeepAlive(): void {
    if (this.keepAlive !== undefined) return;
    this.keepAlive = setInterval(() => {
      if (this.live.size === 0) {
        this.stopKeepAlive();
        return;
      }
      if (!speechSynthesis.speaking) return;
      speechSynthesis.pause?.();
      speechSynthesis.resume?.();
    }, KEEPALIVE_MS);
  }

  private stopKeepAlive(): void {
    clearInterval(this.keepAlive);
    this.keepAlive = undefined;
  }

  cancel(): void {
    this.gen++;
    this.live.clear();
    this.stopKeepAlive();
    if (this.supported) speechSynthesis.cancel();
  }
}
