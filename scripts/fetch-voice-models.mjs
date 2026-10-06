#!/usr/bin/env node
// Download the on-device speech-to-text model into resources/models/ so voice
// works offline and starts without a network round trip.
//
//   npm run voice:setup                         # default model (whisper-base.en)
//   node scripts/fetch-voice-models.mjs onnx-community/whisper-small.en
//
// Idempotent: files already present with the right size are skipped.
// Keep the ONNX file list in sync with DTYPES in src/renderer/src/voice/sttConfig.ts.
import { copyFileSync, createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODEL = process.argv[2] || 'onnx-community/whisper-base.en';
const HOST = process.env.HF_ENDPOINT || 'https://huggingface.co';
const OUT = join(ROOT, 'resources', 'models', MODEL);

// What transformers.js loads for Whisper with our dtypes:
//   WebGPU → encoder fp32 + decoder q4      wasm → encoder q8 + decoder q8
const ONNX = ['onnx/encoder_model.onnx', 'onnx/decoder_model_merged_q4.onnx', 'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx'];
const META = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'added_tokens.json',
  'normalizer.json',
  'vocab.json',
  'merges.txt',
];

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

async function listRepo() {
  const res = await fetch(`${HOST}/api/models/${MODEL}/tree/main?recursive=true`);
  if (!res.ok) throw new Error(`Could not list ${MODEL}: HTTP ${res.status}`);
  const entries = await res.json();
  return new Map(entries.filter((e) => e.type === 'file').map((e) => [e.path, e.lfs?.size ?? e.size]));
}

async function download(file, size) {
  const dest = join(OUT, file);
  if (existsSync(dest) && (size == null || statSync(dest).size === size)) {
    console.log(`  ✓ ${file} (${mb(statSync(dest).size)}, cached)`);
    return;
  }
  mkdirSync(dirname(dest), { recursive: true });
  const res = await fetch(`${HOST}/${MODEL}/resolve/main/${file}`);
  if (!res.ok || !res.body) throw new Error(`${file}: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || size || 0;
  let loaded = 0;
  let lastPrint = 0;
  const tmp = `${dest}.part`;
  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    loaded += chunk.length;
    const now = Date.now();
    if (process.stdout.isTTY && now - lastPrint > 200) {
      lastPrint = now;
      const pct = total ? ` ${Math.round((loaded / total) * 100)}%` : '';
      process.stdout.write(`\r  ↓ ${file} ${mb(loaded)}${total ? ` / ${mb(total)}` : ''}${pct}   `);
    }
  });
  try {
    await pipeline(body, createWriteStream(tmp));
  } catch (err) {
    if (existsSync(tmp)) unlinkSync(tmp);
    throw err;
  }
  renameSync(tmp, dest);
  if (process.stdout.isTTY) process.stdout.write('\r\x1b[K');
  console.log(`  ✓ ${file} (${mb(loaded)})`);
}

console.log(`Voice model: ${MODEL}`);
console.log(`Into: ${OUT}`);
const files = await listRepo();
const wanted = [...META.filter((f) => files.has(f)), ...ONNX];
const missing = ONNX.filter((f) => !files.has(f));
if (missing.length) {
  console.error(`This model has no ${missing.join(', ')}. Pick a model exported for transformers.js (onnx-community/*).`);
  process.exit(1);
}
const totalBytes = wanted.reduce((s, f) => s + (files.get(f) ?? 0), 0);
console.log(`${wanted.length} files, ${mb(totalBytes)} in all\n`);
for (const f of wanted) await download(f, files.get(f));
// ONNX Runtime's wasm, so the very first run needs no CDN either. The factory
// gets a .txt suffix so dev servers hand it over as-is instead of transforming
// it as a module (transformers.js loads it through a blob URL).
const ORT_SRC = join(ROOT, 'node_modules', 'onnxruntime-web', 'dist');
const ORT_OUT = join(ROOT, 'resources', 'models', 'ort');
if (existsSync(ORT_SRC)) {
  mkdirSync(ORT_OUT, { recursive: true });
  for (const [from, to] of [
    ['ort-wasm-simd-threaded.asyncify.wasm', 'ort-wasm-simd-threaded.asyncify.wasm'],
    ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.mjs.txt'],
  ]) {
    const src = join(ORT_SRC, from);
    const dest = join(ORT_OUT, to);
    if (!existsSync(src)) continue;
    if (existsSync(dest) && statSync(dest).size === statSync(src).size && statSync(dest).mtimeMs >= statSync(src).mtimeMs) {
      console.log(`  ✓ ort/${to} (cached)`);
      continue;
    }
    copyFileSync(src, dest);
    console.log(`  ✓ ort/${to} (${mb(statSync(dest).size)})`);
  }
}

console.log('\nDone. Voice works offline now.');
