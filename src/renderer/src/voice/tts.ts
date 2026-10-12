// The lead's voice. Replies are spoken sentence by sentence as they stream, so
// speech starts after the first sentence, not after the whole reply. Barge-in
// cancels everything at once.
//
// Archie has one voice. Kokoro, running on this machine (kokoro.ts), is it;
// the system voice (systemVoice.ts) speaks only when the person picked it or
// Kokoro can't run at all. A reply that starts while Kokoro is still loading
// waits for it. If the wait runs long, that reply stays on screen and silent
// rather than switching to another voice.
//
// Two notions of "talking": audible (sound is coming out right now: the mouth,
// the avatar) and active (a reply is under way, including the gaps between its
// sentences: the mic listens differently for all of it).

import type { Settings } from '@shared/model';
import { ClipPlayer } from './clipPlayer';
import { kokoro } from './kokoro';
import { DEFAULT_KOKORO_VOICE, voiceChoice, type VoiceChoice } from './kokoroConfig';
import { SystemVoice, type Sink } from './systemVoice';
import { SentenceChunker, speakable } from './text';
import { turnTrace } from './trace';

export interface SpeakOptions {
  enabled: boolean;
  rate: number;
  /** settings.voice.ttsVoice: a Kokoro voice id, 'system', or a system voice's name. Empty → the default. */
  voice: string;
}

/** How long a reply waits for Kokoro to finish loading. Longer than that and it is stale: it stays silent. */
const KOKORO_WAIT_MS = 12_000;
/** After the system voice stops, the room still carries it this long (no echo reference for it). */
const SYSTEM_TAIL_MS = 350;
/** A finished sentence with nothing after it for this long is spoken without waiting for more. */
const SETTLE_MS = 250;

/** settings.voice → how replies are spoken. */
export const speakOptions = (v: Settings['voice']): SpeakOptions => ({ enabled: v.speak, rate: v.rate, voice: v.ttsVoice });

type Engine = 'kokoro' | 'system';

interface Line {
  text: string;
  choice: VoiceChoice;
  rate: number;
}

const kokoroVoice = (c: VoiceChoice) => (c.engine === 'kokoro' ? c.voice : DEFAULT_KOKORO_VOICE);

export class Speaker {
  /** A short first chunk: Kokoro takes about 12ms per character, so a 40-character opening is heard ~0.4s sooner than a whole sentence. */
  private chunker = new SentenceChunker(120, 48);
  private turnId: string | null = null;
  /** Turns the user talked over: late deltas for them are dropped. */
  private muted = new Set<string>();
  private gen = 0;
  /** Sentences handed to a voice that haven't finished yet. */
  private outstanding = 0;
  /** The voice of the current run of speech. Chosen afresh once nothing is outstanding. */
  private engine: Engine | null = null;
  /** Sentences waiting for Kokoro to finish loading, in order. */
  private held: Line[] = [];
  private audible = false;
  private quietTimer: ReturnType<typeof setTimeout> | undefined;
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private system = new SystemVoice();
  private player = new ClipPlayer();
  opts: SpeakOptions = { enabled: true, rate: 1.05, voice: '' };
  /** Called when the voice becomes audible / falls silent. */
  onSpeaking: (speaking: boolean) => void = () => {};
  /** Called when a reply's voice gets under way, and once all of it has been said (or cut off). */
  onActive: (active: boolean) => void = () => {};
  private active = false;
  /** The turn whose sentences are being spoken and whose end hasn't arrived yet. */
  private openTurn: string | null = null;
  /** The voice of the reply under way (kept through the gaps between sentences). */
  private activeEngine: Engine | null = null;
  /** The system voice's tail still rings in the room until then (performance.now() ms). */
  private systemTailUntil = 0;

  get supported(): boolean {
    return this.system.supported || kokoro.supported;
  }

  get speaking(): boolean {
    return this.audible;
  }

  get isActive(): boolean {
    return this.active;
  }

  /**
   * How loud Archie is around `now` (performance.now() ms), for telling his
   * echo from a person: null when that can't be known (the system voice plays
   * outside the page).
   */
  echoAt(now: number): number | null {
    if (this.activeEngine === 'system' && (this.active || this.audible)) return null;
    if (performance.now() < this.systemTailUntil) return null;
    return this.player.levelAt(now);
  }

  /** Dip the voice while the mic decides whether someone is talking over it. */
  duck(on: boolean): void {
    this.player.duck(on);
  }

  private setActive(on: boolean): void {
    if (on === this.active) return;
    this.active = on;
    if (!on) {
      if (this.activeEngine === 'system') this.systemTailUntil = performance.now() + SYSTEM_TAIL_MS;
      this.activeEngine = null;
    }
    this.onActive(on);
  }

  /** Nothing left to say and nothing more coming: the reply is over. */
  private settle(): void {
    if (this.outstanding === 0 && !this.held.length && this.openTurn === null) this.setActive(false);
  }

  /** Load Kokoro now (it runs in a worker), so it is ready before the first reply needs it. */
  prewarm(): void {
    const choice = voiceChoice(this.opts.voice);
    if (!this.opts.enabled || choice.engine !== 'kokoro' || !kokoro.supported) return;
    void kokoro.load(choice.voice);
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

  /**
   * A reply that would *start* now stays silent (someone is talking); one
   * already speaking is left to barge-in. That reply is the stale one a
   * pending skip was waiting for, so the skip is used up: the answer to what
   * they're saying now must still be heard.
   */
  muteIfNew(turnId: string): void {
    if (turnId === this.turnId || this.muted.has(turnId)) return;
    this.muted.add(turnId);
    this.skipPending = false;
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
    for (const chunk of this.chunker.push(text)) {
      this.openTurn = turnId;
      this.say(chunk);
    }
    // A sentence that ends right where the stream paused (the lead went to read code) is spoken after a beat.
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      if (this.turnId !== turnId || this.isMuted(turnId)) return;
      const rest = this.chunker.settled();
      if (rest) {
        this.openTurn = turnId;
        this.say(rest);
      }
    }, SETTLE_MS);
  }

  /** The reply is complete: speak what's left (or all of it, if nothing streamed). */
  done(turnId: string, text: string): void {
    if (this.isMuted(turnId)) return;
    if (turnId !== this.turnId) {
      this.turnId = turnId;
      this.chunker.reset();
      // Nothing streamed for this turn, so the whole reply arrives here at once:
      // speak the sentences it splits into as well, not only the tail that is
      // left in the buffer afterwards.
      for (const chunk of this.chunker.push(text)) this.say(chunk);
    }
    for (const chunk of this.chunker.flush()) this.say(chunk);
    if (this.openTurn === turnId) this.openTurn = null;
    this.settle();
  }

  say(raw: string): void {
    const text = speakable(raw);
    if (!text || !this.opts.enabled || !this.supported) return;
    this.queue({ text, choice: voiceChoice(this.opts.voice), rate: this.opts.rate });
  }

  /** A sample of a voice (while choosing one), even with replies muted. Whatever was playing stops. */
  preview(raw: string, voice: string): void {
    this.cancel();
    const text = speakable(raw);
    if (text && this.supported) this.queue({ text, choice: voiceChoice(voice), rate: this.opts.rate });
  }

  private queue(line: Line): void {
    if (this.held.length) {
      this.held.push(line);
      return;
    }
    if (this.outstanding === 0) this.engine = null;
    this.engine ??= this.pick(line.choice);
    if (this.engine) this.send(line);
    else this.waitForKokoro(line);
  }

  /** The voice for a new run, or null to wait for Kokoro (it is loading, or about to). */
  private pick(choice: VoiceChoice): Engine | null {
    const wantKokoro = choice.engine === 'kokoro' || !this.system.supported;
    if (!wantKokoro || !kokoro.supported || kokoro.failed) return 'system';
    return kokoro.isReady ? 'kokoro' : null;
  }

  private waitForKokoro(line: Line): void {
    this.held.push(line);
    const gen = this.gen;
    void kokoro.load(kokoroVoice(line.choice));
    void kokoro.readyWithin(KOKORO_WAIT_MS).then((ok) => {
      if (gen !== this.gen) return;
      const held = this.held;
      this.held = [];
      if (ok || kokoro.failed || !kokoro.supported) {
        // Ready, or never going to be: then the system voice is the voice from here on.
        this.engine = ok ? 'kokoro' : 'system';
        for (const l of held) this.send(l);
        return;
      }
      // Still loading: never a second voice. The rest of this reply stays on screen only.
      console.warn('[voice] Kokoro is still loading; this reply stays silent');
      this.engine = null;
      if (this.turnId) this.muted.add(this.turnId);
      if (this.openTurn === this.turnId) this.openTurn = null;
      this.settle();
    });
  }

  private send(line: Line): void {
    const gen = this.gen;
    this.outstanding++;
    this.activeEngine = this.engine;
    this.setActive(true);
    const sink: Sink = {
      start: () => {
        if (gen === this.gen) this.setAudible(true);
      },
      end: () => {
        if (gen !== this.gen) return;
        this.outstanding = Math.max(0, this.outstanding - 1);
        if (this.outstanding === 0) this.setAudible(false);
        this.settle();
      },
    };
    turnTrace.mark('chunk');
    if (this.engine === 'kokoro') {
      // Clips come back in the order asked for, so they play in order too.
      void kokoro.synth(line.text, kokoroVoice(line.choice), line.rate).then((clip) => {
        if (gen !== this.gen) return;
        turnTrace.mark('clip');
        if (clip) this.player.play(clip, sink);
        else sink.end();
      });
    } else if (this.system.supported) {
      this.system.say(line.text, { voice: line.choice.engine === 'system' ? line.choice.voice : '', rate: line.rate }, sink);
    } else sink.end();
  }

  /** Barge-in: stop mid-word, drop the queue, ignore the rest of this turn. */
  cancel(): void {
    this.gen++;
    if (this.turnId) this.muted.add(this.turnId);
    if (this.muted.size > 20) this.muted = new Set([...this.muted].slice(-10));
    this.chunker.reset();
    clearTimeout(this.settleTimer);
    this.outstanding = 0;
    this.engine = null;
    this.held = [];
    this.openTurn = null;
    this.player.stop();
    kokoro.drop();
    this.system.cancel();
    clearTimeout(this.quietTimer);
    if (this.audible) {
      this.audible = false;
      this.onSpeaking(false);
    }
    this.setActive(false);
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
      if (this.outstanding === 0 && this.audible) {
        this.audible = false;
        this.onSpeaking(false);
      }
    }, 160);
  }
}

export const tts = new Speaker();
