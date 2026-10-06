// Speech-to-text settings shared by the worker and the main thread.
// Keep DTYPES in sync with the ONNX list in scripts/fetch-voice-models.mjs.

export type SttDevice = 'webgpu' | 'wasm';

/**
 * Per-device precision. WebGPU runs the encoder at full precision (fast on
 * the GPU, and the encoder dominates accuracy) with a 4-bit decoder; wasm
 * runs both 8-bit, which keeps the CPU path small and quick.
 */
export const DTYPES: Record<SttDevice, Record<string, 'fp32' | 'fp16' | 'q8' | 'q4'>> = {
  webgpu: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
  wasm: { encoder_model: 'q8', decoder_model_merged: 'q8' },
};

export const DEFAULT_STT_MODEL = 'onnx-community/whisper-base.en';

// ── worker protocol ──────────────────────────────────────────────────────────

export type SttRequest =
  | { type: 'load'; model: string; localModelPath?: string; ortBase?: string; device?: SttDevice }
  | { type: 'transcribe'; id: number; audio: Float32Array };

export type SttResponse =
  | { type: 'progress'; progress: number }
  | { type: 'ready'; device: SttDevice; loadMs: number; warmMs: number }
  | { type: 'result'; id: number; text: string; ms: number }
  | { type: 'error'; id?: number; message: string };
