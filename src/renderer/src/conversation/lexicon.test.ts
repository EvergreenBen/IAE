import { describe, expect, it } from 'vitest';
import { applyOps, emptyMap } from '@shared/map';
import type { MapOp, NodeKind } from '@shared/model';
import { CONCEPTS, lexiconProposals, sameProposals } from './lexicon';

const node = (id: string, parentId: string | null, label: string, kind: NodeKind, tech?: string[]): MapOp => ({
  op: 'upsertNode',
  node: { id, parentId, label, kind, tech },
});

const sample = applyOps(emptyMap(), [
  node('web', null, 'Web App', 'client'),
  node('api', null, 'API', 'service'),
  node('api-auth', 'api', 'Auth', 'module'),
  node('api-billing', 'api', 'Billing', 'module'),
  node('data', null, 'Data', 'system'),
  node('postgres', 'data', 'Postgres', 'data'),
  node('images', 'data', 'Images', 'data', ['S3']),
  node('google', null, 'Google OAuth', 'external'),
]);

const labels = (text: string, map = emptyMap()) => lexiconProposals(text, map, { limit: 10 }).map((p) => p.label);

describe('lexicon', () => {
  it('has a broad vocabulary with unique labels', () => {
    expect(CONCEPTS.length).toBeGreaterThanOrEqual(80);
    const seen = new Set(CONCEPTS.map((c) => c.label));
    expect(seen.size).toBe(CONCEPTS.length);
  });

  it('turns spoken architecture into ghosts, in the order they were said', () => {
    expect(labels('friends plan hiking trips with stripe payments and a mobile app')).toEqual(['Stripe', 'Billing', 'Mobile App']);
  });

  it('understands everyday phrasings', () => {
    expect(labels('people log in with Google')).toEqual(['Auth', 'Google OAuth']);
    expect(labels('we need a db and a cache')).toEqual(['Database', 'Cache']);
    expect(labels('send a weekly digest email')).toEqual(['Scheduler', 'Email']);
    expect(labels('upload photos to s3')).toEqual(['Uploads', 'Images', 'S3']);
    expect(labels('live updates over websockets')).toEqual(['Realtime']);
    expect(labels('an admin dashboard for support')).toEqual(['Admin Panel']);
    expect(labels('Claude suggests substitutions')).toEqual(['AI Assistant']);
    expect(labels('deploy with GitHub Actions to Vercel')).toEqual(['CI/CD', 'Vercel']);
    expect(labels('show trails on a map with GPS')).toEqual(['Maps']);
    expect(labels('rate limiting and logging')).toEqual(['Rate Limiter', 'Monitoring']);
  });

  it('prefers the specific over the generic in one family', () => {
    expect(labels('store everything in a postgres database')).toEqual(['Postgres']);
    expect(labels('emails go out through resend')).toEqual(['Resend']);
    expect(labels('a redis cache')).toEqual(['Redis']);
  });

  it('keys ghosts by slug so they line up with real nodes', () => {
    const [p] = lexiconProposals('a mobile app', emptyMap());
    expect(p).toMatchObject({ key: 'mobile-app', label: 'Mobile App', kind: 'client', source: 'lexicon' });
    expect(p.confidence).toBeGreaterThan(0.5);
  });

  it('skips what is already on the map, by id, label or tech', () => {
    expect(labels('sign in with google, keep sessions in postgres, photos on S3', sample)).toEqual([]);
    expect(labels('add stripe', sample)).toEqual(['Stripe']);
  });

  it('places proposals near a plausible existing node', () => {
    const byLabel = Object.fromEntries(lexiconProposals('stripe webhooks, a redis cache, a mobile app and rate limits', sample, { limit: 10 }).map((p) => [p.label, p]));
    expect(byLabel.Stripe.connectsTo).toEqual(['api-billing']);
    expect(byLabel.Webhooks.nearNodeId).toBe('api-billing');
    expect(byLabel.Redis.nearNodeId).toBe('data');
    expect(byLabel.Redis.connectsTo).toEqual(['api']);
    expect(byLabel['Mobile App'].nearNodeId).toBeNull();
    expect(byLabel['Mobile App'].connectsTo).toEqual(['api']);
    expect(byLabel['Rate Limiter'].nearNodeId).toBe('api');
  });

  it('has no anchor on an empty map', () => {
    const [p] = lexiconProposals('auth', emptyMap());
    expect(p.nearNodeId).toBeNull();
    expect(p.connectsTo).toBeUndefined();
  });

  it('respects simple negation', () => {
    expect(labels("we don't need a database")).toEqual([]);
    expect(labels('no auth for now, just a web app')).toEqual(['Web App']);
    expect(labels('use postgres instead of mongo')).toEqual(['Postgres']);
  });

  it('avoids common false friends', () => {
    expect(labels('the rest of the page')).toEqual([]);
    expect(labels('log in')).toEqual(['Auth']);
    expect(labels('in order to ship')).toEqual([]);
    expect(labels('git push to main')).toEqual([]);
    expect(labels('review the code')).toEqual([]);
    expect(labels('ok')).toEqual([]);
  });

  it('works as the user types (partial words do not match)', () => {
    expect(labels('a pos')).toEqual([]);
    expect(labels('a postgres')).toEqual(['Postgres']);
  });

  it('caps the number of proposals (as many as the map shows at once)', () => {
    expect(lexiconProposals('auth billing search chat polls comments feed maps', emptyMap()).length).toBe(6);
  });

  it('compares proposal lists cheaply', () => {
    const a = lexiconProposals('stripe and redis', emptyMap());
    const b = lexiconProposals('stripe and redis!', emptyMap());
    expect(sameProposals(a, b)).toBe(true);
    expect(sameProposals(a, a.slice(1))).toBe(false);
  });

  it('while typing, a half-typed last word waits until it is finished', () => {
    const typed = (t: string) => lexiconProposals(t, emptyMap(), { typing: true }).map((p) => p.label);
    expect(typed('A cli')).toEqual([]); // could be "client"
    expect(typed('A cli ')).toEqual(['CLI']);
    expect(typed('A client app')).toEqual([]);
    expect(typed('trips in postgres')).toEqual(['Postgres']); // unmistakable
    expect(typed('a mobile app and an api')).toEqual(['Mobile App']);
    expect(typed('a mobile app and an api,')).toEqual(['Mobile App', 'API']);
    // Spoken drafts arrive in whole words.
    expect(labels('A cli')).toEqual(['CLI']);
  });
});
