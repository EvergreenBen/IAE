import { describe, expect, it } from 'vitest';
import { applyOps, emptyMap } from '../../shared/map';
import type { MapOp, OpSource } from '../../shared/model';
import { describeChanges, type MapLogEntry } from './mapdiff';

function history(steps: [OpSource, MapOp[]][]) {
  let map = emptyMap();
  const log: MapLogEntry[] = [];
  const idsAt: Set<string>[] = [new Set()];
  let version = 1;
  steps.forEach(([source, ops], i) => {
    map = applyOps(map, ops, 1000 + i);
    log.push({ version: ++version, at: 1000 + i, source, ops });
    idsAt.push(new Set(Object.keys(map.nodes)));
  });
  // ids(v): the nodes on the map at version v (version 1 = empty).
  return { map, log, ids: (v: number) => idsAt[v - 1] };
}

describe('describeChanges', () => {
  const base: [OpSource, MapOp[]] = ['lead', [{ op: 'upsertNode', node: { id: 'api', label: 'API', kind: 'service', parentId: null } }]];

  it('is empty when only the lead changed the map', () => {
    const { map, log, ids } = history([base, ['lead', [{ op: 'upsertNode', node: { id: 'web', label: 'Web', kind: 'client', parentId: null } }]]]);
    expect(describeChanges(map, log, 2, ids(2))).toEqual([]);
  });

  it("reports others' new nodes, status changes and edges, but not the lead's own nodes", () => {
    const { map, log, ids } = history([
      base,
      ['lead', [{ op: 'upsertNode', node: { id: 'api-billing', label: 'Billing', kind: 'module', parentId: 'api' } }]],
      ['builder', [{ op: 'upsertNode', node: { id: 'api-billing', status: 'building' } }]],
      ['builder', [{ op: 'upsertNode', node: { id: 'api-webhooks', label: 'Webhooks', kind: 'module', parentId: 'api', status: 'built', paths: ['apps/api/src/webhooks/'] } }]],
      ['user', [{ op: 'upsertEdge', edge: { from: 'api-webhooks', to: 'api-billing', kind: 'events', label: 'paid' } }]],
    ]);
    expect(describeChanges(map, log, 2, ids(2))).toEqual([
      '~ api-billing is now building',
      '+ Webhooks [api-webhooks] (module, built) in api · paths: apps/api/src/webhooks/ — added by a builder',
      '+ api-webhooks → api-billing (events: paid)',
    ]);
  });

  it('reports removals by others and gives up (null) when there is too much to list', () => {
    const { map, log, ids } = history([base, ['user', [{ op: 'removeNode', id: 'api' }]]]);
    expect(describeChanges(map, log, 2, ids(2))).toEqual(['- [api] removed by the person']);
    const many = history([['cartographer', Array.from({ length: 20 }, (_, i) => ({ op: 'upsertNode' as const, node: { id: `n${i}`, label: `N${i}`, kind: 'module' as const, parentId: null } }))]]);
    expect(describeChanges(many.map, many.log, 1, new Set())).toBeNull();
  });
});
