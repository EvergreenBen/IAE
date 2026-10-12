import { describe, expect, it } from 'vitest';
import { Downsampler, concat } from './resample';
import { SentenceChunker, cleanTranscript, speakable, turnEndMs } from './text';
import { EchoModel, Vad, levelFromRms, rms } from './vad';

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
    // Short pauses between words don't end the utterance; a pause is noted, and the resume.
    expect(frames(vad, 0.003, 400)).toEqual(['pause']);
    expect(frames(vad, 0.06, 200)).toEqual(['resume']);
    expect(frames(vad, 0.003, 800)).toEqual(['pause', 'end']);
    expect(vad.voicedMs).toBeGreaterThanOrEqual(500);
  });

  it('ends the turn sooner or later as the caller decides, for this utterance only', () => {
    const vad = new Vad();
    frames(vad, 0.003, 500);
    frames(vad, 0.08, 400);
    expect(frames(vad, 0.003, 200)).toEqual(['pause']);
    vad.setHangover(400); // it sounded finished
    expect(frames(vad, 0.003, 200)).toEqual(['end']);
    // The next utterance starts from the default again.
    frames(vad, 0.08, 400);
    expect(frames(vad, 0.003, 600)).toEqual(['pause']);
    vad.setHangover(1300); // they trailed off on "and…"
    expect(frames(vad, 0.003, 600)).toEqual([]);
    expect(frames(vad, 0.003, 200)).toEqual(['end']);
  });

  it("lets a person talk over Archie, but never his own echo", () => {
    const vad = new Vad();
    frames(vad, 0.003, 500);
    vad.setStrict(true);
    const echo = 0.03; // what his voice should sound like in the mic right now
    const withEcho = (value: number, ms: number) => {
      const events: string[] = [];
      for (let t = 0; t < ms; t += 20) {
        const e = vad.push(value, echo);
        if (e) events.push(e);
      }
      return events;
    };
    // His echo, a bit louder than predicted: still not a person.
    expect(withEcho(0.05, 1500)).toEqual([]);
    // Nor does it teach the noise floor.
    expect(vad.floor).toBeCloseTo(0.003, 4);
    // A person, clearly louder than the echo.
    expect(withEcho(0.12, 400)).toEqual(['start']);
  });

  it('knows where speech began when it is only sure a while in', () => {
    const vad = new Vad();
    frames(vad, 0.003, 500);
    vad.setStrict(true); // talking over Archie: a longer onset
    // "What" (160ms), a breath, "does" (160ms), a breath, then the rest.
    expect([...frames(vad, 0.1, 160), ...frames(vad, 0.004, 40), ...frames(vad, 0.1, 160), ...frames(vad, 0.004, 40)]).toEqual([]);
    expect(frames(vad, 0.1, 400)).toEqual(['start']);
    // Everything since the room was last quiet: the first word included.
    expect(vad.speechFrames * 20).toBeGreaterThanOrEqual(400 + 200);
    // A real gap resets it.
    frames(vad, 0.003, 2000);
    expect(vad.speechFrames).toBe(0);
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

  it('never starts on the lead\'s own voice, and reopens after it stops', () => {
    // The regression: speechSynthesis plays outside the page, so the browser's
    // echo canceller has no reference for it. The mic hears Archie at full
    // speech level; without the gate that started an utterance, which barged
    // in and cut him off mid-sentence.
    const vad = new Vad();
    frames(vad, 0.003, 500); // calibrate on a quiet room
    vad.setStrict(true);
    vad.setGate(true);
    expect(frames(vad, 0.09, 1500)).toEqual([]);
    // Loud echo must not drag the noise floor up behind it either.
    expect(vad.floor).toBeCloseTo(0.003, 4);

    vad.setGate(false);
    expect(frames(vad, 0.09, 400)).toEqual(['start']);
  });

  it('lets a person who is already talking carry on when the lead starts', () => {
    const vad = new Vad();
    frames(vad, 0.003, 500);
    expect(frames(vad, 0.08, 400)).toEqual(['start']);
    vad.setGate(true); // the lead begins over them: barge-in is theirs to keep
    expect(vad.speaking).toBe(true);
    expect(frames(vad, 0.003, 800)).toEqual(['pause', 'end']);
  });

  it('learns how much of Archie comes back through the mic, like for like', () => {
    const m = new EchoModel();
    expect(m.expected(0.07)).toBeCloseTo(0.07); // no canceller assumed at first
    // His voice: syllables, loud and soft. The mic hears a tenth of it, 60ms late.
    const voice = Array.from({ length: 400 }, (_, i) => 0.02 + 0.06 * Math.abs(Math.sin(i / 4)));
    const windowMax = (xs: number[], i: number) => Math.max(...xs.slice(Math.max(0, i - 14), i + 1));
    for (let i = 0; i < voice.length; i++) m.observe(0.1 * (voice[i - 3] ?? 0), windowMax(voice, i));
    expect(m.gain).toBeGreaterThan(0.07);
    expect(m.gain).toBeLessThan(0.13);
    // Someone talking over him isn't learned from.
    const g = m.gain;
    for (let i = 0; i < 50; i++) m.observe(0.2, 0.07, false);
    expect(m.gain).toBe(g);
  });

  it("never hears Archie's echo as a person, even with no canceller, but hears a person over him", () => {
    const vad = new Vad();
    frames(vad, 0.003, 500);
    vad.setStrict(true);
    const m = new EchoModel();
    const voice = Array.from({ length: 1500 }, (_, i) => (i % 40 < 30 ? 0.03 + 0.07 * Math.abs(Math.sin(i / 3)) : 0.002));
    const windowMax = (i: number) => Math.max(...voice.slice(Math.max(0, i - 14), i + 1));
    const events: string[] = [];
    for (let i = 0; i < voice.length; i++) {
      const mic = 0.5 * (voice[i - 3] ?? 0) + 0.003; // half his level comes back, 60ms late
      const ref = windowMax(i);
      m.observe(mic, ref);
      const e = vad.push(mic, m.expected(ref));
      if (e) events.push(e);
    }
    expect(events).toEqual([]);
    // Now a person talks over him.
    for (let i = 0; i < 30; i++) {
      const mic = 0.5 * voice[i] + 0.15;
      const e = vad.push(mic, m.expected(windowMax(i + 30)));
      if (e) events.push(e);
    }
    expect(events).toEqual(['start']);
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

  it('keeps a reply\'s first chunk short, so the voice starts sooner', () => {
    const c = new SentenceChunker(120, 60);
    const said: string[] = [];
    const reply = "It's a recipe box: people save, search and upload recipes, and background jobs make photo thumbnails and send digest emails. Next.";
    for (const w of reply.split(/(\s+)/)) said.push(...c.push(w));
    expect(said[0]).toBe("It's a recipe box: people save, search and upload recipes,");
    expect(said[1]).toBe('and background jobs make photo thumbnails and send digest emails.');
    // The same when the whole reply arrives at once.
    c.reset();
    expect(c.push(reply).slice(0, 2)).toEqual(said.slice(0, 2));
  });

  it('breaks a long opening with no comma where a speaker would breathe', () => {
    const c = new SentenceChunker(120, 48);
    const said: string[] = [];
    for (const w of 'The jobs worker makes photo thumbnails and sends weekly digest emails. It polls every two seconds.'.split(/(\s+)/)) said.push(...c.push(w));
    said.push(...c.flush());
    expect(said).toEqual(['The jobs worker makes photo thumbnails', 'and sends weekly digest emails.', 'It polls every two seconds.']);
    // Only the opening: later sentences stay whole.
    c.reset();
    c.push('Done. ');
    expect(c.push('The jobs worker makes photo thumbnails and sends weekly digest emails. ')).toEqual(['The jobs worker makes photo thumbnails and sends weekly digest emails.']);
  });
});

describe('turn end', () => {
  it('waits less after something finished and more when they trail off', () => {
    expect(turnEndMs('What does the jobs worker do?')).toBeLessThan(500);
    expect(turnEndMs('Add retries to the thumbnail job.')).toBeLessThan(600);
    expect(turnEndMs('I want the recipe page to show the photo and')).toBeGreaterThan(1000);
    expect(turnEndMs('So the thing is,')).toBeGreaterThan(1000);
    expect(turnEndMs('Let me think about the...')).toBeGreaterThan(1000);
    expect(turnEndMs('um')).toBeGreaterThan(1000);
    expect(turnEndMs('')).toBe(700);
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

import { pickVoice, scoreVoice } from './systemVoice';

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
