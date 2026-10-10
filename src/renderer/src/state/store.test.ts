import { describe, expect, it } from 'vitest';
import { emptyMap } from '@shared/map';
import type { GhostProposal } from '@shared/model';
import { foldSketch, initialState, reduce } from './store';

const sk = (label: string, confidence = 0.6): GhostProposal => ({ key: label.toLowerCase().replace(/\s+/g, '-'), label, kind: 'module', confidence, source: 'sketch' });

describe('ghost proposals', () => {
  it('accumulate within one utterance, newest proposal per key winning', () => {
    let s = { ...initialState(), map: emptyMap() };
    s = { ...s, ...reduce(s, { type: 'ghost/proposals', draftId: 'd1', proposals: [sk('Polls', 0.5), sk('Maps')] }) };
    s = { ...s, ...reduce(s, { type: 'ghost/proposals', draftId: 'd1', proposals: [sk('Polls', 0.9), sk('Chat')] }) };
    expect(Object.keys(s.ghosts).sort()).toEqual(['chat', 'maps', 'polls']);
    expect(s.ghosts.polls.confidence).toBe(0.9);
  });

  it('a new utterance starts a fresh sketch, and lexicon ghosts stay', () => {
    const lex: GhostProposal = { ...sk('CLI'), source: 'lexicon' };
    const s = { ghosts: { 'lex:cli': lex, polls: sk('Polls') }, ghostDraftId: 'd1', map: emptyMap() };
    const next = foldSketch(s, 'd2', [sk('Maps')]);
    expect(Object.keys(next.ghosts).sort()).toEqual(['lex:cli', 'maps']);
    expect(next.ghostDraftId).toBe('d2');
  });

  it('never proposes what is already on the map', () => {
    const map = { ...emptyMap(), nodes: { polls: { id: 'polls', parentId: null, label: 'Polls', kind: 'module' as const, status: 'built' as const, createdAt: 0, updatedAt: 0 } } };
    const next = foldSketch({ ghosts: {}, ghostDraftId: 'd1', map }, 'd1', [sk('Polls'), sk('Maps')]);
    expect(Object.keys(next.ghosts)).toEqual(['maps']);
  });
});

describe('a window that reloads mid-job', () => {
  it('gets the crew back as it was: agents, their steps and the OK they wait for', () => {
    const agent = { id: 'ada', name: 'Ada', role: 'builder' as const, hue: 0, status: 'waiting' as const, task: 'Kokoro', nodeId: null, startedAt: 1 };
    const step = { at: 2, kind: 'edit' as const, text: 'Editing tts.ts', path: 'src/tts.ts' };
    const perm = { id: 'perm-1', agentId: 'ada', tool: 'Bash', summary: 'Run npm test', nodeId: null };
    const s = reduce(initialState(), {
      type: 'project/opened',
      snapshot: {
        project: { root: '/p', name: 'p', isNew: false, lastOpenedAt: 1 },
        map: emptyMap(),
        files: [],
        agenda: [],
        agents: [agent],
        agentSteps: { ada: [step] },
        permissions: [perm],
        decisions: [],
        transcript: [],
      },
    });
    expect(s.screen).toBe('project');
    expect(s.agents?.ada).toEqual(agent);
    expect(s.agentSteps).toEqual({ ada: [step] });
    expect(s.permissions).toEqual([perm]);
  });

  it('starts at boot, deciding where to go, and remembers the app went stale across a project switch', () => {
    expect(initialState().screen).toBe('boot');
    const stale = { ...initialState(), ...reduce(initialState(), { type: 'app/stale', files: ['src/main/index.ts'] }) };
    expect(reduce(stale, { type: 'project/closed' }).stale).toEqual(['src/main/index.ts']);
  });
});

describe("the lead's turn", () => {
  it('knows whether the turn in flight has said anything yet (an opener before its tools counts)', () => {
    let s = initialState();
    const step = (e: Parameters<typeof reduce>[1]) => (s = { ...s, ...reduce(s, e) });
    step({ type: 'lead/state', state: 'thinking' });
    expect(s.lead.spoke).toBe(false);
    step({ type: 'lead/delta', turnId: 't1', text: 'Let me look at tts.ts.' });
    expect(s.lead.spoke).toBe(true);
    // Looking at code after the opener: still the same turn, and it has spoken.
    step({ type: 'lead/state', state: 'thinking' });
    expect(s.lead.spoke).toBe(true);
    step({ type: 'lead/done', turnId: 't1', text: 'Let me look at tts.ts. It chunks by sentence.' });
    step({ type: 'lead/state', state: 'idle' });
    // The next turn starts fresh.
    step({ type: 'lead/state', state: 'thinking' });
    expect(s.lead.spoke).toBe(false);
  });
});
