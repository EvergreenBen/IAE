// Streaming downsampler to 16kHz mono for Whisper. Averages the input samples
// that fall into each output period (a box filter, enough anti-aliasing for
// speech) and carries the fractional phase across chunks so the stream has no
// seams. Pure.

export const TARGET_RATE = 16000;

export class Downsampler {
  private readonly ratio: number;
  private acc = 0;
  private n = 0;
  private phase = 0;

  constructor(
    readonly inRate: number,
    readonly outRate = TARGET_RATE,
  ) {
    if (inRate < outRate) throw new Error(`Cannot upsample ${inRate} → ${outRate}`);
    this.ratio = inRate / outRate;
  }

  process(input: Float32Array): Float32Array {
    if (this.ratio === 1) return input.slice();
    const out = new Float32Array(Math.ceil((input.length + this.phase) / this.ratio) + 1);
    let o = 0;
    for (let i = 0; i < input.length; i++) {
      this.acc += input[i];
      this.n++;
      this.phase += 1;
      if (this.phase >= this.ratio) {
        out[o++] = this.acc / this.n;
        this.acc = 0;
        this.n = 0;
        this.phase -= this.ratio;
      }
    }
    return out.subarray(0, o);
  }
}

/** Join chunks into one contiguous buffer. */
export function concat(chunks: Float32Array[], total?: number): Float32Array {
  const len = total ?? chunks.reduce((s, c) => s + c.length, 0);
  const out = new Float32Array(len);
  let o = 0;
  for (const c of chunks) {
    out.set(c.subarray(0, Math.min(c.length, len - o)), o);
    o += c.length;
    if (o >= len) break;
  }
  return out;
}
