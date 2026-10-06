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
  it('is away without Claude', () => {
    expect(archieStateFrom({ ...base, claude: 'unavailable' })).toBe('away');
  });
});
