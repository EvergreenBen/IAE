import { describe, expect, it } from 'vitest';
import { cleanReply, SpeechFilter } from './speech';

const run = (chunks: string[]) => {
  const f = new SpeechFilter();
  const out = chunks.map((c) => f.push(c)).join('') + f.end();
  return { out, silent: f.silent };
};

describe('SpeechFilter', () => {
  it('passes plain text through and trims the leading space', () => {
    expect(run(['  I put ', 'Billing next to Auth.']).out).toBe('I put Billing next to Auth.');
  });

  it('never leaks a tag split across deltas', () => {
    const r = run(['<sil', 'ence', '/>']);
    expect(r.out).toBe('');
    expect(r.silent).toBe(true);
  });

  it('strips stray tags but keeps their surroundings', () => {
    expect(run(['Done. <br/>', 'Next is ', '<b>auth</b>.']).out).toBe('Done. Next is auth.');
  });

  it('keeps a literal "<" that is not a tag', () => {
    expect(run(['Keep it ', '< 3 ', 'seconds.']).out).toBe('Keep it < 3 seconds.');
  });

  it('drops an unfinished tag at the end of the reply', () => {
    expect(run(['Okay. <silen']).out).toBe('Okay. ');
  });
});

describe('cleanReply', () => {
  it('returns empty for silence', () => {
    expect(cleanReply('<silence/>')).toBe('');
    expect(cleanReply('  <silence />  ')).toBe('');
  });

  it('removes tags and collapses whitespace', () => {
    expect(cleanReply('I sketched it.\n\n<note>x</note>  Sound right?')).toBe('I sketched it. x Sound right?');
  });
});

describe('silence after words', () => {
  it('keeps what was already said', () => {
    const r = run(['Let me look at the worker.', ' <silence/>']);
    expect(r.out).toBe('Let me look at the worker. ');
    expect(r.silent).toBe(false);
    expect(cleanReply('Let me look at the worker. <silence/>')).toBe('Let me look at the worker.');
  });
});

describe('markdown never reaches the voice', () => {
  it('turns a streamed numbered list with bold and backticks into plain words', () => {
    const r = run(['Two steps:\n', '\n1', '. **Upload', ':** the browser gets a link from `apps/api/src/uploads/`.', '\n2. **Resize:', '** the worker shrinks it.']);
    expect(r.out).toBe('Two steps: Upload: the browser gets a link from apps/api/src/uploads/. Resize: the worker shrinks it.');
  });

  it('keeps numbers that are not list marks', () => {
    expect(run(['It polls every\n', '3.5 seconds and keeps 2024 data.']).out).toBe('It polls every 3.5 seconds and keeps 2024 data.');
  });

  it('cleans the stored reply the same way', () => {
    expect(cleanReply('Steps:\n\n- **Upload** via `presign.ts`\n## Then\nthe worker')).toBe('Steps: Upload via presign.ts Then the worker');
  });
});

describe('flushTail', () => {
  it('releases a held line break when tools start, so the sentence reads as finished', () => {
    const f = new SpeechFilter();
    expect(f.push('Let me check how jobs get queued.\n')).toBe('Let me check how jobs get queued.');
    expect(f.flushTail()).toBe(' ');
    expect(f.push('The poller')).toBe('The poller');
  });

  it('leaves a partial tag held', () => {
    const f = new SpeechFilter();
    f.push('Okay. <sil');
    expect(f.flushTail()).toBe('');
    expect(f.push('ence/>')).toBe('');
  });
});
