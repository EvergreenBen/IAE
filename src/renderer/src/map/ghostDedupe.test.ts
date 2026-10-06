import { describe, expect, it } from 'vitest';
import type { GhostProposal, NodeKind } from '@shared/model';
import { dedupeGhosts } from './ghostDedupe';

const g = (label: string, kind: NodeKind = 'module', confidence = 0.7): GhostProposal => ({
  key: label.toLowerCase().replace(/\s+/g, '-'),
  label,
  kind,
  nearNodeId: null,
  confidence,
  source: 'sketch',
});
const labels = (gs: GhostProposal[]) => gs.map((x) => x.label);

describe('ghost dedupe', () => {
  it('merges the near-duplicates the two sketchers produce', () => {
    const out = dedupeGhosts([g('API', 'service'), g('API Server', 'service'), g('Redis', 'data'), g('Redis Cache', 'data'), g('Stripe', 'external'), g('Stripe Billing', 'module'), g('Billing')], []);
    expect(labels(out)).toEqual(['API', 'Redis', 'Stripe']);
  });

  it('a generic role yields to the named thing, on the map or among ghosts', () => {
    expect(labels(dedupeGhosts([g('Notes Database', 'data')], [{ label: 'Postgres' }]))).toEqual([]);
    expect(labels(dedupeGhosts([g('Database', 'data'), g('Postgres', 'data')], []))).toEqual(['Postgres']);
    expect(labels(dedupeGhosts([g('Cache', 'data')], [{ label: 'Data', tech: ['Redis'] }]))).toEqual([]);
  });

  it('keeps genuinely different ideas', () => {
    expect(labels(dedupeGhosts([g('Postgres', 'data'), g('Redis', 'data'), g('Web App', 'client'), g('Mobile App', 'client')], []))).toEqual(['Postgres', 'Redis', 'Web App', 'Mobile App']);
    expect(labels(dedupeGhosts([g('MySQL', 'data')], [{ label: 'Postgres' }]))).toEqual(['MySQL']);
  });

  it('treats near-synonyms as one idea', () => {
    expect(labels(dedupeGhosts([g('Polls'), g('Voting System')], []))).toEqual(['Polls']);
    expect(labels(dedupeGhosts([g('Payments'), g('Billing'), g('Stripe Billing')], []))).toEqual(['Stripe Billing']);
    expect(labels(dedupeGhosts([g('Auth'), g('Member Auth'), g('Login')], []))).toEqual(['Auth']);
    expect(labels(dedupeGhosts([g('Notifications'), g('Notification Service')], []))).toEqual(['Notifications']);
    expect(labels(dedupeGhosts([g('Voting')], [{ label: 'Polls' }]))).toEqual([]);
    expect(labels(dedupeGhosts([g('Sign In')], [{ label: 'Auth' }]))).toEqual([]);
  });

  it('keeps the words of the ghost already showing when a synonym arrives', () => {
    expect(labels(dedupeGhosts([g('Polls', 'module', 0.6), g('Voting System', 'module', 0.8)], [], new Set(['polls'])))).toEqual(['Polls']);
    // ...but a named product still takes over from the generic role.
    expect(labels(dedupeGhosts([g('Payments'), g('Stripe')], [], new Set(['payments'])))).toEqual(['Stripe']);
  });

  it('does not merge different things that share a word', () => {
    expect(labels(dedupeGhosts([g('Message Queue'), g('Chat')], []))).toEqual(['Message Queue', 'Chat']);
    expect(labels(dedupeGhosts([g('Member Profiles'), g('Auth')], []))).toEqual(['Member Profiles', 'Auth']);
    expect(labels(dedupeGhosts([g('Game Server'), g('API')], []))).toEqual(['Game Server', 'API']);
  });
});
