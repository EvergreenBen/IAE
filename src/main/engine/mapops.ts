// Turns loosely-typed map ops from a model's tool call into valid MapOps,
// with plain-language notes about anything that was fixed or refused. The
// tool schemas are deliberately lenient (a rejected tool call costs the lead a
// whole round trip); strictness lives here, where errors can be specific.

import { z } from 'zod';
import { slug } from '../../shared/map';
import type { ArchMap, EdgeKind, MapOp, NodeKind, NodeStatus } from '../../shared/model';

export const NODE_KINDS = ['system', 'client', 'service', 'module', 'data', 'queue', 'external', 'config', 'infra', 'ai'] as const;
export const NODE_STATUSES = ['planned', 'building', 'built', 'broken'] as const;
export const EDGE_KINDS = ['calls', 'reads', 'writes', 'events', 'depends', 'auth'] as const;
export const OP_NAMES = ['upsertNode', 'removeNode', 'moveNode', 'upsertEdge', 'removeEdge'] as const;
export type OpName = (typeof OP_NAMES)[number];

const KIND_SYNONYMS: Record<string, NodeKind> = {
  group: 'system',
  frontend: 'client',
  ui: 'client',
  app: 'client',
  web: 'client',
  mobile: 'client',
  backend: 'service',
  api: 'service',
  server: 'service',
  worker: 'queue',
  database: 'data',
  db: 'data',
  storage: 'data',
  cache: 'data',
  store: 'data',
  component: 'module',
  library: 'module',
  lib: 'module',
  package: 'module',
  thirdparty: 'external',
  'third-party': 'external',
  saas: 'external',
  integration: 'external',
  secrets: 'config',
  env: 'config',
  settings: 'config',
  ci: 'infra',
  deploy: 'infra',
  hosting: 'infra',
  llm: 'ai',
  model: 'ai',
  agent: 'ai',
};

const EDGE_SYNONYMS: Record<string, EdgeKind> = {
  call: 'calls',
  http: 'calls',
  rest: 'calls',
  rpc: 'calls',
  read: 'reads',
  query: 'reads',
  write: 'writes',
  event: 'events',
  publishes: 'events',
  subscribes: 'events',
  depend: 'depends',
  uses: 'depends',
  imports: 'depends',
  authenticates: 'auth',
};

// ── Tool input schema (lenient) ──────────────────────────────────────────────

export const nodeInput = z
  .object({
    id: z.string().describe('Stable lowercase kebab id, e.g. "api-auth".'),
    parentId: z.string().nullable().optional().describe('Parent node id; null or omitted = top level.'),
    label: z.string().optional().describe('1–3 words.'),
    kind: z.string().optional().describe(`One of: ${NODE_KINDS.join(', ')}.`),
    status: z.string().optional().describe(`One of: ${NODE_STATUSES.join(', ')}.`),
    summary: z.string().optional().describe('One sentence: what it does and why.'),
    tech: z.array(z.string()).optional(),
    paths: z.array(z.string()).optional().describe('Code it owns: directory prefixes ending in "/", exact files, or globs.'),
    order: z.number().optional(),
  })
  .passthrough();

export const edgeInput = z
  .object({
    from: z.string(),
    to: z.string(),
    kind: z.string().optional().describe(`One of: ${EDGE_KINDS.join(', ')}.`),
    label: z.string().optional().describe('1–3 words.'),
  })
  .passthrough();

export const opInput = z
  .object({
    op: z.string().describe(`One of: ${OP_NAMES.join(', ')}.`),
    node: nodeInput.optional().describe('For upsertNode.'),
    edge: edgeInput.optional().describe('For upsertEdge.'),
    id: z.string().optional().describe('For removeNode, moveNode, removeEdge ("from->to").'),
    parentId: z.string().nullable().optional().describe('For moveNode.'),
  })
  .passthrough();

export type RawOp = z.infer<typeof opInput>;

// ── Normalisation ────────────────────────────────────────────────────────────

export function normalizeKind(raw: unknown): NodeKind | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const k = raw.trim().toLowerCase();
  if ((NODE_KINDS as readonly string[]).includes(k)) return k as NodeKind;
  return KIND_SYNONYMS[k];
}

export function normalizeStatus(raw: unknown): NodeStatus | undefined {
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim().toLowerCase();
  return (NODE_STATUSES as readonly string[]).includes(s) ? (s as NodeStatus) : undefined;
}

export function normalizeEdgeKind(raw: unknown): EdgeKind {
  if (typeof raw !== 'string') return 'calls';
  const k = raw.trim().toLowerCase();
  if ((EDGE_KINDS as readonly string[]).includes(k)) return k as EdgeKind;
  return EDGE_SYNONYMS[k] ?? 'calls';
}

export function normalizePath(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

const normalizeId = (raw: unknown): string => (typeof raw === 'string' ? slug(raw) : '');

const str = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;

export interface NormalizeOptions {
  allowed?: readonly OpName[];
  /** Status for nodes that don't exist yet and don't state one. */
  defaultStatus?: (node: { paths?: string[] }) => NodeStatus;
  /** Absolute project root: paths given absolutely are made relative to it. */
  root?: string;
}

export interface NormalizeResult {
  ops: MapOp[];
  /** Ids of nodes upserted, in order. */
  nodeIds: string[];
  edgeIds: string[];
  notes: string[];
}

/**
 * Validates and normalises ops against the current map. Ops are checked in
 * order, so a batch may create a parent and then its children.
 */
export function normalizeOps(raw: unknown[], map: ArchMap, opts: NormalizeOptions = {}): NormalizeResult {
  const out: NormalizeResult = { ops: [], nodeIds: [], edgeIds: [], notes: [] };
  const exists = new Set(Object.keys(map.nodes));
  // Parents as they will be after the ops so far, to refuse cycles across the batch.
  const parents = new Map<string, string | null>(Object.values(map.nodes).map((n) => [n.id, n.parentId]));
  const wouldCycle = (id: string, parentId: string | null): boolean => {
    for (let cur = parentId, steps = 0; cur && steps <= parents.size; cur = parents.get(cur) ?? null, steps++) if (cur === id) return true;
    return false;
  };
  const edges = new Set(Object.keys(map.edges));
  const allowed = new Set<string>(opts.allowed ?? OP_NAMES);
  const fixPath = (p: string): string => {
    let n = normalizePath(p);
    if (opts.root && p.startsWith(opts.root)) n = normalizePath(p.slice(opts.root.length));
    return n;
  };

  raw.forEach((r, i) => {
    const where = `op ${i + 1}`;
    if (!r || typeof r !== 'object') return void out.notes.push(`${where}: not an object, skipped.`);
    const o = r as Record<string, unknown>;
    const op = String(o.op ?? '');
    if (!(OP_NAMES as readonly string[]).includes(op)) return void out.notes.push(`${where}: unknown op "${op}", skipped. Use one of ${OP_NAMES.join(', ')}.`);
    if (!allowed.has(op)) return void out.notes.push(`${where}: ${op} is not allowed here, skipped.`);

    switch (op as OpName) {
      case 'upsertNode': {
        // Accept both {op, node:{…}} and the flattened {op, id, label, …}.
        const n = (o.node && typeof o.node === 'object' ? o.node : o) as Record<string, unknown>;
        const id = normalizeId(n.id ?? n.label);
        if (!id) return void out.notes.push(`${where}: upsertNode needs node.id, skipped.`);
        if (typeof n.id === 'string' && n.id !== id) out.notes.push(`${where}: id "${n.id}" normalised to "${id}".`);
        const isNew = !exists.has(id);
        let parentId: string | null | undefined = n.parentId === undefined ? undefined : n.parentId === null ? null : normalizeId(n.parentId) || null;
        if (parentId && !exists.has(parentId)) {
          out.notes.push(`${where}: parent "${parentId}" doesn't exist; "${id}" placed at the top level.`);
          parentId = null;
        }
        if (parentId === id) parentId = null;
        if (parentId && !isNew && wouldCycle(id, parentId)) {
          out.notes.push(`${where}: "${id}" can't go inside its own descendant "${parentId}"; kept where it was.`);
          parentId = undefined;
        }
        if (parentId !== undefined || isNew) parents.set(id, parentId ?? null);
        const paths = Array.isArray(n.paths) ? n.paths.filter((p): p is string => typeof p === 'string' && !!p.trim()).map(fixPath) : undefined;
        const tech = Array.isArray(n.tech) ? n.tech.filter((t): t is string => typeof t === 'string').map((t) => t.trim()).filter(Boolean).slice(0, 5) : undefined;
        const status = normalizeStatus(n.status) ?? (isNew && opts.defaultStatus ? opts.defaultStatus({ paths }) : undefined);
        const kind = normalizeKind(n.kind) ?? (isNew ? 'module' : undefined);
        const label = str(n.label, 40) ?? (isNew ? labelFromId(id) : undefined);
        out.ops.push({
          op: 'upsertNode',
          node: {
            id,
            ...(parentId !== undefined ? { parentId } : isNew ? { parentId: null } : {}),
            ...(label ? { label } : {}),
            ...(kind ? { kind } : {}),
            ...(status ? { status } : {}),
            ...(str(n.summary, 240) ? { summary: str(n.summary, 240) } : {}),
            ...(tech ? { tech } : {}),
            ...(paths ? { paths } : {}),
            ...(typeof n.order === 'number' ? { order: n.order } : {}),
          },
        });
        exists.add(id);
        out.nodeIds.push(id);
        break;
      }
      case 'removeNode': {
        const id = normalizeId(o.id ?? (o.node as Record<string, unknown> | undefined)?.id);
        if (!exists.has(id)) return void out.notes.push(`${where}: no node "${id}" to remove.`);
        out.ops.push({ op: 'removeNode', id });
        exists.delete(id);
        parents.delete(id);
        break;
      }
      case 'moveNode': {
        const id = normalizeId(o.id ?? (o.node as Record<string, unknown> | undefined)?.id);
        if (!exists.has(id)) return void out.notes.push(`${where}: no node "${id}" to move.`);
        const parentId = o.parentId == null ? null : normalizeId(o.parentId);
        if (parentId && !exists.has(parentId)) return void out.notes.push(`${where}: no parent "${parentId}" to move "${id}" into.`);
        if (parentId && wouldCycle(id, parentId)) return void out.notes.push(`${where}: "${id}" can't move inside itself or its descendant "${parentId}".`);
        out.ops.push({ op: 'moveNode', id, parentId });
        parents.set(id, parentId);
        break;
      }
      case 'upsertEdge': {
        const e = (o.edge && typeof o.edge === 'object' ? o.edge : o) as Record<string, unknown>;
        const from = normalizeId(e.from);
        const to = normalizeId(e.to);
        if (!exists.has(from) || !exists.has(to)) {
          const missing = [from, to].filter((x) => !exists.has(x));
          return void out.notes.push(`${where}: edge ${from} → ${to} skipped; no node ${missing.map((m) => `"${m}"`).join(' or ')}.`);
        }
        if (from === to) return void out.notes.push(`${where}: an edge can't connect "${from}" to itself.`);
        const id = `${from}->${to}`;
        out.ops.push({ op: 'upsertEdge', edge: { id, from, to, kind: normalizeEdgeKind(e.kind), ...(str(e.label, 32) ? { label: str(e.label, 32) } : {}) } });
        edges.add(id);
        out.edgeIds.push(id);
        break;
      }
      case 'removeEdge': {
        let id = typeof o.id === 'string' ? o.id.trim() : '';
        const e = o.edge as Record<string, unknown> | undefined;
        if (!id && e) id = `${normalizeId(e.from)}->${normalizeId(e.to)}`;
        if (!edges.has(id)) return void out.notes.push(`${where}: no edge "${id}" to remove.`);
        out.ops.push({ op: 'removeEdge', id });
        edges.delete(id);
        break;
      }
    }
  });
  return out;
}

export function labelFromId(id: string): string {
  const last = id.split('-').slice(-2).join(' ');
  return last.replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 40) || id;
}

/** One-line summary of a normalisation, returned to the model. */
export function describeResult(r: NormalizeResult): string {
  const bits: string[] = [];
  if (r.nodeIds.length) bits.push(`nodes: ${r.nodeIds.join(', ')}`);
  if (r.edgeIds.length) bits.push(`edges: ${r.edgeIds.join(', ')}`);
  const removed = r.ops.filter((o) => o.op === 'removeNode' || o.op === 'removeEdge').length;
  const moved = r.ops.filter((o) => o.op === 'moveNode').length;
  if (removed) bits.push(`${removed} removed`);
  if (moved) bits.push(`${moved} moved`);
  const head = r.ops.length ? `Applied ${r.ops.length} op${r.ops.length === 1 ? '' : 's'} (${bits.join('; ')}).` : 'Nothing applied.';
  return r.notes.length ? `${head}\nNotes:\n- ${r.notes.join('\n- ')}` : head;
}
