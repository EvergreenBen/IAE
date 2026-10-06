// Per-scope layout with ELK (layered, RIGHT, orthogonal). Pure input → geometry;
// results are cached by a structural signature so unrelated store updates
// (agent activity, touches) never re-run ELK.
import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api';
import { boundaryEdges, childrenOf, liftedEdges } from '@shared/map';
import type { ArchMap, EdgeKind, FileEntry, NodeKind } from '@shared/model';
import { inflate, labelPoint, roundedPath, simplify, union, type Pt, type Rect } from './geometry';
import {
  CAPTION,
  CONTAINER,
  FRAME_PAD,
  LEAF,
  STUB_H,
  TILE,
  edgeStyle,
  scopeKey,
  withCaption,
  type EdgeRoute,
  type FileChip,
  type NodeBox,
  type ScopeLayout,
  type Stub,
} from './layoutTypes';
import { labelTiers } from './edgeLabels';
import { runElk } from './elk';
import { FONT_MONO, textWidth } from './measure';

export * from './layoutTypes';

const LAYER_HINT: Partial<Record<NodeKind, string>> = { client: 'FIRST', external: 'LAST' };

const pillWidth = (text: string) => textWidth(text, 11, undefined, 500) + 20;
const stubWidth = (text: string) => textWidth(text, 11.5, undefined, 500) + 50;
const baseName = (p: string) => p.split('/').pop() ?? p;
const dirName = (p: string) => p.split('/').slice(0, -1).join('/');

// ── input ────────────────────────────────────────────────────────────────────

type StubSpec = Omit<Stub, keyof Rect> & { kinds: EdgeKind[] };

interface ScopeInput {
  scopeId: string | null;
  signature: string;
  nodes: NodeBox[];
  edges: { id: string; from: string; to: string; kinds: EdgeKind[]; text?: string; stub?: boolean }[];
  stubs: StubSpec[];
  shelf: FileEntry[];
  tiles: FileEntry[];
  leaf: boolean;
  meaning: boolean;
}

function buildInput(map: ArchMap, files: FileEntry[], scopeId: string | null, meaning: boolean): ScopeInput {
  const kids = childrenOf(map, scopeId);
  const hasKids = new Set<string>();
  for (const n of Object.values(map.nodes)) if (n.parentId) hasKids.add(n.parentId);

  const nodes: NodeBox[] = kids.map((n) => {
    const c = hasKids.has(n.id);
    return { id: n.id, kind: n.kind, x: 0, y: 0, w: c ? CONTAINER.w : LEAF.w, h: c ? CONTAINER.h : LEAF.h, container: c };
  });

  const edges: ScopeInput['edges'] = liftedEdges(map, scopeId).map((e) => ({
    id: e.id,
    from: e.from,
    to: e.to,
    kinds: e.kinds,
    text: e.labels.length ? e.labels.slice(0, 2).join(' · ') + (e.labels.length > 2 ? ` +${e.labels.length - 2}` : '') : undefined,
  }));

  const stubs: StubSpec[] = [];
  const leaf = scopeId !== null && kids.length === 0;
  if (scopeId) {
    const seen = new Map<string, (typeof stubs)[number]>();
    const stubEdges = new Map<string, ScopeInput['edges'][number]>();
    for (const b of boundaryEdges(map, scopeId)) {
      const key = `stub:${b.dir}:${b.outside}`;
      let s = seen.get(key);
      if (!s) {
        s = { key, dir: b.dir, target: b.outside, label: map.nodes[b.outside]?.label ?? b.outside, kinds: [] };
        seen.set(key, s);
        stubs.push(s);
      }
      if (!s.kinds.includes(b.kind)) s.kinds.push(b.kind);
      const id = b.dir === 'out' ? `${b.inside}->${key}` : `${key}->${b.inside}`;
      const cur = stubEdges.get(id) ?? { id, from: b.dir === 'out' ? b.inside : key, to: b.dir === 'out' ? key : b.inside, kinds: [], stub: true };
      if (!cur.kinds.includes(b.kind)) cur.kinds.push(b.kind);
      if (b.label && !cur.text) cur.text = b.label;
      stubEdges.set(id, cur);
    }
    edges.push(...stubEdges.values());
    if (leaf) {
      // A leaf has no children to wire stubs to: show its own connections as pills on the frame.
      for (const e of Object.values(map.edges)) {
        const dir = e.from === scopeId ? 'out' : e.to === scopeId ? 'in' : null;
        if (!dir) continue;
        const target = dir === 'out' ? e.to : e.from;
        const key = `stub:${dir}:${target}`;
        if (seen.has(key)) continue;
        const s: StubSpec = { key, dir, target, label: map.nodes[target]?.label ?? target, kinds: [e.kind], free: true };
        seen.set(key, s);
        stubs.push(s);
      }
    }
  }

  const own = files.filter((f) => f.nodeId === scopeId).sort((a, b) => a.path.localeCompare(b.path));
  const tiles = leaf ? own : [];
  const shelf = leaf ? [] : own.slice(0, 40);

  const sig = [
    scopeId ?? '',
    meaning ? 'm' : '',
    nodes.map((n) => `${n.id}:${n.w}`).join(','),
    edges.map((e) => `${e.id}:${e.kinds.join('+')}:${e.text ?? ''}`).join(','),
    stubs.map((s) => `${s.key}:${s.label}`).join(','),
    shelf.map((f) => f.path + (meaning ? f.note ?? '' : '')).join(','),
    tiles.map((f) => f.path).join(','),
  ].join('|');

  return { scopeId, signature: sig, nodes, edges, stubs, shelf, tiles, leaf, meaning };
}

// ── ELK ─────────────────────────────────────────────────────────────────────


const ROOT_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.padding': '[top=0,left=0,bottom=0,right=0]',
  // Discs sit in a layer stacked vertically, so nodeNode has to clear the
  // caption hanging below each one; between layers it clears its overhang.
  'elk.spacing.nodeNode': `${CAPTION.h + 36}`,
  'elk.layered.spacing.nodeNodeBetweenLayers': '96',
  'elk.spacing.edgeNode': '22',
  'elk.layered.spacing.edgeNodeBetweenLayers': '22',
  'elk.spacing.edgeEdge': '12',
  'elk.layered.spacing.edgeEdgeBetweenLayers': '12',
  'elk.spacing.edgeLabel': '6',
  'elk.spacing.componentComponent': '64',
  'elk.separateConnectedComponents': 'false',
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'elk.layered.crossingMinimization.semiInteractive': 'false',
  'elk.layered.cycleBreaking.strategy': 'GREEDY_MODEL_ORDER',
  'elk.layered.thoroughness': '12',
  'elk.edgeLabels.inline': 'false',
  'elk.layered.edgeLabels.sideSelection': 'ALWAYS_UP',
  'elk.layered.mergeEdges': 'false',
};

/** Large scopes: cheaper passes, same look. */
const BIG_OPTIONS: Record<string, string> = {
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
  'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',
  'elk.layered.thoroughness': '3',
};

const cache = new Map<string, ScopeLayout>();

/** ELK puts labels beside the line; sit the pill on the nearest horizontal run instead. */
function centreOnLine(l: { text: string } & Rect, pts: Pt[]): { text: string } & Rect {
  const cx = l.x + l.w / 2;
  const cy = l.y + l.h / 2;
  let best: { y: number; x0: number; x1: number } | null = null;
  let bestD = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (Math.abs(a.y - b.y) > 0.5) continue;
    const x0 = Math.min(a.x, b.x);
    const x1 = Math.max(a.x, b.x);
    if (x1 - x0 < l.w + 16) continue;
    const dx = cx < x0 ? x0 - cx : cx > x1 ? cx - x1 : 0;
    const d = Math.hypot(dx, a.y - cy);
    if (d < bestD) {
      bestD = d;
      best = { y: a.y, x0, x1 };
    }
  }
  if (!best || bestD > 60) return l;
  const x = Math.max(best.x0 + 8, Math.min(best.x1 - 8 - l.w, l.x));
  return { ...l, x, y: best.y - l.h / 2 };
}

export async function layoutScope(map: ArchMap, files: FileEntry[], scopeId: string | null, meaning: boolean): Promise<ScopeLayout> {
  const input = buildInput(map, files, scopeId, meaning);
  const hit = cache.get(input.signature);
  if (hit) return hit;
  const out = await compute(input);
  cache.set(input.signature, out);
  if (cache.size > 120) cache.delete(cache.keys().next().value!);
  return out;
}

export function clearLayoutCache() {
  cache.clear();
}

async function compute(input: ScopeInput): Promise<ScopeLayout> {
  const { scopeId } = input;
  const nodes: Record<string, NodeBox> = {};
  const edges: EdgeRoute[] = [];
  const stubs: Stub[] = [];
  let content: Rect | null = null;

  const wiredStubs = input.stubs.filter((s) => !s.free);

  if (input.nodes.length) {
    // Clients lead and externals trail — but only where the edges agree (ELK rejects contradictions).
    const hasIn = new Set(input.edges.filter((e) => !e.stub).map((e) => e.to));
    const hasOut = new Set(input.edges.filter((e) => !e.stub).map((e) => e.from));
    const hintFor = (n: NodeBox) => {
      const h = LAYER_HINT[n.kind];
      if (h === 'FIRST' && hasIn.has(n.id)) return undefined;
      if (h === 'LAST' && hasOut.has(n.id)) return undefined;
      return h;
    };
    const graph = (hints: boolean): ElkNode => ({
      id: 'root',
      layoutOptions: input.nodes.length > 60 ? { ...ROOT_OPTIONS, ...BIG_OPTIONS } : ROOT_OPTIONS,
      children: [
        ...input.nodes.map((n) => {
          const hint = hints ? hintFor(n) : undefined;
          return { id: n.id, width: n.w, height: n.h, layoutOptions: hint ? { 'elk.layered.layering.layerConstraint': hint } : undefined };
        }),
        ...wiredStubs.map((s) => ({
          id: s.key,
          width: stubWidth(s.label),
          height: STUB_H,
          layoutOptions: { 'elk.layered.layering.layerConstraint': s.dir === 'in' ? 'FIRST_SEPARATE' : 'LAST_SEPARATE' },
        })),
      ],
      edges: input.edges.map(
        (e): ElkExtendedEdge => ({
          id: e.id,
          sources: [e.from],
          targets: [e.to],
          labels: e.text ? [{ text: e.text, width: pillWidth(e.text), height: 20, layoutOptions: { 'elk.edgeLabels.placement': 'CENTER' } }] : undefined,
        }),
      ),
    });
    let res: ElkNode;
    try {
      res = await runElk(graph(true));
    } catch {
      res = await runElk(graph(false));
    }
    for (const c of res.children ?? []) {
      const n = input.nodes.find((x) => x.id === c.id);
      if (n) nodes[n.id] = { ...n, x: c.x ?? 0, y: c.y ?? 0 };
      const s = wiredStubs.find((x) => x.key === c.id);
      if (s) stubs.push({ key: s.key, dir: s.dir, target: s.target, label: s.label, x: c.x ?? 0, y: c.y ?? 0, w: c.width ?? 0, h: c.height ?? STUB_H });
    }
    content = union(Object.values(nodes).map(withCaption));

    // Line stubs up: incoming pills right-aligned, outgoing left-aligned.
    const ins = stubs.filter((s) => s.dir === 'in');
    const outs = stubs.filter((s) => s.dir === 'out');
    const inRight = Math.max(...ins.map((s) => s.x + s.w));
    const outLeft = Math.min(...outs.map((s) => s.x));
    for (const s of ins) s.x = inRight - s.w;
    for (const s of outs) s.x = outLeft;

    for (const re of (res.edges ?? []) as ElkExtendedEdge[]) {
      const src = input.edges.find((e) => e.id === re.id);
      const sec = re.sections?.[0];
      if (!src || !sec) continue;
      const raw: Pt[] = [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint].map((p) => ({ x: p.x, y: p.y }));
      // Re-anchor stub ends to the aligned pills (last/first segments are horizontal).
      if (src.to.startsWith('stub:')) raw[raw.length - 1].x = outLeft;
      if (src.from.startsWith('stub:')) raw[0].x = inRight;
      const pts = simplify(raw);
      const lab = re.labels?.[0];
      let label: EdgeRoute['label'];
      if (src.text) {
        const w = pillWidth(src.text);
        if (lab && lab.x !== undefined && lab.y !== undefined) label = centreOnLine({ text: src.text, x: lab.x, y: lab.y, w, h: 20 }, pts);
        else {
          const p = labelPoint(pts);
          label = { text: src.text, x: p.x - w / 2, y: p.y - 10, w, h: 20 };
        }
      }
      edges.push({ id: src.id, from: src.from, to: src.to, d: roundedPath(pts, 10), pts, kinds: src.kinds, style: edgeStyle(src.kinds), label, stub: src.stub });
    }
    // Model order is priority: ELK returns edges in its own order.
    const rank = new Map(input.edges.map((e, i) => [e.id, i]));
    const labelled = edges.filter((e) => e.label).sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
    const tiers = labelTiers(labelled.map((e) => ({ id: e.id, ...e.label! })));
    for (const e of labelled) e.label!.tier = tiers.get(e.id);
  }

  // ── leaf: file tiles ────────────────────────────────────────────────────
  const tiles: FileChip[] = [];
  if (input.leaf) {
    const n = input.tiles.length;
    const cols = n <= 3 ? Math.max(1, n) : n <= 6 ? 3 : n <= 16 ? 4 : 5;
    const th = input.meaning ? TILE.meaningH : TILE.h;
    input.tiles.forEach((f, i) => {
      const c = i % cols;
      const r = Math.floor(i / cols);
      tiles.push({ path: f.path, name: baseName(f.path), dir: dirName(f.path), note: f.note, x: c * (TILE.w + 16), y: r * (th + 16), w: TILE.w, h: th });
    });
    content = union(tiles);
  }

  // ── frame ───────────────────────────────────────────────────────────────
  let frame: Rect | null = null;
  let emptyNote: Rect | undefined;
  if (scopeId) {
    if (!content) {
      emptyNote = { x: 0, y: 0, w: 360, h: 72 };
      content = emptyNote;
    }
    const all = union([content, ...stubs]) ?? content;
    frame = inflate(all, FRAME_PAD.top, FRAME_PAD.side, FRAME_PAD.bottom, FRAME_PAD.side);
    const ins = stubs.filter((s) => s.dir === 'in');
    const outs = stubs.filter((s) => s.dir === 'out');
    if (ins.length) {
      const left = ins[0].x + ins[0].w - 14;
      frame = { ...frame, w: frame.x + frame.w - left, x: left };
    }
    if (outs.length) frame = { ...frame, w: outs[0].x + 14 - frame.x };
    const minW = 560;
    if (frame.w < minW && !ins.length && !outs.length) frame = { ...frame, x: frame.x - (minW - frame.w) / 2, w: minW };
  }

  // Free stubs (leaf scopes): stacked at the frame's sides, vertically centred.
  const free = input.stubs.filter((s) => s.free);
  if (frame && free.length) {
    for (const dir of ['in', 'out'] as const) {
      const list = free.filter((s) => s.dir === dir);
      const total = list.length * STUB_H + (list.length - 1) * 12;
      let y = frame.y + FRAME_PAD.top + (frame.h - FRAME_PAD.top - FRAME_PAD.bottom) / 2 - total / 2;
      for (const s of list) {
        const w = stubWidth(s.label);
        stubs.push({ key: s.key, dir, target: s.target, label: s.label, free: true, x: dir === 'in' ? frame.x + 14 - w : frame.x + frame.w - 14, y, w, h: STUB_H });
        y += STUB_H + 12;
      }
    }
  }

  // ── file shelf ──────────────────────────────────────────────────────────
  const shelf: FileChip[] = [];
  let shelfLabel: Pt | undefined;
  if (input.shelf.length && (content || frame)) {
    const area = frame ?? content!;
    const left = frame ? frame.x + 28 : content!.x;
    const maxW = frame ? frame.w - 56 : Math.max(content!.w, 640);
    const top = (frame ? frame.y + frame.h - FRAME_PAD.bottom : area.y + area.h) + (frame ? 20 : 72);
    if (!frame) shelfLabel = { x: left, y: top - 26 };
    let x = left;
    let y = top;
    for (const f of input.shelf) {
      const name = baseName(f.path);
      const text = input.meaning && f.note ? f.note : name;
      const w = Math.min(320, textWidth(text, input.meaning && f.note ? 12 : 11.5, input.meaning && f.note ? undefined : FONT_MONO) + 48);
      if (x + w > left + maxW && x > left) {
        x = left;
        y += 30 + 8;
      }
      shelf.push({ path: f.path, name, dir: dirName(f.path), note: f.note, x, y, w, h: 30 });
      x += w + 8;
    }
    const bottom = y + 30;
    if (frame) frame = { ...frame, h: bottom + 28 - frame.y };
  }

  const bounds = frame ?? union([...(content ? [content] : []), ...shelf, ...(shelfLabel ? [{ ...shelfLabel, w: 10, h: 10 }] : [])]);
  return {
    key: scopeKey(scopeId),
    scopeId,
    signature: input.signature,
    nodes,
    order: Object.values(nodes)
      .sort((a, b) => a.x - b.x || a.y - b.y)
      .map((n) => n.id),
    edges,
    stubs,
    frame,
    shelf,
    shelfLabel,
    tiles,
    emptyNote,
    bounds,
  };
}
