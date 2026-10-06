import { describe, expect, it } from 'vitest';
import type { AgentInfo } from '@shared/model';
import type { Anchor } from './anchors';
import { permsOnMap, tokenPoint } from './permHome';
import { permissionText, shortenPaths, stripCd } from './permText';

describe('permission text', () => {
  it('drops the builder’s cd prefix so the real command shows', () => {
    expect(stripCd('cd "/Users/ben/Projects/group trips" && npm install fastify vitest')).toBe('npm install fastify vitest');
    expect(stripCd("cd '/tmp/x'; npm test")).toBe('npm test');
    expect(stripCd('cd /a/b && cd web && pnpm build')).toBe('pnpm build');
    expect(stripCd('cd /a/b')).toBe('cd /a/b'); // nothing after it: keep what was asked
    expect(stripCd('npm test')).toBe('npm test');
  });

  it('shortens long paths in the middle, keeping the last segment', () => {
    expect(shortenPaths('cat /Users/benwilliams/Projects/trips/src/db/schema.ts')).toBe('cat /Users/…/schema.ts');
    expect(shortenPaths('node ./scripts/a.js')).toBe('node ./scripts/a.js');
    expect(shortenPaths('rm -rf ~/Library/Caches/some-long-folder-name/x')).toBe('rm -rf ~/…/x');
  });

  it('reads as "Run <command>?" with the whole thing for the tooltip', () => {
    const t = permissionText('Bash', 'Run cd "/Users/benwilliams/Projects/group-trips" && npm install fastify vitest @fastify/cors @types/n…');
    expect(t.verb).toBe('Run');
    expect(t.code).toBe('npm install fastify vitest @fastify/cors @types/n…');
    const full = permissionText('Bash', 'Run cd "/x" && npm i…', 'cd "/x" && npm install fastify vitest @fastify/cors @types/node zod');
    expect(full.full).toBe('npm install fastify vitest @fastify/cors @types/node zod');
  });

  it('sets file names in mono for edits', () => {
    expect(permissionText('Edit', 'Edit schema.ts')).toMatchObject({ verb: 'Edit', code: 'schema.ts' });
    expect(permissionText('mcp__github__create_pr', 'Use github create_pr')).toEqual({ verb: 'Use github create_pr' });
  });
});

describe('where a prompt shows', () => {
  const agent = (id: string, startedAt: number): AgentInfo => ({ id, name: id, role: 'builder', hue: 0, task: 't', nodeId: 'api', status: 'working', startedAt });
  const at: Anchor = { id: 'api', rect: { x: 100, y: 100, w: 200, h: 72 }, frame: false };
  const anchorOf = () => at;
  const perm = (agentId: string) => ({ id: `p-${agentId}`, agentId, tool: 'Bash', summary: 'Run npm test', nodeId: 'api' });

  it('on the token while the token is on screen, in the chrome when it is not', () => {
    expect([...permsOnMap([agent('ada', 1)], [perm('ada')], anchorOf, () => true, 1)]).toEqual(['ada']);
    expect([...permsOnMap([agent('ada', 1)], [perm('ada')], anchorOf, () => false, 1)]).toEqual([]);
  });

  it('one prompt per node on the map; a second builder asking shows in the chrome', () => {
    const out = permsOnMap([agent('ada', 1), agent('kit', 2)], [perm('kit'), perm('ada')], anchorOf, () => true, 1);
    expect([...out]).toEqual(['ada']);
    expect([...permsOnMap([agent('ada', 1), agent('kit', 2)], [perm('kit')], anchorOf, () => true, 1)]).toEqual(['kit']);
  });

  it('checks the asking token’s own spot', () => {
    expect(tokenPoint(at, 0, 1)).toEqual({ x: 282, y: 100 });
    expect(tokenPoint(at, 1, 1)).toEqual({ x: 258, y: 100 });
    const onlyFirstVisible = (p: { x: number }) => p.x > 270;
    expect([...permsOnMap([agent('ada', 1), agent('kit', 2)], [perm('kit')], anchorOf, onlyFirstVisible, 1)]).toEqual([]);
  });
});
