/// <reference lib="webworker" />
// Whisper in a Web Worker via transformers.js. Prefers WebGPU, falls back to
// wasm. Looks for the model in a local folder first (scripts/fetch-voice-models
// puts it in resources/models/), then the Hugging Face hub; downloaded files
// are cached by the browser, so the network is needed once at most.

import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';
import { DTYPES, type SttDevice, type SttRequest, type SttResponse } from './sttConfig';
import { hasWebGPU, modelFetch, useLocalRuntime } from './workerFetch';

declare const self: DedicatedWorkerGlobalScope;

let asr: AutomaticSpeechRecognitionPipeline | null = null;
let loading: Promise<void> | null = null;

const post = (msg: SttResponse) => self.postMessage(msg);

async function load(msg: Extract<SttRequest, { type: 'load' }>): Promise<void> {
  const t0 = performance.now();
  env.allowRemoteModels = true;
  env.allowLocalModels = !!msg.localModelPath;
  if (msg.localModelPath) env.localModelPath = msg.localModelPath;
  env.fetch = modelFetch;
  if (msg.ortBase) await useLocalRuntime(msg.ortBase);

  const devices: SttDevice[] = msg.device ? [msg.device] : (await hasWebGPU()) ? ['webgpu', 'wasm'] : ['wasm'];
  let lastError: unknown;
  for (const device of devices) {
    try {
      // transformers.js has a single overloaded pipeline() whose union return type is too wide for TS.
      asr = (await pipeline('automatic-speech-recognition', msg.model, {
        device,
        dtype: DTYPES[device],
        progress_callback: (p: { status: string; progress?: number }) => {
          if (p.status === 'progress_total' && typeof p.progress === 'number') post({ type: 'progress', progress: Math.min(1, p.progress / 100) });
        },
      })) as unknown as AutomaticSpeechRecognitionPipeline;
      const loadMs = performance.now() - t0;
      // Warm up: the first run compiles shaders / allocates. Do it now, not on the user's first sentence.
      const w0 = performance.now();
      await asr(new Float32Array(16000), { max_new_tokens: 4 });
      post({ type: 'ready', device, loadMs: Math.round(loadMs), warmMs: Math.round(performance.now() - w0) });
      return;
    } catch (err) {
      lastError = err;
      asr = null;
    }
  }
  throw lastError ?? new Error('No speech backend available');
}

self.onmessage = async (e: MessageEvent<SttRequest>) => {
  const msg = e.data;
  if (msg.type === 'load') {
    loading ??= load(msg).catch((err) => {
      loading = null;
      post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    });
    return;
  }
  if (msg.type === 'transcribe') {
    try {
      if (loading) await loading;
      if (!asr) throw new Error('Speech model is not loaded');
      const t0 = performance.now();
      const out = (await asr(msg.audio, { max_new_tokens: 128 })) as { text: string };
      post({ type: 'result', id: msg.id, text: out.text ?? '', ms: Math.round(performance.now() - t0) });
    } catch (err) {
      post({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) });
    }
  }
};
