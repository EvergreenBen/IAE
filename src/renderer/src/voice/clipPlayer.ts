// Plays Kokoro's clips one after another through Web Audio, and moves Archie's
// mouth with the sound: a pulse on each syllable, found as a peak in the
// clip's loudness. Unlike speechSynthesis this audio plays inside the page,
// so the mic's echo canceller can hear it too — and so can we: levelAt() says
// how loud Archie is at any moment, which lets the mic tell his echo from a
// person talking over him. duck() dips him while it decides.

import type { Clip } from './kokoro';
import type { Sink } from './systemVoice';
import { speechPulse } from './pulse';

/** Loudness is measured in windows this long (seconds). */
const FRAME_S = 0.04;
/** Syllables closer together than this read as one movement. */
const MIN_GAP_S = 0.12;
const QUIET = 0.25;

export interface Syllable {
  /** Seconds into the clip. */
  at: number;
  /** 0..1 */
  strength: number;
}

/** Where the mouth should open: local peaks of loudness that stand above the quiet. Pure. */
export function syllables(audio: Float32Array, sampleRate: number): Syllable[] {
  const hop = Math.max(1, Math.round(sampleRate * FRAME_S));
  const n = Math.ceil(audio.length / hop);
  const env = new Float32Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    let sum = 0;
    const end = Math.min(audio.length, (i + 1) * hop);
    for (let j = i * hop; j < end; j++) sum += audio[j] * audio[j];
    env[i] = Math.sqrt(sum / Math.max(1, end - i * hop));
    peak = Math.max(peak, env[i]);
  }
  if (peak === 0) return [];
  const out: Syllable[] = [];
  let last = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = env[i] / peak;
    const rising = i === 0 || env[i] > env[i - 1];
    const falling = i === n - 1 || env[i] >= env[i + 1];
    if (v < QUIET || !rising || !falling || i * FRAME_S - last < MIN_GAP_S) continue;
    last = i * FRAME_S;
    out.push({ at: last, strength: Math.min(1, 0.35 + v * 0.65) });
  }
  return out;
}

/** Loudness per 20ms frame, for the echo reference. Pure. */
export function envelope(audio: Float32Array, sampleRate: number, frameS = 0.02): Float32Array {
  const hop = Math.max(1, Math.round(sampleRate * frameS));
  const n = Math.ceil(audio.length / hop);
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    const end = Math.min(audio.length, (i + 1) * hop);
    for (let j = i * hop; j < end; j++) sum += audio[j] * audio[j];
    env[i] = Math.sqrt(sum / Math.max(1, end - i * hop));
  }
  return env;
}

/** A clip on the audio clock: when it starts and ends (AudioContext seconds), and its mouth marks. */
interface Scheduled {
  src: AudioBufferSourceNode;
  at: number;
  end: number;
  sink: Sink;
  marks: Syllable[];
  next: number;
  started: boolean;
}

/** A clip as it sounds: when it started (performance.now() ms) and its loudness per 20ms. */
interface Heard {
  at: number;
  env: Float32Array;
}

const ENV_FRAME_MS = 20;
/** How far Archie dips while the mic works out whether someone is talking over him. */
const DUCKED = 0.3;
/** A clip that arrives while nothing plays starts this far ahead, so it never starts mid-render. */
const LEAD_IN_S = 0.03;

/**
 * Clips are scheduled on the audio clock, back to back: the next sentence is
 * queued the moment it's ready and starts on the very sample the last one
 * ends, with no gap and no dependence on when an "ended" event gets around to
 * firing (they can arrive seconds late). A 30ms tick tells the sinks when each
 * clip starts and ends and moves the mouth.
 */
export class ClipPlayer {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private scheduled: Scheduled[] = [];
  /** When the last scheduled clip ends (AudioContext seconds). */
  private endsAt = 0;
  private ticker: ReturnType<typeof setInterval> | undefined;
  private heard: Heard[] = [];
  private gain = 1;
  private prevGain = 1;
  private gainAt = 0;

  /**
   * How loud Archie's voice is around `now` (performance.now() ms): the
   * loudest 20ms within the last `windowMs`, as he is playing it (ducking
   * included). Zero when he's silent.
   */
  levelAt(now: number, windowMs = 300): number {
    let max = 0;
    for (const h of this.heard) {
      const from = Math.max(0, Math.floor((now - windowMs - h.at) / ENV_FRAME_MS));
      const to = Math.min(h.env.length - 1, Math.floor((now - h.at) / ENV_FRAME_MS));
      for (let i = from; i <= to; i++) if (h.env[i] > max) max = h.env[i];
    }
    // Just after a dip the room still carries the louder voice: count the louder of the two for a moment.
    const gain = now - this.gainAt < windowMs + 100 ? Math.max(this.gain, this.prevGain) : this.gain;
    return max * gain;
  }

  /** Dip (or restore) the voice smoothly. */
  duck(on: boolean): void {
    const next = on ? DUCKED : 1;
    if (next !== this.gain) {
      this.prevGain = this.gain;
      this.gainAt = performance.now();
    }
    this.gain = next;
    const g = this.out;
    if (!g || !this.ctx) return;
    const t = this.ctx.currentTime;
    g.gain.cancelScheduledValues(t);
    g.gain.setTargetAtTime(this.gain, t, on ? 0.03 : 0.08);
  }

  play(clip: Clip, sink: Sink): void {
    const ctx = (this.ctx ??= new AudioContext());
    if (ctx.state === 'suspended') void ctx.resume();
    if (!this.out) {
      this.out = ctx.createGain();
      this.out.gain.value = this.gain;
      this.out.connect(ctx.destination);
    }
    const { audio, sampleRate } = clip;
    const buffer = ctx.createBuffer(1, audio.length, sampleRate);
    buffer.copyToChannel(audio, 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.out);
    const at = Math.max(ctx.currentTime + LEAD_IN_S, this.endsAt);
    src.start(at);
    this.endsAt = at + buffer.duration;
    this.scheduled.push({ src, at, end: this.endsAt, sink, marks: syllables(audio, sampleRate), next: 0, started: false });
    // When it reaches the speakers, in performance.now() terms: its start on the audio clock, plus what the output adds.
    const now = performance.now();
    this.heard = this.heard.filter((h) => h.at + h.env.length * ENV_FRAME_MS > now - 2000);
    this.heard.push({ at: now + (at - ctx.currentTime + (ctx.outputLatency || 0) + (ctx.baseLatency || 0)) * 1000, env: envelope(audio, sampleRate) });
    this.tick();
    this.ticker ??= setInterval(() => this.tick(), 30);
  }

  /** Barge-in: silence now, and forget everything scheduled. Sinks are not told; the caller already knows. */
  stop(): void {
    const all = this.scheduled;
    this.scheduled = [];
    this.endsAt = 0;
    this.heard = [];
    this.stopTicker();
    for (const s of all) {
      try {
        s.src.stop();
      } catch {
        /* never started */
      }
    }
    this.duck(false);
  }

  private tick(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    while (this.scheduled.length) {
      const s = this.scheduled[0];
      if (!s.started && t >= s.at) {
        s.started = true;
        s.sink.start();
      }
      while (s.started && s.next < s.marks.length && s.at + s.marks[s.next].at <= t) speechPulse(s.marks[s.next++].strength);
      if (t < s.end) break;
      this.scheduled.shift();
      s.sink.end();
    }
    if (!this.scheduled.length) this.stopTicker();
  }

  private stopTicker(): void {
    clearInterval(this.ticker);
    this.ticker = undefined;
  }
}
