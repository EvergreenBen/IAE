import { describe, expect, it } from 'vitest';
import { applyOps, emptyMap } from '../../shared/map';
import { compactMap, parseProposals } from './sketcher';

const map = applyOps(emptyMap(), [
  { op: 'upsertNode', node: { id: 'api', label: 'API', kind: 'service' } },
  { op: 'upsertNode', node: { id: 'postgres', label: 'Postgres', kind: 'data' } },
]);

describe('parseProposals', () => {
  it('reads a JSON array even inside prose or a code fence', () => {
    const raw = 'Sure:\n```json\n[{"label":"Meal Planner","kind":"module","near":"api","connects":["postgres","ghost"],"confidence":0.8}]\n```';
    expect(parseProposals(raw, map)).toEqual([
      { key: 'meal-planner', label: 'Meal Planner', kind: 'module', nearNodeId: 'api', connectsTo: ['postgres'], confidence: 0.8, source: 'sketch' },
    ]);
  });

  it('drops what is already on the map, duplicates and junk', () => {
    const raw = JSON.stringify([
      { label: 'Postgres', kind: 'data' },
      { label: 'api', kind: 'service' },
      { label: 'Stripe', kind: 'payments', near: 'nowhere', confidence: 7 },
      { label: 'stripe' },
      { kind: 'module' },
      'nonsense',
    ]);
    expect(parseProposals(raw, map)).toEqual([
      { key: 'stripe', label: 'Stripe', kind: 'module', nearNodeId: null, connectsTo: [], confidence: 1, source: 'sketch' },
    ]);
  });

  it('returns nothing for unparseable output', () => {
    expect(parseProposals('no idea', map)).toEqual([]);
    expect(parseProposals('[{"label": ', map)).toEqual([]);
    expect(parseProposals('{"label":"x"}', map)).toEqual([]);
  });

  it('caps the number of proposals', () => {
    const raw = JSON.stringify(Array.from({ length: 10 }, (_, i) => ({ label: `Thing ${i}`, kind: 'module' })));
    expect(parseProposals(raw, map)).toHaveLength(4);
  });
});

describe('compactMap', () => {
  it('lists ids and labels', () => {
    expect(compactMap(map)).toBe('api (API), postgres (Postgres)');
    expect(compactMap(emptyMap())).toBe('(none yet)');
  });
});
