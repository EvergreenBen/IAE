// Main-thread client for the speech-to-text worker. Loads lazily on first use,
// serialises requests (the worker runs one at a time anyway) and reports
// load progress.

import { localModelBase, localRuntimeBase } from './models';
import { DEFAULT_STT_MODEL, type SttDevice, type SttRequest, type SttResponse } from './sttConfig';

export interface SttResult {
  text: string;
  ms: number;
}

type Pending = { resolve: (r: SttResult) => void; reject: (e: Error) => void };

export class SpeechToText {
  private worker: Worker | null = null;
  private model = '';
  private ready: Promise<SttDevice> | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private inFlight = 0;
  device: SttDevice | null = null;
  /** 0..1 while downloading/loading. */
  onProgress: (p: number) => void = () => {};
  /** The worker died. Everything waiting on it has been rejected; the next load() starts afresh. */
  onCrash: (err: Error) => void = () => {};

  get isReady(): boolean {
    return this.device !== null;
  }

  /** True when nothing is being transcribed (interims only run then). */
  get idle(): boolean {
    return this.inFlight === 0;
  }

  load(model = DEFAULT_STT_MODEL, device?: SttDevice): Promise<SttDevice> {
    if (this.ready && this.model === model) return this.ready;
    this.dispose();
    this.model = model;
    const worker = new Worker(new URL('./sttWorker.ts', import.meta.url), { type: 'module', name: 'iae-stt' });
    this.worker = worker;
    this.ready = new Promise<SttDevice>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<SttResponse>) => {
        const msg = e.data;
        switch (msg.type) {
          case 'progress':
            this.onProgress(msg.progress);
            break;
          case 'ready':
            this.device = msg.device;
            console.info(`[voice] ${model} ready on ${msg.device} (load ${msg.loadMs}ms, warm-up ${msg.warmMs}ms)`);
            resolve(msg.device);
            break;
          case 'result': {
            const p = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            this.inFlight = Math.max(0, this.inFlight - 1);
            p?.resolve({ text: msg.text, ms: msg.ms });
            break;
          }
          case 'error': {
            if (msg.id === undefined) {
              this.ready = null;
              reject(new Error(msg.message));
              break;
            }
            const p = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            this.inFlight = Math.max(0, this.inFlight - 1);
            p?.reject(new Error(msg.message));
          }
        }
      };
      const crashed = (err: Error) => {
        reject(err);
        this.crash(worker, err);
      };
      worker.onerror = (e) => {
        e.preventDefault();
        crashed(new Error(e.message || 'Speech worker failed'));
      };
      worker.onmessageerror = () => crashed(new Error('Speech worker sent something unreadable'));
    });
    const req: SttRequest = { type: 'load', model, localModelPath: localModelBase(model), ortBase: localRuntimeBase(), device };
    worker.postMessage(req);
    return this.ready;
  }

  /** Transcribe 16kHz mono audio. Waits for the model if it is still loading. */
  async transcribe(audio: Float32Array): Promise<SttResult> {
    if (!this.ready || !this.worker) throw new Error('Speech model is not loaded');
    await this.ready;
    const id = ++this.seq;
    this.inFlight++;
    return new Promise<SttResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const req: SttRequest = { type: 'transcribe', id, audio };
      this.worker!.postMessage(req, [audio.buffer]);
    });
  }

  /**
   * A crashed worker answers nothing: settle everything that was waiting (so
   * the mic never sticks on "transcribing") and forget the model, so the next
   * use loads a fresh worker instead of talking to a dead one.
   */
  private crash(worker: Worker, err: Error): void {
    if (this.worker !== worker) return;
    console.warn('[voice] speech worker crashed:', err.message);
    worker.terminate();
    this.worker = null;
    this.ready = null;
    this.device = null;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    this.inFlight = 0;
    this.onCrash(err);
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
    this.device = null;
    for (const p of this.pending.values()) p.reject(new Error('Speech worker stopped'));
    this.pending.clear();
    this.inFlight = 0;
  }
}

export const stt = new SpeechToText();
