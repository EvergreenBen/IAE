import { describe, expect, it } from 'vitest';
import { techLine } from './techLine';

describe('techLine', () => {
  it('shows the developer name and up to three stack items', () => {
    expect(techLine({ label: 'App Window', techLabel: 'UI', summary: 'Where you talk.', tech: ['React 19', 'Vite', 'zustand', 'ELK'] })).toEqual({
      name: 'UI',
      stack: ['React 19', 'Vite', 'zustand'],
    });
  });

  it('keeps whole stack items that fit the caption and drops the rest', () => {
    // "Electron Main · Electron · Node 24" is 34 characters; the next item would overflow.
    expect(techLine({ label: 'The Brain', techLabel: 'Electron Main', summary: 'Runs the engine.', tech: ['Electron', 'Node 24', 'Claude Agent SDK'] })).toEqual({
      name: 'Electron Main',
      stack: ['Electron', 'Node 24'],
    });
    expect(techLine({ label: 'Link', techLabel: 'IPC Bridge', summary: 'The contract.', tech: ['Electron IPC', 'TypeScript'] }, 30)).toEqual({ name: 'IPC Bridge', stack: ['Electron IPC'] });
    // A long name still shows (the caption ellipsizes it); the stack just yields.
    expect(techLine({ label: 'X', techLabel: 'A very long developer-facing name here', summary: 'S.', tech: ['Node'] })).toEqual({ name: 'A very long developer-facing name here', stack: [] });
  });

  it('is null for old nodes with nothing technical, so they render as before', () => {
    expect(techLine({ label: 'Home', summary: 'Start screen.' })).toBeNull();
    expect(techLine({ label: 'Home', techLabel: '  ', tech: [] })).toBeNull();
  });

  it('skips a techLabel that only repeats the label, and a stack item that repeats the name', () => {
    expect(techLine({ label: 'Postgres', techLabel: 'postgres', summary: 'Users.', tech: ['Postgres', 'Drizzle'] })).toEqual({ name: null, stack: ['Postgres', 'Drizzle'] });
    expect(techLine({ label: 'Saves recipes', techLabel: 'Postgres', summary: 'Users.', tech: ['Postgres', 'Drizzle'] })).toEqual({ name: 'Postgres', stack: ['Drizzle'] });
  });

  it("leaves the stack out when there's no summary, since the caption already shows it", () => {
    expect(techLine({ label: 'Window ↔ Brain Link', techLabel: 'IPC Bridge', tech: ['Electron IPC'] })).toEqual({ name: 'IPC Bridge', stack: [] });
    expect(techLine({ label: 'Voice Models', tech: ['Whisper'] })).toBeNull();
  });
});
