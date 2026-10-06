/// <reference lib="webworker" />
// Whisper in a Web Worker via transformers.js. Prefers WebGPU, falls back to
// wasm. Looks for the model in a local folder first (scripts/fetch-voice-models
// puts it in resources/models/), then the Hugging Face hub; downloaded files
// are cached by the browser, so the network is needed once at most.

import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';
import { DTYPES, type SttDevice, type SttRequest, type SttResponse } from './sttConfig';

declare const self: DedicatedWorkerGlobalScope;

let asr: AutomaticSpeechRecognitionPipeline | null = null;
let loading: Promise<void> | null = null;

const post = (msg: SttResponse) => self.postMessage(msg);

/**
 * fetch() for model files. It reads file:// URLs with XHR (fetch can't; the
 * packaged app reads resources/ that way), and treats an HTML page served for
 * a missing local file (a dev server's SPA fallback) as the 404 it really is.
 */
async function modelFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  if (url.startsWith('file:')) return readFileUrl(url);
  const res = await fetch(input, init);
  if (res.ok && !/^https?:/.test(url) && /text\/html/.test(res.headers.get('content-type') ?? '') && !/\.html?$/.test(url)) {
    return new Response(null, { status: 404 });
  }
  return res;
}

function readFileUrl(url: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url);
    xhr.responseType = 'arraybuffer';
    xhr.onload = () => {
      const ok = xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300);
      if (!ok || !xhr.response) return resolve(new Response(null, { status: 404 }));
      const body = xhr.response as ArrayBuffer;
      resolve(new Response(body, { status: 200, headers: { 'content-length': String(body.byteLength) } }));
    };
    xhr.onerror = () => reject(new Error(`Could not read ${url}`));
    xhr.send();
  });
}

/** Serve ONNX Runtime's wasm from resources/ too, so the first run needs no CDN. */
async function useLocalRuntime(base: string): Promise<void> {
  const wasm = `${base}ort-wasm-simd-threaded.asyncify.wasm`;
  const mjs = `${base}ort-wasm-simd-threaded.asyncify.mjs.txt`;
  try {
    const probe = await modelFetch(mjs);
    if (!probe.ok) return;
    const onnx = env.backends.onnx as { wasm?: { wasmPaths?: unknown } };
    if (onnx.wasm) onnx.wasm.wasmPaths = { wasm: new URL(wasm, self.location.href).href, mjs: new URL(mjs, self.location.href).href };
  } catch {
    // Not there: the runtime comes from the CDN and is cached after first use.
  }
}

async function hasWebGPU(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return false;
  try {
    return !!(await gpu.requestAdapter());
  } catch {
    return false;
  }
}

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
