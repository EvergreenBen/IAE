/// <reference lib="webworker" />
// Kokoro in a Web Worker via kokoro-js (on transformers.js). Prefers WebGPU,
// falls back to wasm. Like the Whisper worker it looks for the model in
// resources/models/ first, then the Hugging Face hub. Sentences are generated
// one at a time, in the order they were asked for.

import { env } from '@huggingface/transformers';
import { KokoroTTS } from 'kokoro-js';
import { KOKORO_DTYPES, KOKORO_MODEL, type KokoroDevice, type KokoroRequest, type KokoroResponse } from './kokoroConfig';
import { hasWebGPU, modelFetch, useLocalRuntime } from './workerFetch';

declare const self: DedicatedWorkerGlobalScope;

type Speak = Extract<KokoroRequest, { type: 'speak' }>;
type Voice = NonNullable<Parameters<KokoroTTS['generate']>[1]>['voice'];

let tts: KokoroTTS | null = null;
let loading: Promise<void> | null = null;
let queue: Speak[] = [];
let busy = false;
let voicesServed = false;

const post = (msg: KokoroResponse, transfer: Transferable[] = []) => self.postMessage(msg, transfer);

/**
 * kokoro-js fetches each voice's style vectors from a fixed hub URL. Read them
 * from the local copy when there is one, so switching voice needs no network.
 */
function serveVoicesFrom(base: string): void {
  if (voicesServed) return;
  voicesServed = true;
  const net = self.fetch.bind(self);
  const hub = `https://huggingface.co/${KOKORO_MODEL}/resolve/main/`;
  self.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(`${hub}voices/`)) {
      const local = await modelFetch(`${base}${KOKORO_MODEL}/${url.slice(hub.length)}`).catch(() => null);
      if (local?.ok) return local;
    }
    return net(input, init);
  };
}

async function load(msg: Extract<KokoroRequest, { type: 'load' }>): Promise<void> {
  const t0 = performance.now();
  env.allowRemoteModels = true;
  env.allowLocalModels = !!msg.localModelPath;
  if (msg.localModelPath) {
    env.localModelPath = msg.localModelPath;
    serveVoicesFrom(msg.localModelPath);
  }
  // The dev server reads these files straight off disk. Copying 300 MB of them
  // into the browser cache first takes about 20 seconds and saves nothing.
  if (msg.localModelPath?.startsWith('/')) env.useBrowserCache = false;
  env.fetch = modelFetch;
  if (msg.ortBase) await useLocalRuntime(msg.ortBase);

  const devices: KokoroDevice[] = msg.device ? [msg.device] : (await hasWebGPU()) ? ['webgpu', 'wasm'] : ['wasm'];
  let lastError: unknown;
  for (const device of devices) {
    try {
      tts = await KokoroTTS.from_pretrained(KOKORO_MODEL, {
        device,
        dtype: msg.dtype ?? KOKORO_DTYPES[device],
        progress_callback: (p: { status: string; progress?: number }) => {
          if (p.status === 'progress_total' && typeof p.progress === 'number') post({ type: 'progress', progress: Math.min(1, p.progress / 100) });
        },
      });
      const loadMs = performance.now() - t0;
      // Warm up: the first runs compile shaders and allocate, and a longer input pays again (measured:
      // a first 40-character sentence took 1.3s, later ones 0.5s). Do it now, not on the first reply.
      const w0 = performance.now();
      await tts.generate('Ready.', { voice: msg.voice as Voice });
      await tts.generate('The jobs worker makes photo thumbnails today.', { voice: msg.voice as Voice });
      post({ type: 'ready', device, loadMs: Math.round(loadMs), warmMs: Math.round(performance.now() - w0) });
      return;
    } catch (err) {
      lastError = err;
      tts = null;
    }
  }
  throw lastError ?? new Error('No speech backend available');
}

async function drain(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    for (let job = queue.shift(); job; job = queue.shift()) {
      try {
        if (loading) await loading;
        if (!tts) throw new Error('Voice model is not loaded');
        const t0 = performance.now();
        const out = await tts.generate(job.text, { voice: job.voice as Voice, speed: job.speed });
        // Mono. A copy the worker owns outright, so it can be handed over without touching the runtime's buffers.
        const audio = new Float32Array(Array.isArray(out.audio) ? out.audio[0] : out.audio);
        post({ type: 'audio', id: job.id, audio, sampleRate: out.sampling_rate, ms: Math.round(performance.now() - t0) }, [audio.buffer]);
      } catch (err) {
        post({ type: 'error', id: job.id, message: err instanceof Error ? err.message : String(err) });
      }
    }
  } finally {
    busy = false;
  }
}

self.onmessage = (e: MessageEvent<KokoroRequest>) => {
  const msg = e.data;
  if (msg.type === 'load') {
    loading ??= load(msg).catch((err) => {
      loading = null;
      post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    });
  } else if (msg.type === 'speak') {
    queue.push(msg);
    void drain();
  } else if (msg.type === 'drop') {
    queue = [];
  }
};
