import { describe, expect, it } from 'vitest';
import { Downsampler, concat } from './resample';
import { SentenceChunker, cleanTranscript, speakable } from './text';
import { Vad, levelFromRms, rms } from './vad';

const frames = (vad: Vad, value: number, ms: number) => {
  const events: string[] = [];
  for (let t = 0; t < ms; t += vad.opts.frameMs) {
    const e = vad.push(value);
    if (e) events.push(e);
  }
  return events;
};

describe('Vad', () => {
  it('calibrates, starts on speech and ends after the hangover', () => {
    const vad = new Vad();
    expect(frames(vad, 0.003, 500)).toEqual([]);
    expect(vad.calibrating).toBe(false);
    expect(vad.floor).toBeCloseTo(0.003, 4);
    expect(frames(vad, 0.08, 400)).toEqual(['start']);
    // Short pauses between words don't end the utterance.
    expect(frames(vad, 0.003, 400)).toEqual([]);
    expect(frames(vad, 0.06, 200)).toEqual([]);
    expect(frames(vad, 0.003, 800)).toEqual(['end']);
    expect(vad.voicedMs).toBeGreaterThanOrEqual(500);
  });

  it('ignores clicks shorter than the onset', () => {
    const vad = new Vad();
    frames(vad, 0.003, 500);
    expect(frames(vad, 0.2, 60)).toEqual([]);
    expect(frames(vad, 0.003, 200)).toEqual([]);
    expect(vad.speaking).toBe(false);
  });

  it('is harder to trigger in strict mode', () => {
    const vad = new Vad();
    frames(vad, 0.004, 500);
    vad.setStrict(true);
    expect(frames(vad, 0.02, 400)).toEqual([]);
    expect(frames(vad, 0.1, 400)).toEqual(['start']);
  });

  it('follows a rising noise floor slowly and a falling one quickly', () => {
    const vad = new Vad();
    frames(vad, 0.01, 500);
    frames(vad, 0.002, 400);
    expect(vad.floor!).toBeLessThan(0.004);
  });

  it('computes levels', () => {
    expect(rms(new Float32Array([0.5, -0.5]))).toBeCloseTo(0.5);
    expect(levelFromRms(0)).toBe(0);
    expect(levelFromRms(1)).toBe(1);
    expect(levelFromRms(0.01)).toBeGreaterThan(0.2);
  });
});

describe('Downsampler', () => {
  it('48k → 16k keeps duration and averages', () => {
    const ds = new Downsampler(48000);
    const out = ds.process(new Float32Array(4800).fill(0.3));
    expect(out.length).toBe(1600);
    expect(out[10]).toBeCloseTo(0.3);
  });
  it('is seamless across odd chunk sizes and ratios', () => {
    const ds = new Downsampler(44100);
    let total = 0;
    for (let i = 0; i < 100; i++) total += ds.process(new Float32Array(441)).length;
    expect(Math.abs(total - 16000)).toBeLessThanOrEqual(1);
  });
  it('passes 16k through', () => {
    expect(new Downsampler(16000).process(new Float32Array(10)).length).toBe(10);
  });
  it('concatenates', () => {
    expect(Array.from(concat([new Float32Array([1, 2]), new Float32Array([3])]))).toEqual([1, 2, 3]);
  });
});

describe('SentenceChunker', () => {
  it('speaks sentence by sentence as deltas stream', () => {
    const c = new SentenceChunker();
    const said: string[] = [];
    for (const w of "I've put Billing next to Auth. Should Stripe call us back, or do we poll? Your call.".split(/(\s+)/)) said.push(...c.push(w));
    said.push(...c.flush());
    expect(said).toEqual(["I've put Billing next to Auth.", 'Should Stripe call us back, or do we poll?', 'Your call.']);
  });
  it('does not split abbreviations, decimals or file names', () => {
    const c = new SentenceChunker();
    expect(c.push('Config lives in apps/api/.env and config.ts, e.g. the Stripe keys at 3.5 rps. Next')).toEqual([
      'Config lives in apps/api/.env and config.ts, e.g. the Stripe keys at 3.5 rps.',
    ]);
    expect(c.flush()).toEqual(['Next']);
  });
  it('splits a long clause at a comma', () => {
    const c = new SentenceChunker(60);
    const out = c.push('Ada is reworking session expiry in Auth while Kit finishes cook mode, and Rho is reviewing the webhook handler ');
    expect(out).toEqual(['Ada is reworking session expiry in Auth while Kit finishes cook mode,']);
  });
});

describe('speakable', () => {
  it('strips markdown and tags', () => {
    expect(speakable('Config lives in `apps/api/.env`. **Done** <silence/>')).toBe('Config lives in apps/api/.env. Done');
  });
});

describe('cleanTranscript', () => {
  it('drops Whisper hallucinations on silence', () => {
    expect(cleanTranscript(' [BLANK_AUDIO]')).toBe('');
    expect(cleanTranscript(' you')).toBe('');
    expect(cleanTranscript(' Thank you.', 200)).toBe('');
    expect(cleanTranscript(' (upbeat music)')).toBe('');
    expect(cleanTranscript('Thanks for watching!')).toBe('');
  });
  it('keeps real speech', () => {
    expect(cleanTranscript(' Thank you.', 1500)).toBe('Thank you.');
    expect(cleanTranscript(' Add Stripe to billing.')).toBe('Add Stripe to billing.');
    expect(cleanTranscript(' the the the the auth module')).toBe('the auth module');
  });
});

import { pickVoice, scoreVoice } from './tts';

describe('voice choice', () => {
  const v = (name: string, lang = 'en-US', localService = true) => ({ name, lang, localService, default: false, voiceURI: name }) as SpeechSynthesisVoice;
  it('prefers premium and enhanced voices, then the good stock ones', () => {
    const voices = [v('Fred'), v('Samantha'), v('Zarvox'), v('Ava (Premium)'), v('Amélie', 'fr-CA')];
    expect(pickVoice(voices, '')?.name).toBe('Ava (Premium)');
    expect(pickVoice([v('Daniel', 'en-GB'), v('Samantha')], '')?.name).toBe('Samantha');
    expect(pickVoice(voices, 'Fred')?.name).toBe('Fred');
    expect(scoreVoice(v('Amélie', 'fr-CA'))).toBeLessThan(0);
    expect(pickVoice([v('Amélie', 'fr-CA')], '')).toBeNull();
  });
});
