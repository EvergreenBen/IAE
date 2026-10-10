#!/usr/bin/env node
// Download the on-device voice models into resources/models/ so voice works
// offline and starts without a network round trip:
//   - Whisper (speech-to-text)
//   - Kokoro (Archie's voice, text-to-speech)
//
//   npm run voice:setup                         # default models
//   node scripts/fetch-voice-models.mjs onnx-community/whisper-small.en
//
// Runs on `npm install` too (postinstall). There it never fails the install:
// whatever it can't fetch downloads from Hugging Face on first use instead.
// Set ARXITECT_SKIP_VOICE_MODELS=1 to skip it.
//
// Idempotent: files already present with the right size are skipped.
// Keep the ONNX file lists in sync with DTYPES in src/renderer/src/voice/sttConfig.ts
// and KOKORO_DTYPES in src/renderer/src/voice/kokoroConfig.ts.
import { copyFileSync, createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const POSTINSTALL = args.includes('--postinstall');
const HOST = process.env.HF_ENDPOINT || 'https://huggingface.co';
const MODELS = join(ROOT, 'resources', 'models');

const WHISPER = {
  label: 'Speech to text',
  id: args.find((a) => !a.startsWith('--')) || 'onnx-community/whisper-base.en',
  // What transformers.js loads for Whisper with our dtypes:
  //   WebGPU → encoder fp32 + decoder q4      wasm → encoder q8 + decoder q8
  onnx: ['onnx/encoder_model.onnx', 'onnx/decoder_model_merged_q4.onnx', 'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx'],
  meta: [
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
  ],
};

const KOKORO = {
  label: "Archie's voice",
  id: 'onnx-community/Kokoro-82M-v1.0-ONNX',
  //   WebGPU → fp32      wasm → q8
  onnx: ['onnx/model.onnx', 'onnx/model_quantized.onnx'],
  meta: ['config.json', 'tokenizer.json', 'tokenizer_config.json'],
  // The English voices (half a megabyte each), so switching voice needs no network.
  extra: (path) => /^voices\/[ab][fm]_\w+\.bin$/.test(path),
};

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

async function listRepo(model) {
  const res = await fetch(`${HOST}/api/models/${model}/tree/main?recursive=true`);
  if (!res.ok) throw new Error(`Could not list ${model}: HTTP ${res.status}`);
  const entries = await res.json();
  return new Map(entries.filter((e) => e.type === 'file').map((e) => [e.path, e.lfs?.size ?? e.size]));
}

async function download(model, file, size) {
  const dest = join(MODELS, model, file);
  if (existsSync(dest) && (size == null || statSync(dest).size === size)) {
    console.log(`  ✓ ${file} (${mb(statSync(dest).size)}, cached)`);
    return;
  }
  mkdirSync(dirname(dest), { recursive: true });
  const res = await fetch(`${HOST}/${model}/resolve/main/${file}`);
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

async function fetchModel({ label, id, onnx, meta, extra }) {
  console.log(`${label}: ${id}`);
  console.log(`Into: ${join(MODELS, id)}`);
  const files = await listRepo(id);
  const missing = onnx.filter((f) => !files.has(f));
  if (missing.length) {
    throw new Error(`${id} has no ${missing.join(', ')}. Pick a model exported for transformers.js (onnx-community/*).`);
  }
  const wanted = [...meta.filter((f) => files.has(f)), ...onnx, ...(extra ? [...files.keys()].filter(extra).sort() : [])];
  const totalBytes = wanted.reduce((s, f) => s + (files.get(f) ?? 0), 0);
  console.log(`${wanted.length} files, ${mb(totalBytes)} in all\n`);
  for (const f of wanted) await download(id, f, files.get(f));
  console.log('');
}

// ONNX Runtime's wasm, so the very first run needs no CDN either. The factory
// gets a .txt suffix so dev servers hand it over as-is instead of transforming
// it as a module (transformers.js loads it through a blob URL).
function copyRuntime() {
  const src = join(ROOT, 'node_modules', 'onnxruntime-web', 'dist');
  const out = join(MODELS, 'ort');
  if (!existsSync(src)) return;
  mkdirSync(out, { recursive: true });
  for (const [from, to] of [
    ['ort-wasm-simd-threaded.asyncify.wasm', 'ort-wasm-simd-threaded.asyncify.wasm'],
    ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.mjs.txt'],
  ]) {
    const from_ = join(src, from);
    const dest = join(out, to);
    if (!existsSync(from_)) continue;
    if (existsSync(dest) && statSync(dest).size === statSync(from_).size && statSync(dest).mtimeMs >= statSync(from_).mtimeMs) {
      console.log(`  ✓ ort/${to} (cached)`);
      continue;
    }
    copyFileSync(from_, dest);
    console.log(`  ✓ ort/${to} (${mb(statSync(dest).size)})`);
  }
}

if (POSTINSTALL && process.env.ARXITECT_SKIP_VOICE_MODELS) {
  console.log('Voice models: skipped (ARXITECT_SKIP_VOICE_MODELS is set). They download on first use.');
  process.exit(0);
}

let failed = false;
for (const model of [WHISPER, KOKORO]) {
  try {
    await fetchModel(model);
  } catch (err) {
    failed = true;
    console.error(`  ✗ ${model.label}: ${err instanceof Error ? err.message : err}\n`);
  }
}
copyRuntime();

if (!failed) console.log('\nDone. Voice works offline now.');
else if (POSTINSTALL) console.warn('\nSome voice models did not download. They download on first use instead, or run `npm run voice:setup` later.');
else process.exit(1);
