// Energy-based voice activity detection with hysteresis. Pure: feed it one RMS
// value per frame and it says when an utterance starts and ends.
//
// - The noise floor is calibrated over the first ~0.5s, then tracked slowly
//   while nobody is talking (fast down, slow up).
// - Start needs energy well above the floor for `onsetMs`; end needs energy
//   back near the floor for `hangoverMs`. The gap between the two thresholds
//   is the hysteresis that keeps it from flapping.
// - `strict` raises the start bar while the lead's voice is coming out of the
//   speakers, so Archie doesn't interrupt itself.

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
  /** Multiplier on the start threshold (and onset) in strict mode. */
  strictFactor: number;
}

export const DEFAULT_VAD: VadOptions = {
  frameMs: 20,
  calibrateMs: 500,
  startRatio: 3.2,
  endRatio: 1.8,
  minStart: 0.012,
  onsetMs: 120,
  hangoverMs: 700,
  strictFactor: 2.2,
};

export type VadEvent = 'start' | 'end' | null;

export class Vad {
  readonly opts: VadOptions;
  floor: number | null = null;
  speaking = false;
  /** Milliseconds of voiced audio in the current (or last) utterance. */
  voicedMs = 0;
  private strict = false;
  private calib: number[] = [];
  private onsetFrames = 0;
  private dips = 0;
  private silentFrames = 0;

  constructor(opts: Partial<VadOptions> = {}) {
    this.opts = { ...DEFAULT_VAD, ...opts };
  }

  get calibrating(): boolean {
    return this.floor === null;
  }

  setStrict(on: boolean): void {
    this.strict = on;
  }

  /** Forget the utterance in progress (keeps the noise floor). */
  reset(): void {
    this.speaking = false;
    this.onsetFrames = 0;
    this.dips = 0;
    this.silentFrames = 0;
    this.voicedMs = 0;
  }

  thresholds(): { start: number; end: number } {
    const floor = this.floor ?? this.opts.minStart / this.opts.startRatio;
    const k = this.strict ? this.opts.strictFactor : 1;
    return {
      start: Math.max(floor * this.opts.startRatio, this.opts.minStart) * k,
      end: Math.max(floor * this.opts.endRatio, this.opts.minStart * 0.6),
    };
  }

  push(rms: number): VadEvent {
    const { frameMs, calibrateMs, onsetMs, hangoverMs } = this.opts;
    if (this.floor === null) {
      this.calib.push(rms);
      if (this.calib.length * frameMs >= calibrateMs) {
        const sorted = [...this.calib].sort((a, b) => a - b);
        this.floor = clampFloor(sorted[Math.floor(sorted.length / 2)]);
        this.calib = [];
      }
      return null;
    }

    const { start, end } = this.thresholds();

    if (!this.speaking) {
      if (rms > start) {
        this.onsetFrames++;
        this.dips = 0;
      } else if (this.onsetFrames > 0 && rms > end && this.dips < 1) {
        this.dips++; // tolerate one soft frame inside an onset
      } else {
        this.onsetFrames = 0;
        this.dips = 0;
        this.track(rms);
      }
      const need = Math.ceil((onsetMs * (this.strict ? 1.6 : 1)) / frameMs);
      if (this.onsetFrames >= need) {
        this.speaking = true;
        this.silentFrames = 0;
        this.voicedMs = this.onsetFrames * frameMs;
        this.onsetFrames = 0;
        return 'start';
      }
      return null;
    }

    if (rms > end) {
      this.silentFrames = 0;
      this.voicedMs += frameMs;
    } else {
      this.silentFrames++;
      if (this.silentFrames * frameMs >= hangoverMs) {
        this.speaking = false;
        this.silentFrames = 0;
        return 'end';
      }
    }
    return null;
  }

  private track(rms: number): void {
    if (this.floor === null) return;
    const f = this.floor;
    this.floor = clampFloor(rms < f ? f * 0.9 + rms * 0.1 : f * 0.995 + rms * 0.005);
  }
}

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
