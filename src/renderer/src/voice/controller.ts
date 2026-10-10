// Turn-taking for voice. Owns the mic, the VAD, the speech-to-text worker and
// barge-in, and publishes renderer voice state through ui.voice().
//
//   push-to-talk  pttDown() … pttUp(). Captures between the two (plus a short
//                 pre-roll when the mic is already warm).
//   hands-free    setHandsFree(true). The VAD decides when an utterance starts
//                 and ends: about 0.5s of silence after something that sounds
//                 finished, longer after "and…", "so…".
//   barge-in      the moment the user starts talking, the lead's voice stops
//                 and an in-flight reply is interrupted. Talking over Archie
//                 by voice first dips him, and stops him once it's clearly a
//                 person (a moment of speech, or real words): a cough or a
//                 door doesn't cut him off, and his own echo never counts.
//
// Interim transcripts run about once a second on the growing buffer while the
// worker is free. When the person pauses, what they said so far is
// transcribed straight away, so the words are ready the moment the turn ends;
// the final transcript goes to hooks.onFinal.
//
// Capture never waits for the speech model: audio is kept from the moment the
// mic opens and transcribed once the model is ready. For people who use voice,
// the model also loads quietly in the background after a project opens.

import { bridge } from '../bridge';
import { ui, useIae, type MicState } from '../state/store';
import { MicDeniedError, openMic, type Mic } from './mic';
import { concat } from './resample';
import { stt } from './stt';
import { DEFAULT_STT_MODEL } from './sttConfig';
import type { SttResult } from './stt';
import { cleanTranscript, turnEndMs } from './text';
import { turnTrace } from './trace';
import { tts } from './tts';
import { EchoModel, Vad, levelFromRms, rms } from './vad';

export interface VoiceHooks {
  /** The user started talking. */
  onStart(): void;
  /** Live words while they talk. */
  onInterim(text: string): void;
  /** A finished utterance. */
  onFinal(text: string): void;
  /** They stopped and nothing usable was said. */
  onDiscard(): void;
}

/** How long the mic stays shut after the lead's last word: the room still
 *  carries its tail, and that tail is what used to start an utterance. */
const LEAD_TAIL_MS = 350;
const FRAME_MS = 20;
const PREROLL_FRAMES = 25; // 500ms: the first syllable before the VAD is sure
const MIN_PTT_MS = 280;
const MAX_UTTERANCE_MS = 28_000; // Whisper's window is 30s
const INTERIM_EVERY_MS = 1000;
const MIN_INTERIM_MS = 700;
/** Shortest utterance worth transcribing early, at a pause. */
const MIN_EARLY_MS = 300;
/** Speech over Archie this long is a person, not the room: he stops. */
const CONFIRM_MS = 320;
const WARM_MS = 20_000; // keep the mic open this long after push-to-talk
const PREWARM_AFTER_MS = 2500; // after a project opens, before loading the model in the background
const USED_KEY = 'iae.voice.used';

/** Remember that this person talks to Arxitect, so later launches load the model early. */
function markVoiceUsed(): void {
  try {
    localStorage.setItem(USED_KEY, '1');
  } catch {
    /* no storage: no head start next time */
  }
}

/** Worth loading the model before anyone asks? Never prompts for the mic. */
async function voiceLikely(): Promise<boolean> {
  try {
    if (localStorage.getItem(USED_KEY) === '1') return true;
  } catch {
    /* no storage */
  }
  if (useIae.getState().settings.voice.handsFree) return true;
  // In the desktop app the permission check always says "granted" (the OS asks on first use), so only trust it in a browser.
  if ('iae' in window) return false;
  try {
    const status = await navigator.permissions?.query({ name: 'microphone' as PermissionName });
    return status?.state === 'granted';
  } catch {
    return false;
  }
}

interface Utterance {
  id: number;
  frames: Float32Array[];
  via: 'ptt' | 'vad';
  /** Started while Archie was talking: he's dipped until it's clear this is a person. */
  overLead: boolean;
  /** Known to be a person talking (always, unless it started over Archie). */
  confirmed: boolean;
  /** What was said up to the last pause, being transcribed already. */
  early: Promise<SttResult | null> | null;
}

const noHooks: VoiceHooks = { onStart() {}, onInterim() {}, onFinal() {}, onDiscard() {} };

class VoiceController {
  hooks: VoiceHooks = noHooks;
  private mic: Mic | null = null;
  private opening: Promise<Mic | null> | null = null;
  private vad = new Vad();
  private echo = new EchoModel();
  private leadActive = false;
  private ring: Float32Array[] = [];
  private utter: Utterance | null = null;
  private seq = 0;
  private handsFree = false;
  private ptt = false;
  private typing = false;
  private finalizing = 0;
  private modelLoading = false;
  private model: Promise<void> | null = null;
  private error: string | null = null;
  private errorTimer: ReturnType<typeof setTimeout> | undefined;
  private coolTimer: ReturnType<typeof setTimeout> | undefined;
  private interimTimer: ReturnType<typeof setInterval> | undefined;
  private level = 0;
  private pushedLevel = 0;
  private levelAt = 0;
  private finals: Promise<void> = Promise.resolve();
  private lastMic: MicState | null = null;
  /** Bumped on a project switch: work started for the previous project is dropped. */
  private epoch = 0;
  private loadProgress = 0;
  private shownProgress: number | undefined = undefined;
  private prewarmTimer: ReturnType<typeof setTimeout> | undefined;
  private gateTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    stt.onCrash = (err) => {
      // Pending transcriptions were rejected (their catch shows the quiet notice); the next use reloads.
      this.model = null;
      this.modelLoading = false;
      if (this.wanted() || this.finalizing > 0) this.fail(err);
      this.refresh();
    };
  }

  get isHandsFree(): boolean {
    return this.handsFree;
  }

  get isCapturing(): boolean {
    return this.utter !== null;
  }

  /** Someone is definitely talking (not just a sound the mic is still deciding about). */
  get userTalking(): boolean {
    return !!this.utter?.confirmed;
  }

  // ── modes ──────────────────────────────────────────────────────────────────

  async setHandsFree(on: boolean): Promise<void> {
    if (on === this.handsFree) return;
    this.handsFree = on;
    if (on) {
      this.vad = new Vad(); // recalibrate the noise floor for wherever we are now
      this.vad.setStrict(this.leadActive);
      if (await this.ensureMic()) void this.ensureModel().catch(() => {});
    } else {
      if (this.utter?.via === 'vad') this.end();
      this.cool(0);
    }
    this.refresh();
  }

  /** Open the mic early (Space is being held, push-to-talk is likely). */
  warm(): void {
    clearTimeout(this.coolTimer);
    void this.ensureMic().then((ok) => {
      if (ok) void this.ensureModel().catch(() => {});
    });
  }

  async pttDown(): Promise<void> {
    if (this.ptt) return;
    this.ptt = true;
    clearTimeout(this.coolTimer);
    if (this.utter) {
      this.utter.via = 'ptt';
      return;
    }
    // Start the utterance now, not once the mic is open: barge-in is immediate,
    // and every frame from the moment the mic opens is kept. The model loads
    // alongside; the audio waits for it.
    this.begin('ptt');
    const ok = await this.ensureMic();
    if (ok) {
      void this.ensureModel().catch(() => {});
      return;
    }
    this.ptt = false;
    // (begin() set it; TS still narrows from the early return above.)
    if ((this.utter as Utterance | null)?.via === 'ptt') this.drop();
    this.refresh();
  }

  pttUp(): void {
    if (!this.ptt) return;
    this.ptt = false;
    if (this.utter?.via === 'ptt') this.end();
    this.cool();
  }

  /** Drop what is being captured without sending it. */
  cancel(): void {
    this.ptt = false;
    if (this.utter) this.drop();
    this.cool();
    this.refresh();
  }

  /**
   * A different project opened (or none): nothing captured, transcribing or
   * queued for the previous one may land in the next.
   */
  reset(): void {
    this.epoch++;
    this.cancel();
  }

  /** After a project opens, load the speech model in the background for people who use voice. Never opens the mic. */
  prewarmSoon(): void {
    clearTimeout(this.prewarmTimer);
    this.prewarmTimer = setTimeout(() => {
      const run = () => void this.prewarm();
      if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 5000 });
      else run();
    }, PREWARM_AFTER_MS);
  }

  private async prewarm(): Promise<void> {
    if (stt.isReady || this.model || !(await voiceLikely())) return;
    void this.ensureModel().catch(() => {});
  }

  /** While the user types in the intent line, the VAD doesn't start utterances. */
  setTyping(on: boolean): void {
    this.typing = on;
  }

  /**
   * A reply is under way (its sentences and the gaps between them). The mic
   * hears Archie, so meanwhile speech has to stand clear of his echo, which
   * each frame measures against what he is actually playing (see echoFor). The
   * bar stays raised a moment after he stops: the room still carries his tail.
   */
  setLeadSpeaking(on: boolean): void {
    this.leadActive = on;
    clearTimeout(this.gateTimer);
    if (on) this.vad.setStrict(true);
    else this.gateTimer = setTimeout(() => this.vad.setStrict(false), LEAD_TAIL_MS);
  }

  /**
   * How loud Archie's echo should be in this frame (0 when he's quiet). His
   * Kokoro voice plays in the page, so its level is known and the mic learns
   * how much of it comes back; the system voice plays outside the page, so
   * while it talks no new utterance may start at all (the VAD's gate).
   */
  private echoFor(mic: number): number {
    const ref = tts.echoAt(performance.now());
    this.vad.setGate(ref === null);
    if (!ref) return 0;
    // Learn only while nobody is (or might be) talking over him.
    this.echo.observe(mic, ref, !this.utter);
    return this.echo.expected(ref);
  }

  /**
   * Barge-in. Stops the voice mid-word and interrupts a reply in flight.
   * `force` (⌘.) also interrupts a turn that is still thinking.
   */
  bargeIn(force = false): void {
    const { state: lead, spoke } = useIae.getState().lead;
    const wasSpeaking = tts.speaking;
    tts.cancel();
    // Still thinking and nothing said yet: the reply hasn't started, so cancel() can't name it. Keep it silent
    // when it arrives. (A turn that already said its opener and is now looking at code has been named and
    // muted by cancel(); the next turn to speak is the answer to what they're saying now.)
    if (lead === 'thinking' && !spoke) tts.skipPendingTurn(force);
    if (lead === 'replying' || (force && lead !== 'idle') || (wasSpeaking && lead !== 'idle')) void bridge.interrupt();
  }

  dispose(): void {
    this.epoch++;
    this.cancel();
    this.handsFree = false;
    this.cool(0);
    clearTimeout(this.errorTimer);
    clearTimeout(this.prewarmTimer);
    clearTimeout(this.gateTimer);
  }

  // ── capture ────────────────────────────────────────────────────────────────

  private onFrame = (frame: Float32Array): void => {
    const r = rms(frame);
    this.updateLevel(r);
    this.ring.push(frame);
    if (this.ring.length > PREROLL_FRAMES) this.ring.shift();

    if (this.utter) {
      this.utter.frames.push(frame);
      if (this.utter.frames.length * FRAME_MS >= MAX_UTTERANCE_MS) this.end();
    }
    if (this.handsFree && !this.ptt) {
      const ev = this.vad.push(r, this.echoFor(r));
      if (ev === 'start' && !this.utter && !this.typing) this.begin('vad');
      else if (ev === 'pause' && this.utter?.via === 'vad') this.transcribeEarly();
      else if (ev === 'resume' && this.utter) this.utter.early = null;
      else if (ev === 'end' && this.utter?.via === 'vad') this.end();
      const u = this.utter;
      if (u && !u.confirmed && this.vad.voicedMs >= CONFIRM_MS) this.confirm(u);
    }
  };

  /** It's a person talking over Archie: stop him. */
  private confirm(u: Utterance): void {
    if (u.confirmed) return;
    u.confirmed = true;
    this.bargeIn();
  }

  /**
   * They paused: transcribe what they've said so far now, so the words are
   * ready the moment the turn ends — and from what they said, decide how long
   * the pause must last to end the turn.
   */
  private transcribeEarly(): void {
    const u = this.utter;
    if (!u || !stt.isReady || u.frames.length * FRAME_MS < MIN_EARLY_MS) return;
    const id = u.id;
    const early = stt.transcribe(concat(u.frames)).catch(() => null);
    u.early = early;
    void early.then((r) => {
      if (this.utter?.id !== id || this.utter.early !== early || !r) return;
      const t = cleanTranscript(r.text);
      if (t) {
        ui.voice({ interim: t });
        this.hooks.onInterim(t);
      }
      this.vad.setHangover(turnEndMs(t));
    });
  }

  /** Forget the utterance in progress: nothing was said that should be sent. */
  private drop(): void {
    if (this.utter?.overLead && !this.utter.confirmed) tts.duck(false);
    this.utter = null;
    clearInterval(this.interimTimer);
    ui.voice({ interim: '' });
    this.discarded();
  }

  /** Nothing usable was said: a reply held back for this person may speak after all. */
  private discarded(): void {
    tts.releasePendingSkip();
    this.hooks.onDiscard();
  }

  private begin(via: Utterance['via']): void {
    // Over Archie's voice, only dip him until it's clear this is a person; otherwise stop everything now.
    const overLead = via === 'vad' && this.leadActive;
    this.utter = { id: ++this.seq, frames: [...this.ring], via, overLead, confirmed: !overLead, early: null };
    if (overLead) tts.duck(true);
    else this.bargeIn();
    this.hooks.onStart();
    clearInterval(this.interimTimer);
    this.interimTimer = setInterval(() => this.interim(), INTERIM_EVERY_MS);
    this.refresh();
  }

  private interim(): void {
    const u = this.utter;
    if (!u || u.early || !stt.isReady || !stt.idle || u.frames.length * FRAME_MS < MIN_INTERIM_MS) return;
    const id = u.id;
    stt
      .transcribe(concat(u.frames))
      .then(({ text }) => {
        if (this.utter?.id !== id) return;
        const t = cleanTranscript(text);
        if (!t) return;
        ui.voice({ interim: t });
        this.hooks.onInterim(t);
      })
      .catch(() => {});
  }

  private end(): void {
    const u = this.utter;
    if (!u) return;
    this.utter = null;
    clearInterval(this.interimTimer);
    const ms = u.frames.length * FRAME_MS;
    const voicedMs = u.via === 'vad' ? this.vad.voicedMs : ms;
    if (u.via === 'ptt' && ms < MIN_PTT_MS + PREROLL_FRAMES * FRAME_MS * 0.5) {
      ui.voice({ interim: '' });
      this.discarded();
      this.refresh();
      return;
    }
    const audio = concat(u.frames);
    const epoch = this.epoch;
    turnTrace.stopped();
    this.finalizing++;
    this.refresh();
    this.finals = this.finals.then(async () => {
      try {
        if (epoch !== this.epoch) return; // said to the previous project
        await this.ensureModel();
        // Transcribed at the pause already, unless they carried on after it (then u.early was cleared).
        const early = u.early ? await u.early : null;
        const { text, ms: took } = early ?? (await stt.transcribe(audio));
        if (epoch !== this.epoch) return;
        const clean = cleanTranscript(text, voicedMs);
        console.info(`[voice] ${(ms / 1000).toFixed(1)}s → ${early ? `ready at the pause (${took}ms)` : `${took}ms`}: ${clean || '(nothing)'}`);
        if (clean) {
          // Real words over Archie, however short ("stop", "no"): a person, so he stops.
          this.confirm(u);
          turnTrace.mark('text');
          this.hooks.onFinal(clean);
        } else {
          // Only the room: Archie carries on at full voice.
          if (u.overLead && !u.confirmed) tts.duck(false);
          turnTrace.drop();
          this.discarded();
        }
      } catch (err) {
        if (epoch !== this.epoch) return;
        this.discarded();
        this.fail(err);
      } finally {
        this.finalizing--;
        if (!this.utter) ui.voice({ interim: '' });
        this.refresh();
      }
    });
  }

  // ── resources ──────────────────────────────────────────────────────────────

  private async ensureMic(): Promise<boolean> {
    if (this.mic) return true;
    this.opening ??= openMic(this.onFrame)
      .then((m) => {
        this.mic = m;
        markVoiceUsed();
        this.clearError();
        if (!this.wanted()) this.cool(0);
        return m;
      })
      .catch((err: unknown) => {
        this.fail(err);
        return null;
      })
      .finally(() => {
        this.opening = null;
        this.refresh();
      });
    this.refresh();
    return !!(await this.opening);
  }

  private wanted(): boolean {
    return this.handsFree || this.ptt || this.utter !== null;
  }

  /** Close the mic after a while (or now) unless something still needs it. */
  private cool(after = WARM_MS): void {
    clearTimeout(this.coolTimer);
    this.coolTimer = setTimeout(() => {
      if (this.wanted() || !this.mic) return;
      this.mic.close();
      this.mic = null;
      this.ring = [];
      this.level = 0;
      this.pushedLevel = 0;
      ui.voice({ level: 0 });
      this.refresh();
    }, after);
  }

  /**
   * Load the speech model (once). Progress and failures show only while
   * someone is waiting on it; a background load stays out of sight.
   */
  private ensureModel(): Promise<void> {
    if (stt.isReady) return Promise.resolve();
    if (this.model) return this.model;
    this.modelLoading = true;
    this.loadProgress = 0;
    let step = 0;
    stt.onProgress = (p) => {
      this.loadProgress = p;
      if (p - step >= 0.02 || p === 1) {
        step = p;
        this.refresh();
      }
    };
    this.refresh();
    const model = useIae.getState().settings.voice.sttModel || DEFAULT_STT_MODEL;
    const loading: Promise<void> = stt.load(model).then(
      () => {
        if (this.model === loading) this.model = null; // loaded: stt.isReady answers from now on
        this.modelLoading = false;
        this.refresh();
      },
      (err: unknown) => {
        if (this.model === loading) this.model = null;
        this.modelLoading = false;
        if (this.waiting()) this.fail(err);
        else console.warn('[voice] background model load failed', err);
        this.refresh();
        throw err;
      },
    );
    this.model = loading;
    return loading;
  }

  /** Someone is talking, holding Space, or waiting on a transcript. */
  private waiting(): boolean {
    return this.wanted() || this.finalizing > 0;
  }

  // ── state ──────────────────────────────────────────────────────────────────

  private updateLevel(r: number): void {
    const target = levelFromRms(r);
    this.level += (target - this.level) * (target > this.level ? 0.6 : 0.18);
    if (!this.utter) {
      // Only an utterance moves the meter and Archie; idle room noise stays out of the store.
      if (this.pushedLevel !== 0) ui.voice({ level: (this.pushedLevel = 0) });
      return;
    }
    const now = performance.now();
    if (now - this.levelAt > 66 && Math.abs(this.level - this.pushedLevel) > 0.03) {
      this.levelAt = now;
      this.pushedLevel = this.level;
      ui.voice({ level: Math.round(this.level * 100) / 100 });
    }
  }

  private fail(err: unknown): void {
    if (err instanceof MicDeniedError) {
      this.error = 'Mic access is off. Typing still works.';
      if (this.handsFree) {
        this.handsFree = false;
        const voice = useIae.getState().settings.voice;
        void bridge.setSettings({ voice: { ...voice, handsFree: false } });
      }
    } else {
      console.warn('[voice]', err);
      this.error = this.mic ? 'Voice had a problem. Try again.' : 'Could not open the mic.';
    }
    this.ptt = false;
    clearTimeout(this.errorTimer);
    this.errorTimer = setTimeout(() => this.clearError(), 6000);
    this.refresh();
  }

  private clearError(): void {
    if (!this.error) return;
    this.error = null;
    this.refresh();
  }

  private refresh(): void {
    const progress = this.modelLoading && this.waiting() ? this.loadProgress : undefined;
    if (progress !== this.shownProgress) {
      this.shownProgress = progress;
      ui.voice({ loadProgress: progress });
    }
    let mic: MicState;
    if (this.utter) mic = 'hearing';
    else if (this.finalizing > 0) mic = stt.isReady ? 'transcribing' : 'loading';
    else if (this.error) mic = 'error';
    else if (this.mic || this.opening) mic = this.modelLoading ? 'loading' : 'idle';
    else mic = 'off';
    if (mic === this.lastMic && mic !== 'error') return;
    this.lastMic = mic;
    ui.voice({ mic, error: this.error ?? undefined, ...(mic === 'off' || mic === 'idle' ? { level: 0 } : {}) });
  }
}

export const voice = new VoiceController();
