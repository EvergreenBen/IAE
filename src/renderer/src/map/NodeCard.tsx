// One architecture node on the map: a paper card. Positioned in world units by
// its layer; glides when the layout changes.
import { memo } from 'react';
import { motion } from 'motion/react';
import type { ArchNode } from '@shared/model';
import { ui } from '../state/store';
import { KindGlyph, Mark } from './glyphs';
import type { NodeBox } from './layout';
import { mapLocal } from './mapStore';
import s from './NodeCard.module.css';

const EASE_IO = [0.65, 0, 0.35, 1] as const;
const EASE_OUT = [0.22, 1, 0.36, 1] as const;

export interface NodeCardProps {
  node: ArchNode;
  box: NodeBox;
  /** Child labels joined by \n (string keeps memo cheap). */
  chips: string;
  files: number;
  selected: boolean;
  /** Hue of the agent building here, if any. */
  buildHue: number | null;
  /** Stagger delay for entrance (seconds); null = no entrance (already there). */
  enterDelay: number | null;
  /** Where to grow from (a ghost's spot) instead of fading in place. */
  from?: { x: number; y: number } | null;
  interactive: boolean;
  focus: boolean;
}

function NodeCardImpl({ node, box, chips, files, selected, buildHue, enterDelay, from, interactive, focus }: NodeCardProps) {
  const status = node.status;
  const building = status === 'building' || buildHue !== null;
  const childList = chips ? chips.split('\n') : [];
  const shown = fitChips(childList);
  const initial =
    from != null
      ? { x: from.x, y: from.y, width: box.w, height: box.h, opacity: 0.6, scale: 1 }
      : enterDelay != null
        ? { x: box.x, y: box.y, width: box.w, height: box.h, opacity: 0, scale: 0.96 }
        : false;

  return (
    <motion.div
      className={s.pos}
      data-focus={focus || undefined}
      initial={initial}
      animate={{ x: box.x, y: box.y, width: box.w, height: box.h, opacity: 1, scale: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.2 } }}
      transition={{
        x: { duration: from ? 0.56 : 0.42, ease: EASE_IO },
        y: { duration: from ? 0.56 : 0.42, ease: EASE_IO },
        width: { duration: 0.42, ease: EASE_IO },
        height: { duration: 0.42, ease: EASE_IO },
        opacity: { duration: 0.32, ease: EASE_OUT, delay: enterDelay ?? 0 },
        scale: { duration: 0.32, ease: EASE_OUT, delay: enterDelay ?? 0 },
      }}
    >
      <div
        className={s.card}
        data-node-id={node.id}
        data-status={status}
        data-selected={selected || undefined}
        data-container={box.container || undefined}
        onClick={
          interactive
            ? (e) => {
                e.stopPropagation();
                ui.select(node.id);
              }
            : undefined
        }
        onDoubleClick={
          interactive
            ? (e) => {
                e.stopPropagation();
                ui.setScope(node.id);
              }
            : undefined
        }
        onMouseEnter={interactive ? () => mapLocal.setHovered(node.id) : undefined}
        onMouseLeave={interactive ? () => mapLocal.setHovered(null) : undefined}
      >
        <div className={s.head}>
          <KindGlyph kind={node.kind} />
          <span className={s.label}>{node.label}</span>
          {status === 'broken' && (
            <span className={s.broken} title="Something here is broken">
              <Mark name="alert" size={13} />
            </span>
          )}
          {files > 0 && (
            <span className={s.count} title={`${files} file${files === 1 ? '' : 's'}`}>
              {files}
            </span>
          )}
        </div>
        {node.summary ? <div className={s.summary}>{node.summary}</div> : <div className={s.summaryEmpty}>{fallbackLine(node)}</div>}
        {box.container && childList.length > 0 && (
          <div className={s.chips}>
            {shown.map((c) => (
              <span key={c} className={s.chip}>
                {c}
              </span>
            ))}
            {childList.length > shown.length && <span className={s.more}>+{childList.length - shown.length}</span>}
          </div>
        )}
        {building && <span className={s.sheen} style={{ ['--hue' as string]: buildHue !== null ? `var(--agent-${buildHue % 6})` : 'var(--ink-3)' }} />}
      </div>
    </motion.div>
  );
}

const KIND_WORDS: Record<ArchNode['kind'], string> = {
  system: 'System',
  client: 'Client',
  service: 'Service',
  module: 'Module',
  data: 'Data store',
  queue: 'Queue',
  external: 'External service',
  config: 'Configuration',
  infra: 'Infrastructure',
  ai: 'Model',
};

/** Something quiet and true when there's no summary yet. */
function fallbackLine(node: ArchNode): string {
  if (node.tech?.length) return node.tech.slice(0, 3).join(' · ');
  return node.status === 'planned' ? `Planned ${KIND_WORDS[node.kind].toLowerCase()}` : KIND_WORDS[node.kind];
}

/** Up to four chips that fit two short rows inside a container card. */
function fitChips(list: string[]): string[] {
  const out: string[] = [];
  const rowW = 236 - 32;
  let row = 0;
  let x = 0;
  for (const c of list.slice(0, 4)) {
    const w = Math.min(rowW, c.length * 5.9 + 14);
    if (x + w > rowW - (out.length < list.length - 1 ? 26 : 0)) {
      row++;
      x = 0;
      if (row > 1) break;
    }
    out.push(c);
    x += w + 4;
  }
  return out;
}

export const NodeCard = memo(NodeCardImpl);
