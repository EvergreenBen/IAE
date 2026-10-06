// The lead's voice: a reply must be spoken whole, and must not fall silent
// part-way through because the synthesiser's watchdog stalled the queue.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeUtterance {
  text: string;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  onboundary: ((e: { name: string; charLength: number }) => void) | null;
}

class FakeSynth {
  spoken: FakeUtterance[] = [];
  paused = false;
  speaking = false;
  pauses = 0;
  resumes = 0;
  cancels = 0;

  speak(u: FakeUtterance) {
    this.spoken.push(u);
    this.speaking = true;
  }
  pause() {
    this.pauses++;
    this.paused = true;
  }
  resume() {
    this.resumes++;
    this.paused = false;
  }
  cancel() {
    this.cancels++;
    this.speaking = false;
  }
  getVoices() {
    return [];
  }
  addEventListener() {}

  /** The browser finishing the utterance it is on. */
  finish(u: FakeUtterance) {
    u.onstart?.();
    u.onend?.();
    if (this.spoken.every((x) => x === u || this.done.has(x))) this.speaking = false;
    this.done.add(u);
  }
  private done = new Set<FakeUtterance>();

  get texts(): string[] {
    return this.spoken.map((u) => u.text);
  }
}

let synth: FakeSynth;

beforeEach(() => {
  synth = new FakeSynth();
  vi.stubGlobal('speechSynthesis', synth);
  vi.stubGlobal(
    'SpeechSynthesisUtterance',
    class {
      onstart = null;
      onend = null;
      onerror = null;
      onboundary = null;
      voice: unknown = null;
      lang = '';
      rate = 1;
      constructor(public text: string) {}
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function speaker() {
  const { Speaker } = await import('./tts');
  return new Speaker();
}

describe('a complete reply', () => {
  it('speaks every sentence when the turn never streamed', async () => {
    const tts = await speaker();
    tts.done('t1', 'Sessions live in Postgres. Short-lived tokens are safer. I would move to those.');
    expect(synth.texts).toEqual([
      'Sessions live in Postgres.',
      'Short-lived tokens are safer.',
      'I would move to those.',
    ]);
  });

  it('speaks streamed sentences once, then the tail', async () => {
    const tts = await speaker();
    // Deltas carry the reply as it arrives; done() only flushes what is left
    // buffered, so nothing already spoken is repeated.
    tts.delta('t1', 'Sessions live in Postgres. Short-lived tokens are ');
    expect(synth.texts).toEqual(['Sessions live in Postgres.']);
    tts.delta('t1', 'safer.');
    tts.done('t1', 'Sessions live in Postgres. Short-lived tokens are safer.');
    expect(synth.texts).toEqual(['Sessions live in Postgres.', 'Short-lived tokens are safer.']);
  });
});

describe('the synthesiser watchdog', () => {
  it('pings pause/resume while a run of speech is still outstanding', async () => {
    vi.useFakeTimers();
    const tts = await speaker();
    tts.done('t1', 'One. Two. Three.');
    expect(synth.pauses).toBe(0);

    vi.advanceTimersByTime(10_000);
    expect(synth.pauses).toBe(1);
    expect(synth.resumes).toBe(1);
    // Inaudible: it never leaves the synthesiser paused.
    expect(synth.paused).toBe(false);

    vi.advanceTimersByTime(10_000);
    expect(synth.pauses).toBe(2);
  });

  it('stops pinging once the queue has drained', async () => {
    vi.useFakeTimers();
    const tts = await speaker();
    tts.done('t1', 'One. Two.');
    for (const u of [...synth.spoken]) synth.finish(u as unknown as FakeUtterance);

    vi.advanceTimersByTime(30_000);
    expect(synth.pauses).toBe(0);
  });

  it('stops pinging after barge-in', async () => {
    vi.useFakeTimers();
    const tts = await speaker();
    tts.done('t1', 'One. Two.');
    tts.cancel();

    vi.advanceTimersByTime(30_000);
    expect(synth.pauses).toBe(0);
    expect(synth.cancels).toBe(1);
  });

  it('resumes a synthesiser left paused before queueing onto it', async () => {
    const tts = await speaker();
    synth.paused = true;
    tts.say('Anything at all.');
    expect(synth.resumes).toBe(1);
    expect(synth.texts).toEqual(['Anything at all.']);
  });
});
