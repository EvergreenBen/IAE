// Microphone capture → 16kHz mono frames of 20ms. Uses an AudioWorklet (or a
// ScriptProcessor where worklets are missing). Asks the AudioContext for 16kHz
// directly so the browser resamples; if it can't, resamples here.

import { Downsampler, TARGET_RATE } from './resample';

export const FRAME = TARGET_RATE / 50; // 20ms

export interface Mic {
  close(): void;
}

export class MicDeniedError extends Error {}

// Inlined so it needs no separate bundling step; CSP allows blob: scripts.
const WORKLET = `
class IaeCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(4096); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      if (this.n + ch.length > this.buf.length) this.flush();
      this.buf.set(ch, this.n);
      this.n += ch.length;
      if (this.n >= 512) this.flush();
    }
    return true;
  }
  flush() { if (this.n) { this.port.postMessage(this.buf.slice(0, this.n)); this.n = 0; } }
}
registerProcessor('iae-capture', IaeCapture);
`;

let workletUrl: string | null = null;

/** Open the mic. `onFrame` gets 20ms frames of 16kHz audio. */
export async function openMic(onFrame: (frame: Float32Array) => void): Promise<Mic> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    const name = (err as DOMException)?.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') throw new MicDeniedError('Microphone access was denied');
    throw err;
  }

  let ctx: AudioContext;
  try {
    ctx = new AudioContext({ sampleRate: TARGET_RATE, latencyHint: 'interactive' });
  } catch {
    ctx = new AudioContext({ latencyHint: 'interactive' });
  }
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {});

  const source = ctx.createMediaStreamSource(stream);
  const sink = ctx.createGain();
  sink.gain.value = 0; // keeps the graph pulled without making a sound
  sink.connect(ctx.destination);

  const ds = new Downsampler(ctx.sampleRate);
  const pending = new Float32Array(FRAME);
  let fill = 0;
  const push = (chunk: Float32Array) => {
    const pcm = ds.process(chunk);
    let i = 0;
    while (i < pcm.length) {
      const take = Math.min(FRAME - fill, pcm.length - i);
      pending.set(pcm.subarray(i, i + take), fill);
      fill += take;
      i += take;
      if (fill === FRAME) {
        onFrame(pending.slice());
        fill = 0;
      }
    }
  };

  let node: AudioNode;
  if (ctx.audioWorklet) {
    workletUrl ??= URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(workletUrl);
    const w = new AudioWorkletNode(ctx, 'iae-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
    w.port.onmessage = (e: MessageEvent<Float32Array>) => push(e.data);
    node = w;
  } else {
    const sp = ctx.createScriptProcessor(2048, 1, 1);
    sp.onaudioprocess = (e) => push(e.inputBuffer.getChannelData(0).slice());
    node = sp;
  }
  source.connect(node);
  node.connect(sink);

  return {
    close() {
      try {
        source.disconnect();
        node.disconnect();
      } catch {
        /* already gone */
      }
      for (const t of stream.getTracks()) t.stop();
      void ctx.close().catch(() => {});
    },
  };
}
