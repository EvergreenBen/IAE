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
