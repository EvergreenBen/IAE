// Energy-based voice activity detection with hysteresis. Pure: feed it one RMS
// value per frame and it says when an utterance starts, pauses, resumes and
// ends.
//
// - The noise floor is calibrated over the first ~0.5s, then tracked slowly
//   while nobody is talking (fast down, slow up).
// - Start needs energy well above the floor for `onsetMs`; end needs energy
//   back near the floor for `hangoverMs`. The gap between the two thresholds
//   is the hysteresis that keeps it from flapping.
// - 'pause' fires a moment into the silence (the caller starts transcribing
//   then, so the words are ready when the turn ends) and 'resume' if the
//   person carries on. The caller may shorten or lengthen the hangover of the
//   utterance in progress once it knows what was said.
// - While Archie is talking the mic hears him. Each frame can carry how loud
//   his echo is expected to be (`echo`): speech has to stand well above it to
//   count, so a person can talk over him but his own voice never starts an
//   utterance. When there's no way to know (the system voice plays outside the
//   page), `gate` shuts the door instead, and `strict` raises the bar.

export interface VadOptions {
  frameMs: number;
  calibrateMs: number;
  /** Start when energy > floor × startRatio … */
  startRatio: number;
  /** … and keep going while energy > floor × endRatio. */
  endRatio: number;
  /** Absolute minimum RMS that can start speech. */
  minStart: number;
  onsetMs: number;
  hangoverMs: number;
  /** Silence this long into an utterance is a pause (the turn may be ending). */
  pauseMs: number;
  /** Multiplier on the start threshold (and onset) in strict mode. */
  strictFactor: number;
  /** Speech must be this many times louder than Archie's expected echo. */
  echoMargin: number;
}

export const DEFAULT_VAD: VadOptions = {
  frameMs: 20,
  calibrateMs: 500,
  startRatio: 3.2,
  endRatio: 1.8,
  minStart: 0.012,
  onsetMs: 120,
  hangoverMs: 700,
  pauseMs: 160,
  strictFactor: 1.6,
  echoMargin: 2.5,
};

export type VadEvent = 'start' | 'pause' | 'resume' | 'end' | null;

export class Vad {
  readonly opts: VadOptions;
  floor: number | null = null;
  speaking = false;
  /** Milliseconds of voiced audio in the current (or last) utterance. */
  voicedMs = 0;
  /** Milliseconds of silence so far at the end of the current utterance. */
  get silentMs(): number {
    return this.silentFrames * this.opts.frameMs;
  }
  private strict = false;
  private gated = false;
  private hangover: number;
  private paused = false;
  private calib: number[] = [];
  private onsetFrames = 0;
  private dips = 0;
  private silentFrames = 0;

  constructor(opts: Partial<VadOptions> = {}) {
    this.opts = { ...DEFAULT_VAD, ...opts };
    this.hangover = this.opts.hangoverMs;
  }

  get calibrating(): boolean {
    return this.floor === null;
  }

  setStrict(on: boolean): void {
    this.strict = on;
  }

  /**
   * No new utterance may start (the mic hears a voice it can't tell apart from
   * a person). An utterance already under way is left alone: that is a real
   * person talking, which is what barge-in is for.
   */
  setGate(on: boolean): void {
    if (on && !this.gated && !this.speaking) {
      this.onsetFrames = 0;
      this.dips = 0;
    }
    this.gated = on;
  }

  get isGated(): boolean {
    return this.gated;
  }

  /** How much silence ends the utterance in progress (back to the default when the next one starts). */
  setHangover(ms: number): void {
    this.hangover = ms;
  }

  /** Forget the utterance in progress (keeps the noise floor). */
  reset(): void {
    this.speaking = false;
    this.paused = false;
    this.onsetFrames = 0;
    this.dips = 0;
    this.silentFrames = 0;
    this.voicedMs = 0;
    this.hangover = this.opts.hangoverMs;
  }

  thresholds(echo = 0): { start: number; end: number } {
    const floor = this.floor ?? this.opts.minStart / this.opts.startRatio;
    const k = this.strict ? this.opts.strictFactor : 1;
    return {
      start: Math.max(floor * this.opts.startRatio * k, this.opts.minStart * k, echo * this.opts.echoMargin),
      end: Math.max(floor * this.opts.endRatio, this.opts.minStart * 0.6, echo * 1.2),
    };
  }

  /** One frame: its RMS, and (while Archie talks) how loud his echo is expected to be. */
  push(rms: number, echo = 0): VadEvent {
    const { frameMs, calibrateMs, onsetMs, pauseMs } = this.opts;
    if (this.floor === null) {
      this.calib.push(rms);
      if (this.calib.length * frameMs >= calibrateMs) {
        const sorted = [...this.calib].sort((a, b) => a - b);
        this.floor = clampFloor(sorted[Math.floor(sorted.length / 2)]);
        this.calib = [];
      }
      return null;
    }

    const { start, end } = this.thresholds(echo);

    if (!this.speaking) {
      if (this.gated) {
        this.onsetFrames = 0;
        this.dips = 0;
        return null;
      }
      if (rms > start) {
        this.onsetFrames++;
        this.dips = 0;
      } else if (this.onsetFrames > 0 && rms > end && this.dips < 1) {
        this.dips++; // tolerate one soft frame inside an onset
      } else {
        this.onsetFrames = 0;
        this.dips = 0;
        // Only a quiet room teaches the floor: never Archie's voice.
        if (!this.strict && echo === 0) this.track(rms);
      }
      const need = Math.ceil((onsetMs * (this.strict ? 1.6 : 1)) / frameMs);
      if (this.onsetFrames >= need) {
        this.speaking = true;
        this.paused = false;
        this.silentFrames = 0;
        this.hangover = this.opts.hangoverMs;
        this.voicedMs = this.onsetFrames * frameMs;
        this.onsetFrames = 0;
        return 'start';
      }
      return null;
    }

    if (rms > end) {
      this.silentFrames = 0;
      this.voicedMs += frameMs;
      if (this.paused) {
        this.paused = false;
        return 'resume';
      }
      return null;
    }
    this.silentFrames++;
    if (this.silentFrames * frameMs >= this.hangover) {
      this.speaking = false;
      this.paused = false;
      this.silentFrames = 0;
      return 'end';
    }
    if (!this.paused && this.silentFrames * frameMs >= pauseMs) {
      this.paused = true;
      return 'pause';
    }
    return null;
  }

  private track(rms: number): void {
    if (this.floor === null) return;
    const f = this.floor;
    this.floor = clampFloor(rms < f ? f * 0.9 + rms * 0.1 : f * 0.995 + rms * 0.005);
  }
}

/**
 * How much of Archie's voice comes back through the mic. Both sides are the
 * loudest 20ms of the last ~300ms (the mic hears him a little late, by an
 * amount nobody knows exactly, and a window covers that), so the ratio is
 * like for like. It starts high (as if there were no echo canceller) and
 * learns from stretches where he talks and nobody else does: quickly
 * downwards (the canceller is doing its job), slowly upwards (a person may
 * have been talking quietly).
 */
export class EchoModel {
  gain = 1;
  private mic: number[] = [];

  /** Every frame while he may be audible: the mic's level and his playback level (window max). */
  observe(mic: number, ref: number, learn = true): void {
    this.mic.push(mic);
    if (this.mic.length > WINDOW_FRAMES) this.mic.shift();
    if (!learn || ref < 0.004) return;
    const ratio = Math.min(3, Math.max(...this.mic) / ref);
    this.gain += (ratio - this.gain) * (ratio < this.gain ? 0.05 : 0.02);
    this.gain = Math.min(3, Math.max(0.02, this.gain));
  }

  /** The loudest echo to expect from Archie playing at `ref` (window max). */
  expected(ref: number): number {
    return this.gain * ref;
  }
}

/** The echo window: how late the mic may hear him, in 20ms frames. */
const WINDOW_FRAMES = 15;

const clampFloor = (x: number) => Math.min(0.05, Math.max(0.0015, x));

/** Root-mean-square of a frame. */
export function rms(frame: Float32Array): number {
  let s = 0;
  for (let i = 0; i < frame.length; i++) s += frame[i] * frame[i];
  return Math.sqrt(s / Math.max(1, frame.length));
}

/** Map RMS to a 0..1 level that feels linear to the eye (-60dB … -15dB). */
export function levelFromRms(x: number): number {
  if (x <= 0) return 0;
  const db = 20 * Math.log10(x);
  return Math.min(1, Math.max(0, (db + 60) / 45));
}
