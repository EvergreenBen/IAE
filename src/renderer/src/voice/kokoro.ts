// Main-thread client for the Kokoro worker (Archie's voice). Loads once, turns
// sentences into audio clips in the order they were asked for, and drops what
// is still queued on barge-in. Never rejects: a sentence it can't make comes
// back as null, and a model that won't load reports false, so the caller can
// fall back to the system voice.

import { KOKORO_MODEL, type KokoroDevice, type KokoroRequest, type KokoroResponse } from './kokoroConfig';
import { localModelBase, localRuntimeBase } from './models';

export interface Clip {
  audio: Float32Array<ArrayBuffer>;
  sampleRate: number;
}

/** A model that won't load gives up at once; a worker that dies after loading gets one more try. */
const MAX_FAILURES = 2;

export class KokoroClient {
  private worker: Worker | null = null;
  private ready: Promise<boolean> | null = null;
  private seq = 0;
  private pending = new Map<number, (clip: Clip | null) => void>();
  private failures = 0;
  device: KokoroDevice | null = null;
  /** 0..1 while downloading/loading. */
  onProgress: (p: number) => void = () => {};

  /**
   * Kokoro needs the GPU: on the CPU it makes speech about 1.5× slower than
   * it plays (measured), so a reply would stall between sentences. Without
   * WebGPU the system voice speaks instead.
   */
  get supported(): boolean {
    return typeof Worker !== 'undefined' && typeof AudioContext !== 'undefined' && typeof navigator !== 'undefined' && 'gpu' in navigator;
  }

  get isReady(): boolean {
    return this.device !== null;
  }

  /** Given up for this session: the system voice speaks instead. */
  get failed(): boolean {
    return this.failures >= MAX_FAILURES;
  }

  /** Resolves true once the model is loaded and warm, false if it can't be. */
  load(voice: string): Promise<boolean> {
    if (this.ready) return this.ready;
    if (!this.supported || this.failed) return Promise.resolve(false);
    const worker = new Worker(new URL('./kokoroWorker.ts', import.meta.url), { type: 'module', name: 'iae-tts' });
    this.worker = worker;
    this.ready = new Promise<boolean>((resolve) => {
      const give = (why: string, fatal: boolean) => {
        console.warn(`[voice] ${why}`);
        if (fatal) this.failures = MAX_FAILURES;
        this.fail(worker);
        resolve(false);
      };
      worker.onmessage = (e: MessageEvent<KokoroResponse>) => {
        const msg = e.data;
        switch (msg.type) {
          case 'progress':
            this.onProgress(msg.progress);
            break;
          case 'ready':
            this.device = msg.device;
            console.info(`[voice] Kokoro ready on ${msg.device} (load ${msg.loadMs}ms, warm-up ${msg.warmMs}ms)`);
            resolve(true);
            break;
          case 'audio':
            console.info(`[voice] Kokoro ${(msg.audio.length / msg.sampleRate).toFixed(1)}s of speech in ${msg.ms}ms`);
            this.settle(msg.id, { audio: msg.audio, sampleRate: msg.sampleRate });
            break;
          case 'error':
            if (msg.id === undefined) give(`Kokoro did not load, using the system voice: ${msg.message}`, true);
            else this.settle(msg.id, null);
        }
      };
      worker.onerror = (e) => {
        e.preventDefault();
        give(`Kokoro worker failed: ${e.message || 'unknown error'}`, false);
      };
      worker.onmessageerror = () => give('Kokoro worker sent something unreadable', false);
    });
    const req: KokoroRequest = { type: 'load', localModelPath: localModelBase(KOKORO_MODEL), ortBase: localRuntimeBase(), device: 'webgpu', voice };
    worker.postMessage(req);
    return this.ready;
  }

  /** True if the model is ready, or becomes ready within `ms`. */
  readyWithin(ms: number): Promise<boolean> {
    if (this.isReady) return Promise.resolve(true);
    if (!this.ready) return Promise.resolve(false);
    return Promise.race([this.ready, new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);
  }

  /** Audio for one sentence, or null if it could not be made (or was dropped). */
  synth(text: string, voice: string, speed: number): Promise<Clip | null> {
    const worker = this.worker;
    if (!worker || !this.ready) return Promise.resolve(null);
    const id = ++this.seq;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      const req: KokoroRequest = { type: 'speak', id, text, voice, speed };
      worker.postMessage(req);
    });
  }

  /** Barge-in: nothing queued gets generated, and nothing still on its way is played. */
  drop(): void {
    for (const resolve of this.pending.values()) resolve(null);
    this.pending.clear();
    if (this.worker) this.worker.postMessage({ type: 'drop' } satisfies KokoroRequest);
  }

  private settle(id: number, clip: Clip | null): void {
    const resolve = this.pending.get(id);
    this.pending.delete(id);
    resolve?.(clip);
  }

  /** A dead worker answers nothing: settle everything waiting, and let the next load() start afresh. */
  private fail(worker: Worker): void {
    if (this.worker !== worker) return;
    worker.terminate();
    this.worker = null;
    this.ready = null;
    this.device = null;
    this.failures++;
    for (const resolve of this.pending.values()) resolve(null);
    this.pending.clear();
  }
}

export const kokoro = new KokoroClient();
