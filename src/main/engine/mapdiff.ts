// What changed on the map since the lead last looked, written compactly. The
// lead made its own changes (it saw the tool results), so only changes by
// others (builders, the cartographer, the person) are described. Sending a
// diff instead of the whole map every turn keeps the lead's history small,
// which keeps it fast.

import type { ArchMap, MapOp, OpSource } from '../../shared/model';

export interface MapLogEntry {
  version: number;
  at: number;
  source: OpSource;
  ops: MapOp[];
}

const WHO: Record<OpSource, string> = {
  lead: 'you',
  builder: 'a builder',
  cartographer: 'Atlas',
  user: 'the person',
  scanner: 'the scanner',
};

interface NodeChange {
  source: OpSource;
  fields: Set<string>;
}

/**
 * Lines describing changes made by others after map version `since` (when
 * the nodes in `existed` were on the map), or null when there are too many to
 * list (send the whole map instead). An empty array means nobody else changed
 * anything.
 */
export function describeChanges(map: ArchMap, log: MapLogEntry[], since: number, existed: ReadonlySet<string>, maxLines = 16): string[] | null {
  const entries = log.filter((e) => e.version > since);
  if (!entries.some((e) => e.source !== 'lead')) return [];
  const creator = new Map<string, OpSource>();
  const nodes = new Map<string, NodeChange>();
  const removed = new Map<string, OpSource>();
  const edges = new Map<string, { source: OpSource; removed: boolean }>();
  const touch = (id: string, source: OpSource, fields: string[]) => {
    const cur = nodes.get(id) ?? { source, fields: new Set<string>() };
    cur.source = source;
    for (const f of fields) cur.fields.add(f);
    nodes.set(id, cur);
  };
  for (const e of entries) {
    for (const o of e.ops) {
      if (o.op === 'upsertNode') {
        if (!existed.has(o.node.id) && !creator.has(o.node.id)) creator.set(o.node.id, e.source);
        if (e.source !== 'lead') touch(o.node.id, e.source, Object.keys(o.node).filter((k) => k !== 'id'));
        removed.delete(o.node.id);
      } else if (o.op === 'removeNode') {
        nodes.delete(o.id);
        if (e.source !== 'lead') removed.set(o.id, e.source);
      } else if (o.op === 'moveNode') {
        if (e.source !== 'lead') touch(o.id, e.source, ['parentId']);
      } else if (e.source !== 'lead' && o.op === 'upsertEdge') {
        edges.set(o.edge.id ?? `${o.edge.from}->${o.edge.to}`, { source: e.source, removed: false });
      } else if (e.source !== 'lead' && o.op === 'removeEdge') {
        edges.set(o.id, { source: e.source, removed: true });
      }
    }
  }
  const lines: string[] = [];
  for (const [id, c] of nodes) {
    const n = map.nodes[id];
    if (!n) continue;
    const where = n.parentId ? ` in ${n.parentId}` : '';
    const by = creator.get(id);
    if (by && by !== 'lead') {
      const paths = n.paths?.length ? ` · paths: ${n.paths.slice(0, 3).join(' ')}` : '';
      lines.push(`+ ${n.label} [${id}] (${n.kind}, ${n.status})${where}${paths} — added by ${WHO[by]}`);
    } else if (c.fields.size === 1 && c.fields.has('status')) {
      lines.push(`~ ${id} is now ${n.status}`);
    } else {
      const what = [...c.fields].map((f) => (f === 'parentId' ? 'place' : f)).join(', ');
      lines.push(`~ ${n.label} [${id}]${where} (${n.status}): ${what} changed by ${WHO[c.source]}`);
    }
  }
  for (const [id, source] of removed) if (!map.nodes[id]) lines.push(`- [${id}] removed by ${WHO[source]}`);
  for (const [id, e] of edges) {
    const edge = map.edges[id];
    if (e.removed && !edge) lines.push(`- connection ${id.replace('->', ' → ')} removed by ${WHO[e.source]}`);
    else if (!e.removed && edge) lines.push(`+ ${edge.from} → ${edge.to} (${edge.kind}${edge.label ? `: ${edge.label}` : ''})`);
  }
  return lines.length > maxLines ? null : lines;
}
