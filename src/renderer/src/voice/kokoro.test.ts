// Archie has one voice: Kokoro. A reply waits for Kokoro to load and never
// switches to the system voice, which speaks only when picked or when Kokoro
// can't run. Barge-in silences both.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sink } from './systemVoice';

const k = vi.hoisted(() => ({
  supported: true,
  isReady: false,
  failed: false,
  load: vi.fn(() => Promise.resolve(true)),
  readyWithin: vi.fn((_ms: number) => Promise.resolve(false)),
  synth: vi.fn((text: string, _voice: string, _speed: number) => Promise.resolve({ text, audio: new Float32Array(2400), sampleRate: 24000 } as unknown)),
  drop: vi.fn(),
}));
const player = vi.hoisted(() => ({ played: [] as string[], sinks: [] as Sink[], ducked: false, level: 0 }));

vi.mock('./kokoro', () => ({ kokoro: k }));
vi.mock('./clipPlayer', () => ({
  ClipPlayer: class {
    play(clip: { text: string }, sink: Sink) {
      player.played.push(clip.text);
      player.sinks.push(sink);
      sink.start();
    }
    stop() {}
    duck(on: boolean) {
      player.ducked = on;
    }
    levelAt() {
      return player.level;
    }
  },
}));

let system: { text: string; onend: (() => void) | null }[];

beforeEach(() => {
  Object.assign(k, { supported: true, isReady: false, failed: false });
  for (const fn of [k.load, k.readyWithin, k.synth, k.drop]) fn.mockClear();
  k.readyWithin.mockImplementation(() => Promise.resolve(false));
  player.played = [];
  player.sinks = [];
  player.ducked = false;
  player.level = 0;
  system = [];
  vi.stubGlobal('speechSynthesis', {
    speak: (u: { text: string; onend: (() => void) | null }) => system.push(u),
    cancel() {},
    getVoices: () => [],
    paused: false,
    speaking: false,
  });
  vi.stubGlobal(
    'SpeechSynthesisUtterance',
    class {
      onstart = null;
      onend = null;
      onerror = null;
      onboundary = null;
      constructor(public text: string) {}
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function speaker(voice = '') {
  const { Speaker } = await import('./tts');
  const tts = new Speaker();
  tts.opts = { enabled: true, rate: 1.05, voice };
  return tts;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('Kokoro is the voice', () => {
  it('speaks every sentence through Kokoro once it is ready', async () => {
    k.isReady = true;
    const tts = await speaker();
    tts.done('t1', 'Payments owns the webhook. Ada is on it.');
    await flush();
    expect(k.synth.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ['Payments owns the webhook.', 'af_heart'],
      ['Ada is on it.', 'af_heart'],
    ]);
    expect(player.played).toEqual(['Payments owns the webhook.', 'Ada is on it.']);
    expect(system).toEqual([]);
  });

  it('uses the chosen voice, and the system voice when that is the choice', async () => {
    k.isReady = true;
    const george = await speaker('bm_george');
    george.say('Hello.');
    expect(k.synth.mock.calls[0][1]).toBe('bm_george');

    const sys = await speaker('system');
    sys.say('Hello.');
    expect(system.map((u) => u.text)).toEqual(['Hello.']);
    expect(k.synth).toHaveBeenCalledTimes(1);
  });

  it('falls back to the system voice when Kokoro cannot run', async () => {
    k.failed = true;
    const tts = await speaker();
    tts.say('Still talking.');
    expect(system.map((u) => u.text)).toEqual(['Still talking.']);
    expect(k.load).not.toHaveBeenCalled();
  });
});

describe('while Kokoro loads', () => {
  it('holds the reply until Kokoro is ready, then speaks it in order', async () => {
    let ready!: (ok: boolean) => void;
    k.readyWithin.mockImplementation(() => new Promise((r) => (ready = r)));
    const tts = await speaker();
    tts.delta('t1', 'First thing. ');
    tts.delta('t1', 'Second thing. ');
    expect(k.load).toHaveBeenCalledWith('af_heart');
    expect(k.synth).not.toHaveBeenCalled();
    expect(system).toEqual([]);

    k.isReady = true;
    ready(true);
    await flush();
    expect(player.played).toEqual(['First thing.', 'Second thing.']);
  });

  it('never switches voice: a reply Kokoro is too slow for stays silent, and the next one is Kokoro', async () => {
    const tts = await speaker();
    tts.delta('t1', 'One. Two. ');
    await flush(); // readyWithin → false, Kokoro still loading
    tts.delta('t1', 'Three. ');
    tts.done('t1', 'One. Two. Three.');
    expect(system).toEqual([]);
    expect(k.synth).not.toHaveBeenCalled();
    expect(tts.isActive).toBe(false);

    k.isReady = true;
    tts.delta('t2', 'A new reply. ');
    await flush();
    expect(player.played).toEqual(['A new reply.']);
    expect(system).toEqual([]);
  });

  it('hands over to the system voice only when Kokoro cannot load at all', async () => {
    let ready!: (ok: boolean) => void;
    k.readyWithin.mockImplementation(() => new Promise((r) => (ready = r)));
    const tts = await speaker();
    tts.delta('t1', 'Hello there. ');
    k.failed = true;
    ready(false);
    await flush();
    expect(system.map((u) => u.text)).toEqual(['Hello there.']);
  });
});

describe('barge-in', () => {
  it('drops what Kokoro has queued, and a clip that arrives late stays silent', async () => {
    k.isReady = true;
    let late!: (clip: unknown) => void;
    k.synth.mockImplementationOnce(() => new Promise((r) => (late = r)));
    const tts = await speaker();
    tts.say('This was about to play.');
    tts.cancel();
    expect(k.drop).toHaveBeenCalled();

    late({ text: 'This was about to play.' });
    await flush();
    expect(player.played).toEqual([]);
    expect(tts.speaking).toBe(false);
  });

  it('forgets a reply that was waiting for Kokoro', async () => {
    let ready!: (ok: boolean) => void;
    k.readyWithin.mockImplementation(() => new Promise((r) => (ready = r)));
    const tts = await speaker();
    tts.say('Never heard.');
    tts.cancel();
    k.isReady = true;
    ready(true);
    await flush();
    expect(k.synth).not.toHaveBeenCalled();
    expect(system).toEqual([]);
  });
});

describe('a reply that pauses to read code', () => {
  it('speaks its opening sentence without waiting for what comes after the tools', async () => {
    vi.useFakeTimers();
    try {
      k.isReady = true;
      const tts = await speaker();
      tts.delta('t1', 'Let me check how jobs get queued.'); // and nothing more for seconds
      expect(k.synth).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(300);
      expect(k.synth.mock.calls.map((c) => c[0])).toEqual(['Let me check how jobs get queued.']);
      // What it says after the look carries on as usual.
      tts.delta('t1', ' The worker polls every two seconds. ');
      expect(k.synth.mock.calls.map((c) => c[0])).toEqual(['Let me check how jobs get queued.', 'The worker polls every two seconds.']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits on what might go on ("e.g.", "version 2.")', async () => {
    const { SentenceChunker } = await import('./text');
    const c = new SentenceChunker();
    c.push('It runs on version 2.');
    expect(c.settled()).toBeNull();
    c.reset();
    c.push('Use a queue, e.g.');
    expect(c.settled()).toBeNull();
    c.reset();
    c.push('Done.');
    expect(c.settled()).toBe('Done.');
  });
});

describe('while a reply is under way', () => {
  it('stays active through the gaps between sentences, until the reply has been said', async () => {
    k.isReady = true;
    const tts = await speaker();
    const seen: boolean[] = [];
    tts.onActive = (on) => seen.push(on);
    tts.delta('t1', 'First thing. ');
    await flush();
    expect(tts.isActive).toBe(true);
    player.sinks[0].end(); // the first sentence finished; the second hasn't streamed yet
    expect(tts.isActive).toBe(true);
    tts.delta('t1', 'Second thing. ');
    await flush();
    tts.done('t1', 'First thing. Second thing.');
    expect(tts.isActive).toBe(true);
    player.sinks[1].end();
    expect(tts.isActive).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  it('ends at barge-in, and tells the mic how loud Kokoro is (but not the system voice)', async () => {
    k.isReady = true;
    const tts = await speaker();
    player.level = 0.07;
    tts.say('Kokoro speaking.');
    await flush();
    expect(tts.echoAt(performance.now())).toBe(0.07);
    tts.duck(true);
    expect(player.ducked).toBe(true);
    tts.cancel();
    expect(tts.isActive).toBe(false);

    const sys = await speaker('system');
    sys.say('The system voice.');
    expect(sys.isActive).toBe(true);
    expect(sys.echoAt(performance.now())).toBeNull();
  });
});

describe('the mouth follows the sound', () => {
  it('opens once per burst of sound, and not at all in silence', async () => {
    const { syllables } = await vi.importActual<typeof import('./clipPlayer')>('./clipPlayer');
    const rate = 24000;
    const audio = new Float32Array(rate); // one second
    for (const start of [0.1, 0.4, 0.7]) {
      for (let i = 0; i < rate * 0.12; i++) audio[Math.round(start * rate) + i] = Math.sin(i / 8) * 0.5 * Math.sin((Math.PI * i) / (rate * 0.12));
    }
    const marks = syllables(audio, rate);
    expect(marks).toHaveLength(3);
    // Each at its burst's loudest point, the middle.
    marks.forEach((m, i) => expect(Math.abs(m.at - ([0.1, 0.4, 0.7][i] + 0.06))).toBeLessThan(0.08));
    expect(syllables(new Float32Array(rate), rate)).toEqual([]);
  });
});
