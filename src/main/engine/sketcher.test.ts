import { describe, expect, it } from 'vitest';
import { applyOps, emptyMap } from '../../shared/map';
import type { GhostProposal } from '../../shared/model';
import { compactMap, MAX_GHOSTS, mentioned, mergeProposals, parseProposals, sameComponent, withoutCarryover } from './sketcher';

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
    expect(parseProposals(raw, map)).toHaveLength(6);
  });
});

describe('compactMap', () => {
  it('lists ids and labels', () => {
    expect(compactMap(map)).toBe('api (API), postgres (Postgres)');
    expect(compactMap(emptyMap())).toBe('(none yet)');
  });
});

const ghost = (label: string, confidence = 0.8, near: string | null = null): GhostProposal => ({
  key: label.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  label,
  kind: 'module',
  nearNodeId: near,
  connectsTo: [],
  confidence,
  source: 'sketch',
});

describe('sameComponent', () => {
  it('matches plurals, -ing/-er forms, abbreviations and word order', () => {
    expect(sameComponent('Route Tracking', 'Route Tracker')).toBe(true);
    expect(sameComponent('Class Booking', 'Class Bookings')).toBe(true);
    expect(sameComponent('Member Auth', 'Member Authentication')).toBe(true);
    expect(sameComponent('Membership Validation', 'Membership Validator')).toBe(true);
    expect(sameComponent('QR Check-In', 'Check-in QR')).toBe(true);
  });
  it('keeps different components apart', () => {
    expect(sameComponent('Check-In', 'QR Scanner')).toBe(false);
    expect(sameComponent('Class Booking', 'Class Payments')).toBe(false);
    expect(sameComponent('Route Tracking', 'Route')).toBe(false);
    expect(sameComponent('', '')).toBe(false);
  });
});

describe('mergeProposals', () => {
  it('accumulates across drafts of one utterance (the Crag Night case)', () => {
    let shown: GhostProposal[] = [];
    for (const answer of [
      [ghost('Class Booking'), ghost('Member Auth')],
      [ghost('Route Tracking')],
      [ghost('Check-In'), ghost('QR Scanner')],
      [ghost('Membership Validation')],
    ])
      shown = mergeProposals(shown, answer, map);
    expect(shown.map((g) => g.label)).toEqual(['Class Booking', 'Member Auth', 'Route Tracking', 'Check-In', 'QR Scanner', 'Membership Validation']);
  });

  it('keeps the first key and label for the same component, refreshing placement', () => {
    const first = mergeProposals([], [ghost('Route Tracking', 0.6)], map);
    const next = mergeProposals(first, [ghost('Route Tracker', 0.9, 'api'), ghost('Class Booking')], map);
    expect(next[0]).toMatchObject({ key: 'route-tracking', label: 'Route Tracking', nearNodeId: 'api', confidence: 0.9 });
    expect(next.map((g) => g.key)).toEqual(['route-tracking', 'class-booking']);
  });

  it('drops ghosts that have landed on the map since', () => {
    const shown = [ghost('Meal Planner'), ghost('Stripe')];
    const withStripe = applyOps(map, [{ op: 'upsertNode', node: { id: 'payments', label: 'Stripe', kind: 'external' } }]);
    expect(mergeProposals(shown, [], withStripe).map((g) => g.label)).toEqual(['Meal Planner']);
  });

  it(`shows at most ${MAX_GHOSTS}: what the latest answer doesn't list goes first, least likely first`, () => {
    const many = Array.from({ length: MAX_GHOSTS }, (_, i) => ghost(`Thing ${i}`, i === 2 ? 0.5 : 0.9));
    const out = mergeProposals(many, [ghost('New Idea', 0.6), ghost('Thing 2', 0.5)], map);
    expect(out).toHaveLength(MAX_GHOSTS);
    expect(out.map((g) => g.label)).toEqual([...many.slice(1).map((g) => g.label), 'New Idea']);
    const capped = mergeProposals([], Array.from({ length: MAX_GHOSTS + 2 }, (_, i) => ghost(`Idea ${i}`, 0.5 + i / 40)), map);
    expect(capped.map((g) => g.label)).toEqual(Array.from({ length: MAX_GHOSTS }, (_, i) => `Idea ${i + 2}`));
  });

  it("never shows the product's own name as a component", () => {
    const out = mergeProposals([], [ghost('Crag Night'), ghost('Class Booking')], map, { exclude: ['Crag Night'] });
    expect(out.map((g) => g.label)).toEqual(['Class Booking']);
  });
});

describe('withoutCarryover', () => {
  it("drops a component from the last sentence unless the new one names it", () => {
    const before = [ghost('Meal Planner')];
    const next = [ghost('Meal Planner'), ghost('Collections')];
    expect(withoutCarryover(next, before, 'users can save recipes into collections and share them with').map((g) => g.label)).toEqual(['Collections']);
    expect(withoutCarryover(next, before, 'the meal plans should also have collections').map((g) => g.label)).toEqual(['Meal Planner', 'Collections']);
    expect(withoutCarryover(next, [], 'anything')).toEqual(next);
  });

  it('matches words loosely', () => {
    expect(mentioned('Route Tracking', "track the routes they've climbed")).toBe(true);
    expect(mentioned('Push Notifications', 'send a push notification when')).toBe(true);
    expect(mentioned('Stripe', 'pay for premium')).toBe(false);
  });
});
