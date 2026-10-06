// The voice plumbing's failure paths: a crashed speech worker must settle
// everything waiting on it, and replies the person talked over (or stopped
// with ⌘.) before they began must stay silent.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SttRequest, SttResponse } from './sttConfig';

class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((e: MessageEvent<SttResponse>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  sent: SttRequest[] = [];
  terminated = false;
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(msg: SttRequest) {
    this.sent.push(msg);
  }
  terminate() {
    this.terminated = true;
  }
  reply(msg: SttResponse) {
    this.onmessage?.({ data: msg } as MessageEvent<SttResponse>);
  }
  crash(message: string) {
    this.onerror?.({ message, preventDefault() {} } as ErrorEvent);
  }
}

const spoken: string[] = [];

beforeAll(() => {
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('location', { href: 'http://localhost/', protocol: 'http:', pathname: '/' });
  vi.stubGlobal('speechSynthesis', { speak: (u: { text: string }) => spoken.push(u.text), cancel() {}, getVoices: () => [] });
  vi.stubGlobal(
    'SpeechSynthesisUtterance',
    class {
      constructor(public text: string) {}
    },
  );
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('speech worker crash', () => {
  it('rejects pending transcriptions, forgets the model and reloads on next use', async () => {
    const { SpeechToText } = await import('./stt');
    const stt = new SpeechToText();
    const crashed = vi.fn();
    stt.onCrash = crashed;

    const ready = stt.load('test/model');
    const first = FakeWorker.all.at(-1)!;
    first.reply({ type: 'ready', device: 'wasm', loadMs: 1, warmMs: 1 });
    await ready;
    expect(stt.isReady).toBe(true);

    const pending = stt.transcribe(new Float32Array(16));
    await Promise.resolve();
    expect(stt.idle).toBe(false);
    first.crash('out of memory');

    await expect(pending).rejects.toThrow('out of memory');
    expect(stt.idle).toBe(true);
    expect(stt.isReady).toBe(false);
    expect(first.terminated).toBe(true);
    expect(crashed).toHaveBeenCalledOnce();
    await expect(stt.transcribe(new Float32Array(16))).rejects.toThrow('not loaded');

    // The next load starts a fresh worker rather than talking to the dead one.
    void stt.load('test/model');
    expect(FakeWorker.all.at(-1)).not.toBe(first);
  });

  it('rejects a load that was still in progress', async () => {
    const { SpeechToText } = await import('./stt');
    const stt = new SpeechToText();
    const loading = stt.load('test/model');
    FakeWorker.all.at(-1)!.crash('wasm failed');
    await expect(loading).rejects.toThrow('wasm failed');
    expect(stt.isReady).toBe(false);
  });
});

describe('talking over a reply that has not started', () => {
  it('keeps the next reply silent, then speaks the one after', async () => {
    const { tts } = await import('./tts');
    tts.reset();
    spoken.length = 0;
    tts.skipPendingTurn(); // they started talking while the lead was thinking
    tts.delta('t1', 'The stale answer. ');
    tts.done('t1', 'The stale answer.');
    tts.delta('t2', 'The answer to what they said. ');
    expect(spoken).toEqual(['The answer to what they said.']);
  });

  it('lets the reply speak if they turned out to say nothing', async () => {
    const { tts } = await import('./tts');
    tts.reset();
    spoken.length = 0;
    tts.skipPendingTurn();
    tts.releasePendingSkip(); // a cough, or Space tapped and let go
    tts.delta('t3', 'Here is the plan. ');
    expect(spoken).toEqual(['Here is the plan.']);
  });

  it('⌘. before the first word keeps that reply silent for good', async () => {
    const { tts } = await import('./tts');
    tts.reset();
    spoken.length = 0;
    tts.skipPendingTurn(true);
    tts.releasePendingSkip();
    tts.delta('t4', 'Something nobody asked for. ');
    tts.done('t4', '');
    tts.delta('t5', 'Next. ');
    expect(spoken).toEqual(['Next.']);
  });

  it('a project switch drops anything held over', async () => {
    const { tts } = await import('./tts');
    tts.reset();
    spoken.length = 0;
    tts.skipPendingTurn(true);
    tts.reset();
    tts.delta('t6', 'Welcome back. ');
    expect(spoken).toEqual(['Welcome back.']);
  });
});
