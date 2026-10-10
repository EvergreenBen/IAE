// Archie's voice (Kokoro text-to-speech): settings shared by the worker and
// the main thread. Keep KOKORO_DTYPES in sync with the ONNX list in
// scripts/fetch-voice-models.mjs.

export const KOKORO_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';

export type KokoroDevice = 'webgpu' | 'wasm';

export type KokoroDtype = 'fp32' | 'fp16' | 'q8';

/** Full precision on the GPU (8-bit weights sound wrong there); 8-bit on the CPU, which keeps it quick. */
export const KOKORO_DTYPES: Record<KokoroDevice, KokoroDtype> = {
  webgpu: 'fp32',
  wasm: 'q8',
};

/** The English voices worth hearing, best first. */
export const KOKORO_VOICES = [
  { id: 'af_heart', name: 'Heart' },
  { id: 'af_bella', name: 'Bella' },
  { id: 'bf_emma', name: 'Emma' },
  { id: 'af_sarah', name: 'Sarah' },
  { id: 'af_kore', name: 'Kore' },
  { id: 'am_michael', name: 'Michael' },
  { id: 'am_fenrir', name: 'Fenrir' },
  { id: 'am_puck', name: 'Puck' },
  { id: 'bm_george', name: 'George' },
  { id: 'bm_fable', name: 'Fable' },
] as const;

export const DEFAULT_KOKORO_VOICE = 'af_heart';

/** settings.voice.ttsVoice for the macOS system voice instead of Kokoro. */
export const SYSTEM_VOICE = 'system';

export type VoiceChoice = { engine: 'kokoro'; voice: string } | { engine: 'system'; voice: string };

/**
 * What settings.voice.ttsVoice asks for. Empty → Kokoro's default voice, a
 * Kokoro id → that voice, 'system' → the best system voice. Any other value
 * is the name of a system voice (what the setting held before Kokoro).
 */
export function voiceChoice(setting: string): VoiceChoice {
  if (!setting) return { engine: 'kokoro', voice: DEFAULT_KOKORO_VOICE };
  if (/^[ab][fm]_[a-z]+$/.test(setting)) return { engine: 'kokoro', voice: setting };
  return { engine: 'system', voice: setting === SYSTEM_VOICE ? '' : setting };
}

// ── worker protocol ──────────────────────────────────────────────────────────

export type KokoroRequest =
  | { type: 'load'; localModelPath?: string; ortBase?: string; device?: KokoroDevice; dtype?: KokoroDtype; voice: string }
  | { type: 'speak'; id: number; text: string; voice: string; speed: number }
  /** Barge-in: forget everything queued (the sentence being generated still finishes). */
  | { type: 'drop' };

export type KokoroResponse =
  | { type: 'progress'; progress: number }
  | { type: 'ready'; device: KokoroDevice; loadMs: number; warmMs: number }
  | { type: 'audio'; id: number; audio: Float32Array<ArrayBuffer>; sampleRate: number; ms: number }
  | { type: 'error'; id?: number; message: string };
