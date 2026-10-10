// Pure helpers over the architecture map. No Node or DOM APIs — safe in both
// processes and in workers. Covered by src/shared/map.test.ts.

import picomatch from 'picomatch';
import type { ArchEdge, ArchMap, ArchNode, EdgeKind, FileEntry, MapOp } from './model';

export const emptyMap = (): ArchMap => ({ version: 1, nodes: {}, edges: {} });

export const slug = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 48) || 'node';

export const edgeId = (from: string, to: string): string => `${from}->${to}`;

/**
 * Apply ops immutably. Unknown parents are tolerated (node is lifted to the top
 * level) so a sloppy op stream never corrupts the map. Returns the same object
 * when nothing changed.
 */
export function applyOps(map: ArchMap, ops: MapOp[], now = Date.now()): ArchMap {
  if (!ops.length) return map;
  const nodes: Record<string, ArchNode> = { ...map.nodes };
  const edges: Record<string, ArchEdge> = { ...map.edges };

  for (const o of ops) {
    switch (o.op) {
      case 'upsertNode': {
        const prev = nodes[o.node.id];
        const defaults: ArchNode = { id: o.node.id, parentId: null, label: o.node.id, kind: 'module', status: 'planned', createdAt: now, updatedAt: now };
        const merged: ArchNode = { ...defaults, ...prev, ...stripUndefined(o.node), updatedAt: now };
        // Refuse parent cycles (self, or under one of its own descendants): keep the old parent.
        if (merged.parentId && (merged.parentId === merged.id || descendantIds({ ...map, nodes, edges }, merged.id).includes(merged.parentId))) {
          merged.parentId = prev && prev.parentId !== merged.id ? prev.parentId : null;
        }
        nodes[merged.id] = merged;
        break;
      }
      case 'removeNode': {
        const doomed = new Set([o.id, ...descendantIds({ ...map, nodes, edges }, o.id)]);
        for (const id of doomed) delete nodes[id];
        for (const [eid, e] of Object.entries(edges)) if (doomed.has(e.from) || doomed.has(e.to)) delete edges[eid];
        break;
      }
      case 'moveNode': {
        const n = nodes[o.id];
        if (!n) break;
        // Refuse cycles: can't move a node under its own descendant.
        if (o.parentId && (o.parentId === o.id || descendantIds({ ...map, nodes, edges }, o.id).includes(o.parentId))) break;
        nodes[o.id] = { ...n, parentId: o.parentId, updatedAt: now };
        break;
      }
      case 'upsertEdge': {
        const id = o.edge.id ?? edgeId(o.edge.from, o.edge.to);
        if (o.edge.from === o.edge.to) break;
        const prev = edges[id];
        const base: ArchEdge = { id, from: o.edge.from, to: o.edge.to, kind: 'calls' as EdgeKind };
        edges[id] = { ...base, ...prev, ...stripUndefined(o.edge), id };
        break;
      }
      case 'removeEdge':
        delete edges[o.id];
        break;
    }
  }

  // Repair: parents that don't exist → top level. Edges to missing nodes → dropped.
  for (const n of Object.values(nodes)) {
    if (n.parentId && !nodes[n.parentId]) nodes[n.id] = { ...n, parentId: null };
  }
  for (const [eid, e] of Object.entries(edges)) {
    if (!nodes[e.from] || !nodes[e.to]) delete edges[eid];
  }
  return { version: 1, nodes, edges };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

export function childrenOf(map: ArchMap, parentId: string | null): ArchNode[] {
  return Object.values(map.nodes)
    .filter((n) => n.parentId === parentId)
    .sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || a.createdAt - b.createdAt || a.label.localeCompare(b.label));
}

export function descendantIds(map: ArchMap, id: string): string[] {
  const out: string[] = [];
  const stack = [id];
  const byParent = new Map<string, string[]>();
  for (const n of Object.values(map.nodes)) {
    if (!n.parentId) continue;
    const list = byParent.get(n.parentId) ?? [];
    list.push(n.id);
    byParent.set(n.parentId, list);
  }
  // `seen` guards against parent cycles in hand-edited or legacy map files.
  const seen = new Set<string>([id]);
  while (stack.length) {
    const cur = stack.pop()!;
    for (const c of byParent.get(cur) ?? []) {
      if (seen.has(c)) continue;
      seen.add(c);
      out.push(c);
      stack.push(c);
    }
  }
  return out;
}

/** Root-first chain of ancestors, excluding the node itself. */
export function ancestorsOf(map: ArchMap, id: string): ArchNode[] {
  const chain: ArchNode[] = [];
  const seen = new Set<string>();
  let cur = map.nodes[id]?.parentId ?? null;
  while (cur && map.nodes[cur] && !seen.has(cur)) {
    seen.add(cur);
    chain.unshift(map.nodes[cur]);
    cur = map.nodes[cur].parentId;
  }
  return chain;
}

/**
 * The ancestor of `id` that is a direct child of `scopeId` (or `id` itself when
 * it already is). Returns null when `id` is not inside `scopeId`.
 * Used to "lift" deep activity/edges to whatever is visible at the current zoom.
 */
export function visibleAncestor(map: ArchMap, id: string, scopeId: string | null): string | null {
  let cur: string | null = id;
  const seen = new Set<string>();
  while (cur && map.nodes[cur] && !seen.has(cur)) {
    seen.add(cur);
    if (map.nodes[cur].parentId === scopeId) return cur;
    cur = map.nodes[cur].parentId;
  }
  return null;
}

export interface LiftedEdge {
  id: string;
  from: string;
  to: string;
  kinds: EdgeKind[];
  labels: string[];
  /** Number of underlying edges folded into this one. */
  weight: number;
}

/**
 * Edges as they should be drawn inside `scopeId`: every edge whose endpoints are
 * both inside the scope is lifted to the scope's direct children and merged.
 * Edges that end up inside a single child are dropped (they're internal to it).
 */
export function liftedEdges(map: ArchMap, scopeId: string | null): LiftedEdge[] {
  const merged = new Map<string, LiftedEdge>();
  for (const e of Object.values(map.edges)) {
    const a = visibleAncestor(map, e.from, scopeId);
    const b = visibleAncestor(map, e.to, scopeId);
    if (!a || !b || a === b) continue;
    const id = edgeId(a, b);
    const cur = merged.get(id) ?? { id, from: a, to: b, kinds: [], labels: [], weight: 0 };
    if (!cur.kinds.includes(e.kind)) cur.kinds.push(e.kind);
    if (e.label && !cur.labels.includes(e.label)) cur.labels.push(e.label);
    cur.weight += 1;
    merged.set(id, cur);
  }
  return [...merged.values()];
}

/**
 * Edges that cross the boundary of `scopeId`: one end inside, the other outside.
 * Rendered as stubs at the frame edge so a zoomed-in view still shows what the
 * system talks to.
 */
export function boundaryEdges(map: ArchMap, scopeId: string | null): { inside: string; outside: string; dir: 'in' | 'out'; kind: EdgeKind; label?: string }[] {
  if (!scopeId) return [];
  const inScope = new Set(descendantIds(map, scopeId));
  const out: { inside: string; outside: string; dir: 'in' | 'out'; kind: EdgeKind; label?: string }[] = [];
  for (const e of Object.values(map.edges)) {
    const fi = inScope.has(e.from);
    const ti = inScope.has(e.to);
    if (fi === ti) continue;
    const insideRaw = fi ? e.from : e.to;
    const inside = visibleAncestor(map, insideRaw, scopeId);
    if (!inside) continue;
    out.push({ inside, outside: fi ? e.to : e.from, dir: fi ? 'out' : 'in', kind: e.kind, label: e.label });
  }
  return out;
}

const matcherCache = new Map<string, (p: string) => boolean>();
function pathMatcher(pattern: string): (p: string) => boolean {
  let m = matcherCache.get(pattern);
  if (!m) {
    if (pattern.endsWith('/')) {
      m = (p) => p.startsWith(pattern);
    } else if (/[*?[\]{}]/.test(pattern)) {
      const pm = picomatch(pattern, { dot: true });
      m = (p) => pm(p);
    } else {
      // exact file, or a directory written without the trailing slash
      m = (p) => p === pattern || p.startsWith(pattern + '/');
    }
    matcherCache.set(pattern, m);
  }
  return m;
}

/** Depth of a node (top level = 0). */
export function depthOf(map: ArchMap, id: string): number {
  return ancestorsOf(map, id).length;
}

/**
 * Owning node for a path: the deepest node with a matching `paths` entry. Ties
 * at equal depth go to the more specific (longer) pattern.
 */
export function ownerOf(map: ArchMap, path: string): string | null {
  let best: { id: string; depth: number; spec: number } | null = null;
  for (const n of Object.values(map.nodes)) {
    if (!n.paths?.length) continue;
    for (const pat of n.paths) {
      if (!pathMatcher(pat)(path)) continue;
      const depth = depthOf(map, n.id);
      const spec = pat.length;
      if (!best || depth > best.depth || (depth === best.depth && spec > best.spec)) best = { id: n.id, depth, spec };
    }
  }
  return best?.id ?? null;
}

export function assignFiles(map: ArchMap, files: Omit<FileEntry, 'nodeId'>[] | FileEntry[]): FileEntry[] {
  return files.map((f) => ({ ...f, nodeId: ownerOf(map, f.path) }));
}

/** Files owned by `nodeId` or any of its descendants. */
export function filesUnder(map: ArchMap, files: FileEntry[], nodeId: string): FileEntry[] {
  const ids = new Set([nodeId, ...descendantIds(map, nodeId)]);
  return files.filter((f) => f.nodeId && ids.has(f.nodeId));
}

/**
 * Compact plain-text rendering of the map for prompts. Indented tree, edges
 * listed after. Kept small on purpose — the lead reads this every turn.
 */
export function describeMap(map: ArchMap, files?: FileEntry[], maxFilesPerNode = 0): string {
  const lines: string[] = [];
  const counts = new Map<string, number>();
  for (const f of files ?? []) if (f.nodeId) counts.set(f.nodeId, (counts.get(f.nodeId) ?? 0) + 1);
  const walk = (parent: string | null, depth: number) => {
    for (const n of childrenOf(map, parent)) {
      const bits = [`${'  '.repeat(depth)}- ${n.label} [${n.id}] (${n.kind}, ${n.status})`];
      if (n.techLabel) bits.push(`techLabel: ${n.techLabel}`);
      if (n.tech?.length) bits.push(`tech: ${n.tech.join(', ')}`);
      const c = counts.get(n.id);
      if (c) bits.push(`${c} files`);
      if (n.paths?.length) bits.push(`paths: ${n.paths.slice(0, 3).join(' ')}`);
      lines.push(bits.join(' · '));
      if (n.summary) lines.push(`${'  '.repeat(depth)}    ${n.summary}`);
      if (maxFilesPerNode && files) {
        const own = files.filter((f) => f.nodeId === n.id).slice(0, maxFilesPerNode);
        for (const f of own) lines.push(`${'  '.repeat(depth)}    · ${f.path}`);
      }
      walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
  const edges = Object.values(map.edges);
  if (edges.length) {
    lines.push('Connections:');
    for (const e of edges) lines.push(`- ${e.from} → ${e.to} (${e.kind}${e.label ? `: ${e.label}` : ''})`);
  }
  return lines.length ? lines.join('\n') : '(empty — nothing drawn yet)';
}

/**
 * The folder name a new project gets on disk. Shared by the engine (which
 * creates it) and the UI (which previews it) so they always agree.
 */
export function projectFolderName(name: string): string {
  const cleaned = name
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/^\.+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned || 'Untitled';
}
