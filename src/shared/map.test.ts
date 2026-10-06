import { describe, expect, it } from 'vitest';
import { applyOps, assignFiles, describeMap, emptyMap, liftedEdges, ownerOf, slug } from './map';
import type { MapOp } from './model';

const node = (id: string, parentId: string | null = null, extra: Record<string, unknown> = {}): MapOp => ({
  op: 'upsertNode',
  node: { id, parentId, label: id, kind: 'module', ...extra },
});
const edge = (from: string, to: string, kind: 'calls' | 'reads' = 'calls', label?: string): MapOp => ({ op: 'upsertEdge', edge: { from, to, kind, label } });

const sample = () =>
  applyOps(emptyMap(), [
    node('web'),
    node('web-pages', 'web'),
    node('api', null, { paths: ['apps/api/'] }),
    node('api-auth', 'api', { paths: ['apps/api/src/auth/'] }),
    node('api-config', 'api', { paths: ['apps/api/.env', 'apps/api/src/config.ts'] }),
    node('db', null, { paths: ['apps/api/db/**/*.sql'] }),
    edge('web-pages', 'api-auth', 'calls', 'REST'),
    edge('web', 'api', 'calls'),
    edge('api-auth', 'db', 'reads'),
  ]);

describe('applyOps', () => {
  it('creates nodes with defaults and merges later upserts', () => {
    const m = applyOps(emptyMap(), [node('api'), { op: 'upsertNode', node: { id: 'api', summary: 'Serves things', status: 'built' } }], 1000);
    expect(m.nodes.api).toMatchObject({ id: 'api', label: 'api', kind: 'module', status: 'built', summary: 'Serves things', parentId: null, createdAt: 1000 });
  });

  it('returns the same map when there are no ops', () => {
    const m = sample();
    expect(applyOps(m, [])).toBe(m);
  });

  it('removes a subtree and every edge touching it', () => {
    const m = applyOps(sample(), [{ op: 'removeNode', id: 'api' }]);
    expect(Object.keys(m.nodes).sort()).toEqual(['db', 'web', 'web-pages']);
    expect(Object.keys(m.edges)).toEqual([]);
  });

  it('refuses to move a node under its own descendant', () => {
    const m = applyOps(sample(), [{ op: 'moveNode', id: 'api', parentId: 'api-auth' }]);
    expect(m.nodes.api.parentId).toBeNull();
    const moved = applyOps(sample(), [{ op: 'moveNode', id: 'db', parentId: 'api' }]);
    expect(moved.nodes.db.parentId).toBe('api');
  });

  it('lifts nodes with unknown parents to the top level and drops dangling edges', () => {
    const m = applyOps(emptyMap(), [node('orphan', 'nowhere'), node('a'), edge('a', 'ghost')]);
    expect(m.nodes.orphan.parentId).toBeNull();
    expect(Object.keys(m.edges)).toEqual([]);
  });

  it('ignores self edges and keys edges by from->to', () => {
    const m = applyOps(emptyMap(), [node('a'), node('b'), edge('a', 'a'), edge('a', 'b')]);
    expect(Object.keys(m.edges)).toEqual(['a->b']);
  });
});

describe('liftedEdges', () => {
  it('lifts deep edges to the visible children of the scope and merges them', () => {
    const top = liftedEdges(sample(), null);
    const webApi = top.find((e) => e.id === 'web->api');
    expect(webApi).toMatchObject({ from: 'web', to: 'api', weight: 2, labels: ['REST'] });
    expect(top.find((e) => e.id === 'api->db')).toMatchObject({ kinds: ['reads'] });
  });

  it('drops edges internal to a single child', () => {
    const m = applyOps(sample(), [node('api-recipes', 'api'), edge('api-recipes', 'api-auth')]);
    expect(liftedEdges(m, null).some((e) => e.from === e.to)).toBe(false);
    expect(liftedEdges(m, 'api').map((e) => e.id)).toEqual(['api-recipes->api-auth']);
  });
});

describe('ownerOf / assignFiles', () => {
  it('picks the deepest matching node', () => {
    const m = sample();
    expect(ownerOf(m, 'apps/api/src/auth/session.ts')).toBe('api-auth');
    expect(ownerOf(m, 'apps/api/src/index.ts')).toBe('api');
    expect(ownerOf(m, 'apps/web/page.tsx')).toBeNull();
  });

  it('matches exact files and globs', () => {
    const m = sample();
    expect(ownerOf(m, 'apps/api/.env')).toBe('api-config');
    expect(ownerOf(m, 'apps/api/db/migrations/0001.sql')).toBe('db');
    expect(ownerOf(m, 'apps/api/db/client.ts')).toBe('api');
  });

  it('breaks depth ties by the more specific pattern', () => {
    const m = applyOps(emptyMap(), [node('config', null, { paths: ['*'] }), node('docs', null, { paths: ['docs/', '*.md'] })]);
    expect(ownerOf(m, 'README.md')).toBe('docs');
    expect(ownerOf(m, 'package.json')).toBe('config');
    expect(ownerOf(m, 'src/x.ts')).toBeNull();
  });

  it('assigns every file its owner', () => {
    const files = assignFiles(sample(), [
      { path: 'apps/api/.env', size: 1, mtime: 0 },
      { path: 'nowhere.txt', size: 1, mtime: 0 },
    ]);
    expect(files.map((f) => f.nodeId)).toEqual(['api-config', null]);
  });
});

describe('describeMap / slug', () => {
  it('renders an indented tree with connections', () => {
    const text = describeMap(sample());
    expect(text).toContain('- api [api] (module, planned)');
    expect(text).toContain('  - api-auth [api-auth]');
    expect(text).toContain('web-pages → api-auth (calls: REST)');
    expect(describeMap(emptyMap())).toMatch(/empty/);
  });

  it('slugs labels into kebab ids', () => {
    expect(slug('Recipe API')).toBe('recipe-api');
    expect(slug('  Stripe  Webhooks! ')).toBe('stripe-webhooks');
    expect(slug('???')).toBe('node');
  });
});

describe('parent cycles', () => {
  it('refuses to reparent a node under its own descendant', async () => {
    const { applyOps, emptyMap, descendantIds, childrenOf } = await import('./map');
    let m = applyOps(emptyMap(), [
      { op: 'upsertNode', node: { id: 'backend', parentId: null, label: 'Backend' } },
      { op: 'upsertNode', node: { id: 'api', parentId: 'backend', label: 'API' } },
    ]);
    m = applyOps(m, [{ op: 'upsertNode', node: { id: 'backend', parentId: 'api' } }]);
    expect(m.nodes.backend.parentId).toBeNull();
    expect(m.nodes.api.parentId).toBe('backend');
    expect(childrenOf(m, null).map((n) => n.id)).toEqual(['backend']);
    expect(descendantIds(m, 'backend')).toEqual(['api']);
  });

  it('terminates on a cyclic map loaded from disk', async () => {
    const { descendantIds } = await import('./map');
    const cyclic = {
      version: 1 as const,
      nodes: {
        a: { id: 'a', parentId: 'b', label: 'A', kind: 'module' as const, status: 'built' as const, createdAt: 0, updatedAt: 0 },
        b: { id: 'b', parentId: 'a', label: 'B', kind: 'module' as const, status: 'built' as const, createdAt: 0, updatedAt: 0 },
      },
      edges: {},
    };
    expect(descendantIds(cyclic, 'a')).toEqual(['b']);
  });
});

describe('projectFolderName', () => {
  it('keeps readable names and strips unsafe characters', async () => {
    const { projectFolderName } = await import('./map');
    expect(projectFolderName('Recipe Box')).toBe('Recipe Box');
    expect(projectFolderName('a/b:c')).toBe('a b c');
    expect(projectFolderName('...hidden')).toBe('hidden');
    expect(projectFolderName('   ')).toBe('Untitled');
    expect(projectFolderName('Café ☕')).toBe('Café ☕');
  });
});

describe('parent cycles within one batch', () => {
  it('refuses a cycle formed by forward references', async () => {
    const { applyOps, emptyMap, childrenOf } = await import('./map');
    const m = applyOps(emptyMap(), [
      { op: 'upsertNode', node: { id: 'api', parentId: 'backend', label: 'API' } },
      { op: 'upsertNode', node: { id: 'backend', parentId: 'api', label: 'Backend' } },
    ]);
    expect(childrenOf(m, null).length).toBeGreaterThan(0);
  });
});
