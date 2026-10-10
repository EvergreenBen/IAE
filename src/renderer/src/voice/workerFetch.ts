/// <reference lib="webworker" />
// Model loading helpers shared by the voice workers (Whisper and Kokoro):
// reading model files from resources/ in every way the app can be served, a
// local copy of ONNX Runtime's wasm, and a WebGPU probe.

import { env } from '@huggingface/transformers';

/**
 * fetch() for model files. It reads file:// URLs with XHR (fetch can't; the
 * packaged app reads resources/ that way), and treats an HTML page served for
 * a missing local file (a dev server's SPA fallback) as the 404 it really is.
 */
export async function modelFetch(input: string | URL, init?: RequestInit): Promise<Response> {
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
export async function useLocalRuntime(base: string): Promise<void> {
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

export async function hasWebGPU(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return false;
  try {
    return !!(await gpu.requestAdapter());
  } catch {
    return false;
  }
}
