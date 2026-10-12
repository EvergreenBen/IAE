// One scope drawn in world units: its frame, edges, stubs, nodes and files.
// The camera owns the layer's transform; React only re-renders on data changes.
import { memo, useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { childrenOf, ownerOf, visibleAncestor } from '@shared/map';
import type { AgentInfo, ArchMap, FileEntry } from '@shared/model';
import { useIae } from '../state/store';
import { nowText } from './crewTime';
import { useCamera } from './context';
import { Edges, Stubs } from './Edges';
import { EmptyLeaf, Shelf, Tiles } from './Files';
import { KindGlyph } from './glyphs';
import type { ScopeLayout } from './layout';
import { NodeCard } from './NodeCard';
import { useMapLocal, type LayerSpec } from './mapStore';
import s from './ScopeLayer.module.css';

const EASE_IO = [0.65, 0, 0.35, 1] as const;
const ACTIVE = new Set(['starting', 'thinking', 'working', 'waiting']);

const BASE_DELAY: Record<LayerSpec['role'], number> = { base: 0.04, diveOuter: 0, diveInner: 0.22, surfaceOuter: 0, surfaceInner: 0 };

// File counts per node (including descendants), shared by all layers.
let countsMemo: { map: ArchMap; files: FileEntry[]; out: Map<string, number> } | null = null;
function fileCounts(map: ArchMap, files: FileEntry[]): Map<string, number> {
  if (countsMemo && countsMemo.map === map && countsMemo.files === files) return countsMemo.out;
  const out = new Map<string, number>();
  for (const f of files) {
    let cur = f.nodeId;
    const seen = new Set<string>();
    while (cur && map.nodes[cur] && !seen.has(cur)) {
      seen.add(cur);
      out.set(cur, (out.get(cur) ?? 0) + 1);
      cur = map.nodes[cur].parentId;
    }
  }
  countsMemo = { map, files, out };
  return out;
}

function buildHues(map: ArchMap, agents: Record<string, AgentInfo>, scopeId: string | null): Map<string, number> {
  const out = new Map<string, number>();
  for (const a of Object.values(agents)) {
    if (a.role === 'lead' || !a.nodeId || !ACTIVE.has(a.status) || a.status === 'waiting') continue;
    const v = visibleAncestor(map, a.nodeId, scopeId);
    if (v && !out.has(v)) out.set(v, a.hue);
  }
  return out;
}

/**
 * What the builders on each node are on now, in plain words, as "hue\ttext"
 * lines (a string keeps NodeCard's memo cheap). It takes the place of the
 * node's summary while they work there.
 */
function doingLines(map: ArchMap, agents: Record<string, AgentInfo>, scopeId: string | null): Map<string, string> {
  const out = new Map<string, string[]>();
  for (const a of Object.values(agents).sort((x, y) => x.startedAt - y.startedAt)) {
    if (a.role === 'lead' || !a.nodeId || !ACTIVE.has(a.status)) continue;
    const text = nowText(a);
    const v = text ? visibleAncestor(map, a.nodeId, scopeId) : null;
    if (!v) continue;
    out.set(v, [...(out.get(v) ?? []), `${a.hue}\t${text}`]);
  }
  return new Map([...out].map(([id, lines]) => [id, lines.join('\n')]));
}

/**
 * Every part a builder has changed, lifted to what this scope shows, in that
 * builder's hue: the footprint of a change across the system. It stays while
 * the builder is on the crew list (a finished one stays until cleared).
 */
function changedHues(map: ArchMap, agents: Record<string, AgentInfo>, scopeId: string | null): Map<string, number> {
  const out = new Map<string, number>();
  const newestFirst = Object.values(agents)
    .filter((a) => a.role === 'builder' && a.changes?.length && a.status !== 'failed' && a.status !== 'stopped')
    .sort((x, y) => y.startedAt - x.startedAt);
  for (const a of newestFirst) {
    for (const c of a.changes!) {
      const owner = ownerOf(map, c.path);
      const v = owner ? visibleAncestor(map, owner, scopeId) : null;
      if (v && !out.has(v)) out.set(v, a.hue);
    }
  }
  return out;
}

export const ScopeLayer = memo(function ScopeLayer({ spec }: { spec: LayerSpec }) {
  const cam = useCamera();
  const layout = useMapLocal((st) => st.layouts[spec.key]) as ScopeLayout | undefined;
  const hovered = useMapLocal((st) => (spec.role === 'base' ? st.hovered : null));
  const map = useIae((st) => st.map);
  const files = useIae((st) => st.files);
  const agents = useIae((st) => st.agents);
  const selected = useIae((st) => st.selectedNodeId);

  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      cam?.attach(spec.key, el);
    },
    [cam, spec.key],
  );

  const counts = fileCounts(map, files);
  const hues = useMemo(() => buildHues(map, agents, spec.scopeId), [map, agents, spec.scopeId]);
  const changed = useMemo(() => changedHues(map, agents, spec.scopeId), [map, agents, spec.scopeId]);
  const doing = useMemo(() => doingLines(map, agents, spec.scopeId), [map, agents, spec.scopeId]);
  const chips = useMemo(() => {
    const out = new Map<string, string>();
    if (!layout) return out;
    for (const id of layout.order)
      if (layout.nodes[id].container)
        out.set(
          id,
          childrenOf(map, id)
            .map((c) => c.label)
            .join('\n'),
        );
    return out;
  }, [map, layout]);

  // Nodes seen by this layer instance: only newcomers get an entrance.
  const known = useRef<Set<string> | null>(null);
  useLayoutEffect(() => {
    if (layout) known.current = new Set(layout.order);
  });
  const fresh = performance.now() - spec.bornAt < 700;
  const baseDelay = fresh ? BASE_DELAY[spec.role] : 0;
  const ghostSpots = useMapLocal.getState().ghostSpots;

  if (!layout) return null;
  const interactive = spec.role === 'base';
  const scopeNode = spec.scopeId ? map.nodes[spec.scopeId] : null;
  const first = known.current === null;
  const hot = [hovered, selected].filter(Boolean).join(',');

  return (
    <motion.div
      ref={ref}
      className={s.layer}
      data-role={spec.role}
      data-scope={spec.key}
      initial={{ opacity: spec.role === 'diveInner' ? 0 : 1 }}
      animate={{ opacity: spec.role === 'surfaceInner' ? 0 : 1 }}
      transition={{ opacity: spec.role === 'surfaceInner' ? { duration: 0.42, delay: 0.12, ease: EASE_IO } : { duration: 0.46, delay: spec.role === 'diveInner' ? 0.14 : 0, ease: EASE_IO } }}
    >
      <div className={s.decor}>
        {layout.frame && scopeNode && (
          <motion.div
            className={s.frame}
            data-status={scopeNode.status}
            initial={{ x: layout.frame.x, y: layout.frame.y, width: layout.frame.w, height: layout.frame.h }}
            animate={{ x: layout.frame.x, y: layout.frame.y, width: layout.frame.w, height: layout.frame.h }}
            transition={{ duration: 0.42, ease: EASE_IO }}
          >
            <div className={s.frameHead}>
              <KindGlyph kind={scopeNode.kind} size={17} />
              <span className={s.frameTitle}>{scopeNode.label}</span>
              {scopeNode.summary && <span className={s.frameSummary}>{scopeNode.summary}</span>}
            </div>
          </motion.div>
        )}
        <Edges edges={layout.edges} hot={hot} delay={baseDelay} />
        <Stubs stubs={layout.stubs} interactive={interactive} delay={baseDelay} />
        {layout.shelf.length > 0 && <Shelf chips={layout.shelf} label={layout.shelfLabel} delay={baseDelay} />}
      </div>
      <div className={s.nodes}>
        <AnimatePresence>
          {layout.order.map((id, i) => {
            const node = map.nodes[id];
            if (!node) return null;
            const isNew = first || !known.current!.has(id);
            const spot = isNew && !first ? ghostSpots[id] : undefined;
            const from = spot && spot.scope === spec.key && Date.now() - spot.at < 20_000 ? spot : null;
            return (
              <NodeCard
                key={id}
                node={node}
                box={layout.nodes[id]}
                chips={chips.get(id) ?? ''}
                files={counts.get(id) ?? 0}
                selected={interactive && selected === id}
                buildHue={hues.get(id) ?? null}
                changedHue={changed.get(id) ?? null}
                doing={doing.get(id) ?? ''}
                enterDelay={isNew ? (first ? baseDelay + Math.min(i * 0.03, 0.45) : 0) : null}
                from={from}
                interactive={interactive}
                focus={spec.focusId === id}
              />
            );
          })}
        </AnimatePresence>
        {layout.tiles.length > 0 && <Tiles tiles={layout.tiles} delay={baseDelay} />}
        {layout.emptyNote && <EmptyLeaf {...layout.emptyNote} planned={scopeNode?.status === 'planned'} />}
      </div>
    </motion.div>
  );
});
