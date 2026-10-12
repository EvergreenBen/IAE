import { describe, expect, it } from 'vitest';
import { initialState } from '../state/store';
import type { AgendaItem } from '@shared/model';
import { archieStateFrom } from './useArchieState';

const base = initialState();
const q = (extra: Partial<AgendaItem>): AgendaItem => ({ id: 'q', kind: 'decision', prompt: 'p', priority: 0.5, status: 'open', createdAt: 0, ...extra });

describe('archieStateFrom', () => {
  it('is idle by default', () => {
    expect(archieStateFrom(base)).toBe('idle');
  });
  it('puts the user first', () => {
    const s = { ...base, voice: { ...base.voice, mic: 'hearing' as const, speaking: true }, lead: { ...base.lead, state: 'thinking' as const } };
    expect(archieStateFrom(s)).toBe('listening');
    expect(archieStateFrom(base, { typing: true })).toBe('listening');
  });
  it('speaks, thinks, and asks', () => {
    expect(archieStateFrom({ ...base, voice: { ...base.voice, speaking: true } })).toBe('speaking');
    expect(archieStateFrom({ ...base, lead: { ...base.lead, state: 'replying' } })).toBe('speaking');
    expect(archieStateFrom({ ...base, lead: { ...base.lead, state: 'thinking' } })).toBe('thinking');
    expect(archieStateFrom({ ...base, agenda: [q({ blocking: ['ada'] })] })).toBe('question');
    expect(archieStateFrom({ ...base, agenda: [q({ priority: 0.9 })] })).toBe('question');
    expect(archieStateFrom({ ...base, agenda: [q({ priority: 0.3 })] })).toBe('idle');
    expect(archieStateFrom({ ...base, agenda: [q({ priority: 0.9, status: 'answered' })] })).toBe('idle');
  });
  it('shows it heard the moment their turn ends, and only moves its mouth to words being heard', () => {
    expect(archieStateFrom({ ...base, voice: { ...base.voice, mic: 'transcribing' } })).toBe('thinking');
    const said = { turnId: 't1', before: 0, chunk: null, done: false };
    const replying = { ...base.lead, state: 'replying' as const, turnId: 't1' };
    // Words are streaming but the voice hasn't started: still thinking, no silent mouth.
    expect(archieStateFrom({ ...base, lead: replying, voice: { ...base.voice, said } })).toBe('thinking');
    // Once the voice is under way, gaps between sentences don't flicker back to thinking.
    const going = { ...said, chunk: { words: 4, at: 0, ms: 900 } };
    expect(archieStateFrom({ ...base, lead: replying, voice: { ...base.voice, said: going } })).toBe('speaking');
    // A reply the voice isn't speaking (muted, or voice off): the mouth follows the words.
    expect(archieStateFrom({ ...base, lead: replying, voice: { ...base.voice, said: { ...said, turnId: 't0' } } })).toBe('speaking');
  });

  it('is away without Claude', () => {
    expect(archieStateFrom({ ...base, claude: 'unavailable' })).toBe('away');
  });
});
