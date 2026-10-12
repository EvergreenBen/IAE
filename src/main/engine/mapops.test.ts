import { describe, expect, it } from 'vitest';
import { applyOps, emptyMap } from '../../shared/map';
import { describeResult, normalizeOps } from './mapops';

const base = applyOps(emptyMap(), [
  { op: 'upsertNode', node: { id: 'api', label: 'API', kind: 'service' } },
  { op: 'upsertNode', node: { id: 'web', label: 'Web', kind: 'client' } },
]);

describe('normalizeOps', () => {
  it('accepts nested and flattened upserts, creating parents before children', () => {
    const r = normalizeOps(
      [
        { op: 'upsertNode', node: { id: 'Billing', label: 'Billing', kind: 'module', parentId: 'api' } },
        { op: 'upsertNode', id: 'billing-stripe', label: 'Stripe', kind: 'third-party', parentId: 'billing' },
      ],
      base,
    );
    expect(r.nodeIds).toEqual(['billing', 'billing-stripe']);
    expect(r.ops[1]).toMatchObject({ node: { id: 'billing-stripe', parentId: 'billing', kind: 'external' } });
    expect(r.notes.some((n) => n.includes('normalised to "billing"'))).toBe(true);
  });

  it('keeps a trimmed techLabel next to the plain label, and leaves it alone when omitted', () => {
    const r = normalizeOps(
      [
        { op: 'upsertNode', node: { id: 'api', label: 'Serves the app', techLabel: '  Hono API  ' } },
        { op: 'upsertNode', node: { id: 'web', techLabel: '   ' } },
        { op: 'upsertNode', node: { id: 'docs', techLabel: 'x'.repeat(60) } },
      ],
      base,
    );
    expect(r.ops[0]).toMatchObject({ node: { id: 'api', label: 'Serves the app', techLabel: 'Hono API' } });
    expect(r.ops[1]).toEqual({ op: 'upsertNode', node: { id: 'web' } });
    expect((r.ops[2] as { node: { techLabel: string } }).node.techLabel).toHaveLength(40);
    const m = applyOps(base, r.ops);
    expect(applyOps(m, [{ op: 'upsertNode', node: { id: 'api', summary: 'Hono server' } }]).nodes.api.techLabel).toBe('Hono API');
    expect(m.nodes.web.techLabel).toBeUndefined();
  });

  it('places nodes with unknown parents at the top level and says so', () => {
    const r = normalizeOps([{ op: 'upsertNode', node: { id: 'cache', parentId: 'nope', kind: 'database' } }], base);
    expect(r.ops[0]).toMatchObject({ node: { id: 'cache', parentId: null, kind: 'data', label: 'Cache' } });
    expect(r.notes[0]).toMatch(/parent "nope" doesn't exist/);
  });

  it('refuses parent cycles, including ones built up across the batch', () => {
    const r = normalizeOps(
      [
        { op: 'upsertNode', node: { id: 'api-auth', label: 'Auth', parentId: 'api' } },
        { op: 'upsertNode', node: { id: 'api-auth-oauth', label: 'OAuth', parentId: 'api-auth' } },
        { op: 'upsertNode', node: { id: 'api', parentId: 'api-auth-oauth', summary: 'Hono server' } },
        { op: 'moveNode', id: 'api-auth', parentId: 'api-auth-oauth' },
        { op: 'moveNode', id: 'web', parentId: 'api-auth' },
      ],
      base,
    );
    expect(r.ops[2]).toEqual({ op: 'upsertNode', node: { id: 'api', summary: 'Hono server' } });
    expect(r.ops.filter((o) => o.op === 'moveNode')).toEqual([{ op: 'moveNode', id: 'web', parentId: 'api-auth' }]);
    expect(r.notes.filter((n) => /descendant/.test(n))).toHaveLength(2);
  });

  it('keeps an existing node’s fields when the op omits them', () => {
    const r = normalizeOps([{ op: 'upsertNode', node: { id: 'api', summary: 'Hono server' } }], base);
    expect(r.ops[0]).toEqual({ op: 'upsertNode', node: { id: 'api', summary: 'Hono server' } });
  });

  it('skips edges to missing nodes and normalises edge kinds', () => {
    const r = normalizeOps(
      [
        { op: 'upsertEdge', edge: { from: 'web', to: 'api', kind: 'http', label: 'REST' } },
        { op: 'upsertEdge', edge: { from: 'web', to: 'ghost' } },
      ],
      base,
    );
    expect(r.ops).toEqual([{ op: 'upsertEdge', edge: { id: 'web->api', from: 'web', to: 'api', kind: 'calls', label: 'REST' } }]);
    expect(r.notes[0]).toMatch(/no node "ghost"/);
  });

  it('enforces the allowed op set', () => {
    const r = normalizeOps([{ op: 'removeNode', id: 'api' }, { op: 'explode' }], base, { allowed: ['upsertNode', 'upsertEdge'] });
    expect(r.ops).toEqual([]);
    expect(r.notes).toHaveLength(2);
    expect(describeResult(r)).toMatch(/^Nothing applied/);
  });

  it('applies the default status to new nodes only, and relativises absolute paths', () => {
    const r = normalizeOps(
      [
        { op: 'upsertNode', node: { id: 'auth', paths: ['/repo/apps/api/auth/', './apps/api/x.ts'] } },
        { op: 'upsertNode', node: { id: 'api' } },
      ],
      base,
      { root: '/repo', defaultStatus: ({ paths }) => (paths?.length ? 'built' : 'planned') },
    );
    expect(r.ops[0]).toMatchObject({ node: { id: 'auth', status: 'built', paths: ['apps/api/auth/', 'apps/api/x.ts'] } });
    expect(r.ops[1]).toEqual({ op: 'upsertNode', node: { id: 'api' } });
  });

  it('handles remove, move and removeEdge with validation', () => {
    const withEdge = applyOps(base, [{ op: 'upsertEdge', edge: { from: 'web', to: 'api' } }]);
    const r = normalizeOps(
      [
        { op: 'moveNode', id: 'web', parentId: 'api' },
        { op: 'removeEdge', id: 'web->api' },
        { op: 'removeNode', id: 'missing' },
      ],
      withEdge,
    );
    expect(r.ops.map((o) => o.op)).toEqual(['moveNode', 'removeEdge']);
    expect(r.notes[0]).toMatch(/no node "missing"/);
  });
});
