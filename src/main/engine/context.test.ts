import { describe, expect, it } from 'vitest';
import { applyOps, emptyMap } from '../../shared/map';
import type { AgendaItem, Decision, MapOp, OpSource } from '../../shared/model';
import { buildContext, mapSection } from './context';
import type { MapLogEntry } from './mapdiff';
import type { Workspace } from './workspace';

function workspace() {
  const ws = {
    map: emptyMap(),
    mapVersion: 1,
    mapLog: [] as MapLogEntry[],
    files: [],
    info: { name: 'Crux', isNew: true },
    view: { scopeId: null, selectedNodeId: null, openFile: null },
    open: [] as AgendaItem[],
    decisions: [] as Decision[],
    agenda: {
      open: () => ws.open,
      allDecisions: () => ws.decisions,
    },
    apply(source: OpSource, ops: MapOp[]) {
      ws.map = applyOps(ws.map, ops);
      ws.mapVersion++;
      ws.mapLog.push({ version: ws.mapVersion, at: Date.now(), source, ops });
    },
  };
  return ws;
}
const as = (ws: ReturnType<typeof workspace>) => ws as unknown as Workspace;

describe('mapSection', () => {
  it('sends the whole map first, then only what others changed', () => {
    const ws = workspace();
    ws.apply('lead', [{ op: 'upsertNode', node: { id: 'api', label: 'API', kind: 'service', parentId: null } }]);
    expect(mapSection(as(ws), null)).toMatchObject({ full: true });
    const seen = { version: ws.mapVersion, ids: new Set(Object.keys(ws.map.nodes)) };
    expect(mapSection(as(ws), seen).text).toBe('map: unchanged since your last turn');
    ws.apply('lead', [{ op: 'upsertNode', node: { id: 'web', label: 'Web', kind: 'client', parentId: null } }]);
    expect(mapSection(as(ws), seen).text).toBe('map: only your own changes since your last turn');
    ws.apply('builder', [{ op: 'upsertNode', node: { id: 'api', status: 'built' } }]);
    expect(mapSection(as(ws), seen).text).toBe('map changes by others since your last turn:\n~ api is now built');
  });

  it('falls back to the whole map when the change log no longer reaches back', () => {
    const ws = workspace();
    ws.apply('builder', [{ op: 'upsertNode', node: { id: 'api', label: 'API', kind: 'service', parentId: null } }]);
    ws.mapLog.shift();
    expect(mapSection(as(ws), { version: 1, ids: new Set() })).toMatchObject({ full: true });
  });
});

describe('buildContext', () => {
  it('marks the card on screen, lists decisions on request, and carries one-time notes', () => {
    const ws = workspace();
    ws.open = [{ id: 'q1', kind: 'decision', prompt: 'Web or native?', options: ['Web', 'Native'], nodeId: 'app', priority: 0.7, status: 'open', createdAt: 1 }];
    ws.decisions = [{ id: 'd1', title: 'Members first', rationale: 'Owner said so', nodeId: 'app', at: 1 }];
    const { text, fullMap } = buildContext({ ws: as(ws), crew: [], agentName: (id) => id, seen: null, withDecisions: true, notes: ['your name is now Juniper'] });
    expect(fullMap).toBe(true);
    expect(text).toContain('note: your name is now Juniper');
    expect(text).toContain('- [q1] decision on app: "Web or native?" options: Web | Native (the card on screen)');
    expect(text).toContain("decided so far (don't re-ask):\n- Members first (Owner said so) [app]");
    expect(buildContext({ ws: as(ws), crew: [], agentName: (id) => id, seen: null }).text).not.toContain('decided so far');
  });
});
