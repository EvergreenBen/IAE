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
