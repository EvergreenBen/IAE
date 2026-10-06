// Turn-taking for voice. Owns the mic, the VAD, the speech-to-text worker and
// barge-in, and publishes renderer voice state through ui.voice().
//
//   push-to-talk  pttDown() … pttUp(). Captures between the two (plus a short
//                 pre-roll when the mic is already warm).
//   hands-free    setHandsFree(true). The VAD decides when an utterance starts
//                 and ends (≈700ms of silence).
//   barge-in      the moment the user starts talking, the lead's voice stops
//                 and an in-flight reply is interrupted.
//
// Interim transcripts run about once a second on the growing buffer while the
// worker is free; the final transcript goes to hooks.onFinal.

import { bridge } from '../bridge';
import { ui, useIae, type MicState } from '../state/store';
import { MicDeniedError, openMic, type Mic } from './mic';
import { concat } from './resample';
import { stt } from './stt';
import { DEFAULT_STT_MODEL } from './sttConfig';
import { cleanTranscript } from './text';
import { tts } from './tts';
import { Vad, levelFromRms, rms } from './vad';

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

const FRAME_MS = 20;
const PREROLL_FRAMES = 15; // 300ms
const MIN_PTT_MS = 280;
const MAX_UTTERANCE_MS = 28_000; // Whisper's window is 30s
const INTERIM_EVERY_MS = 1000;
const MIN_INTERIM_MS = 700;
const WARM_MS = 20_000; // keep the mic open this long after push-to-talk

interface Utterance {
  id: number;
  frames: Float32Array[];
  via: 'ptt' | 'vad';
}

const noHooks: VoiceHooks = { onStart() {}, onInterim() {}, onFinal() {}, onDiscard() {} };

class VoiceController {
  hooks: VoiceHooks = noHooks;
  private mic: Mic | null = null;
  private opening: Promise<Mic | null> | null = null;
  private vad = new Vad();
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

  get isHandsFree(): boolean {
    return this.handsFree;
  }

  get isCapturing(): boolean {
    return this.utter !== null;
  }

  // ── modes ──────────────────────────────────────────────────────────────────

  async setHandsFree(on: boolean): Promise<void> {
    if (on === this.handsFree) return;
    this.handsFree = on;
    if (on) {
      this.vad = new Vad(); // recalibrate the noise floor for wherever we are now
      this.vad.setStrict(tts.speaking);
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
    const ok = await this.ensureMic();
    if (ok) void this.ensureModel().catch(() => {});
    if (!ok || !this.ptt) {
      this.ptt = false;
      this.refresh();
      return;
    }
    this.begin('ptt');
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
    if (this.utter) {
      this.utter = null;
      clearInterval(this.interimTimer);
      ui.voice({ interim: '' });
      this.hooks.onDiscard();
    }
    this.cool();
    this.refresh();
  }

  /** While the user types in the intent line, the VAD doesn't start utterances. */
  setTyping(on: boolean): void {
    this.typing = on;
  }

  /** The lead is audible: make the VAD harder to trigger so it doesn't hear itself. */
  setLeadSpeaking(on: boolean): void {
    this.vad.setStrict(on);
  }

  /**
   * Barge-in. Stops the voice mid-word and interrupts a reply in flight.
   * `force` (⌘.) also interrupts a turn that is still thinking.
   */
  bargeIn(force = false): void {
    const lead = useIae.getState().lead.state;
    const wasSpeaking = tts.speaking;
    tts.cancel();
    if (lead === 'replying' || (force && lead !== 'idle') || (wasSpeaking && lead !== 'idle')) void bridge.interrupt();
  }

  dispose(): void {
    this.cancel();
    this.handsFree = false;
    this.cool(0);
    clearTimeout(this.errorTimer);
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
      const ev = this.vad.push(r);
      if (ev === 'start' && !this.utter && !this.typing) this.begin('vad');
      else if (ev === 'end' && this.utter?.via === 'vad') this.end();
    }
  };

  private begin(via: Utterance['via']): void {
    this.utter = { id: ++this.seq, frames: [...this.ring], via };
    this.bargeIn();
    this.hooks.onStart();
    clearInterval(this.interimTimer);
    this.interimTimer = setInterval(() => this.interim(), INTERIM_EVERY_MS);
    this.refresh();
  }

  private interim(): void {
    const u = this.utter;
    if (!u || !stt.isReady || !stt.idle || u.frames.length * FRAME_MS < MIN_INTERIM_MS) return;
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
      this.hooks.onDiscard();
      this.refresh();
      return;
    }
    const audio = concat(u.frames);
    this.finalizing++;
    this.refresh();
    this.finals = this.finals.then(async () => {
      try {
        await this.ensureModel();
        const { text, ms: took } = await stt.transcribe(audio);
        const clean = cleanTranscript(text, voicedMs);
        console.info(`[voice] ${(ms / 1000).toFixed(1)}s → ${took}ms: ${clean || '(nothing)'}`);
        if (clean) this.hooks.onFinal(clean);
        else this.hooks.onDiscard();
      } catch (err) {
        this.hooks.onDiscard();
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

  private ensureModel(): Promise<void> {
    if (stt.isReady) return Promise.resolve();
    if (this.model) return this.model;
    this.modelLoading = true;
    let shown = 0;
    stt.onProgress = (p) => {
      if (p - shown >= 0.02 || p === 1) {
        shown = p;
        ui.voice({ loadProgress: p });
      }
    };
    ui.voice({ loadProgress: 0 });
    this.refresh();
    const model = useIae.getState().settings.voice.sttModel || DEFAULT_STT_MODEL;
    this.model = stt.load(model).then(
      () => {
        this.modelLoading = false;
        ui.voice({ loadProgress: undefined });
        this.refresh();
      },
      (err: unknown) => {
        this.modelLoading = false;
        this.model = null;
        ui.voice({ loadProgress: undefined });
        this.fail(err);
        throw err;
      },
    );
    return this.model;
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
