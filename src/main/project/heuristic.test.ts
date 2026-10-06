import { describe, expect, it } from 'vitest';
import { assignFiles, ownerOf } from '../../shared/map';
import { heuristicMap, humanize, kindForName } from './heuristic';

const MONOREPO = [
  'package.json',
  'README.md',
  '.gitignore',
  'infra/docker-compose.yml',
  '.github/workflows/ci.yml',
  'apps/web/package.json',
  'apps/web/app/page.tsx',
  'apps/web/app/layout.tsx',
  'apps/web/components/RecipeCard.tsx',
  'apps/web/lib/api.ts',
  'apps/api/package.json',
  'apps/api/.env',
  'apps/api/.env.example',
  'apps/api/src/index.ts',
  'apps/api/src/config.ts',
  'apps/api/src/auth/session.ts',
  'apps/api/src/recipes/routes.ts',
  'apps/api/src/search/index.ts',
  'apps/api/db/schema.ts',
  'apps/api/db/migrations/0001_init.sql',
  'apps/jobs/package.json',
  'apps/jobs/src/thumbs/worker.ts',
  'apps/jobs/src/digest/weekly.ts',
];

const MANIFESTS = {
  'apps/web/package.json': JSON.stringify({ dependencies: { next: '15', react: '19' } }),
  'apps/api/package.json': JSON.stringify({ dependencies: { hono: '4', 'drizzle-orm': '1', pg: '8' } }),
};

describe('heuristicMap', () => {
  const map = heuristicMap(MONOREPO, MANIFESTS, 1000);
  const n = map.nodes;

  it('turns apps/* into top-level nodes classified by name and manifest', () => {
    expect(n.web).toMatchObject({ kind: 'client', parentId: null, paths: ['apps/web/'], status: 'built' });
    expect(n.web.tech).toEqual(['Next.js', 'React']);
    expect(n.api).toMatchObject({ kind: 'service', label: 'API', tech: ['Hono', 'Drizzle', 'Postgres'] });
    expect(n.jobs).toMatchObject({ kind: 'queue' });
  });

  it('nests modules from src/* and sibling folders', () => {
    expect(n['api-auth']).toMatchObject({ parentId: 'api', paths: ['apps/api/src/auth/'] });
    expect(n['api-db']).toMatchObject({ parentId: 'api', kind: 'data', paths: ['apps/api/db/'] });
    expect(n['web-components']).toMatchObject({ parentId: 'web' });
  });

  it('gives the service a Config child that owns its .env', () => {
    expect(n['api-config']).toMatchObject({ parentId: 'api', kind: 'config' });
    expect(ownerOf(map, 'apps/api/.env')).toBe('api-config');
    expect(ownerOf(map, 'apps/api/.env.example')).toBe('api-config');
    expect(ownerOf(map, 'apps/api/src/config.ts')).toBe('api-config');
  });

  it('groups infra and root config, and leaves nothing important unowned', () => {
    expect(n.infra).toMatchObject({ kind: 'infra' });
    expect(n['infra-github']).toMatchObject({ parentId: 'infra', label: 'CI' });
    expect(Object.values(n).some((x) => x.label === 'Infra' && x.parentId === 'infra')).toBe(false);
    expect(ownerOf(map, 'package.json')).toBe('config');
    const unowned = assignFiles(map, MONOREPO.map((path) => ({ path, size: 1, mtime: 0 }))).filter((f) => !f.nodeId);
    expect(unowned).toEqual([]);
  });

  it('only draws edges it can be sure of', () => {
    expect(Object.keys(map.edges).sort()).toEqual(['api->jobs', 'web->api']);
  });

  it('expands a structured src/ in a single-package repo', () => {
    const m = heuristicMap(['package.json', 'src/main/index.ts', 'src/renderer/App.tsx', 'src/shared/model.ts', 'docs/ARCH.md', 'scripts/x.mjs']);
    expect(m.nodes.main).toMatchObject({ kind: 'service', paths: ['src/main/'] });
    expect(m.nodes.renderer).toMatchObject({ kind: 'client' });
    expect(m.nodes.docs).toMatchObject({ paths: ['docs/', '*.md'] });
    expect(m.nodes.scripts).toBeDefined();
  });

  it('is fast on a large repo', () => {
    const paths: string[] = [];
    for (let a = 0; a < 20; a++) for (let b = 0; b < 30; b++) for (let c = 0; c < 10; c++) paths.push(`packages/pkg${a}/src/mod${b}/file${c}.ts`);
    const t = performance.now();
    const m = heuristicMap(paths);
    expect(performance.now() - t).toBeLessThan(200);
    expect(Object.keys(m.nodes).length).toBeGreaterThan(20);
  });

  it('returns an empty map for an empty folder', () => {
    expect(Object.keys(heuristicMap([]).nodes)).toEqual([]);
  });
});

describe('naming', () => {
  it('humanizes folder names with acronyms', () => {
    expect(humanize('api')).toBe('API');
    expect(humanize('user-service')).toBe('User Service');
    expect(humanize('paymentGateway')).toBe('Payment Gateway');
  });

  it('classifies common folder names', () => {
    expect(kindForName('frontend')).toBe('client');
    expect(kindForName('backend')).toBe('service');
    expect(kindForName('prisma')).toBe('data');
    expect(kindForName('workers')).toBe('queue');
    expect(kindForName('.github')).toBe('infra');
    expect(kindForName('utils')).toBeNull();
  });
});
