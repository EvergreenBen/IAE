// One architecture node on the map: a disc with a caption under it. Positioned
// in world units by its layer; glides when the layout changes. The disc holds
// the glyph, label and file count; the summary and child chips sit outside it,
// where a circle has room for them. Hover or selection reveals the technical
// name and stack above the summary.
import { memo } from 'react';
import { motion } from 'motion/react';
import type { ArchNode } from '@shared/model';
import { ui } from '../state/store';
import { KindGlyph, Mark } from './glyphs';
import { CAPTION, type NodeBox } from './layout';
import { mapLocal } from './mapStore';
import s from './NodeCard.module.css';
import { techLine } from './techLine';

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
  /** Hue of the builder that changed something in here, if any. */
  changedHue: number | null;
  /** What the builders here are on now, "hue\ttext" per line: shown in place of the summary. */
  doing: string;
  /** Stagger delay for entrance (seconds); null = no entrance (already there). */
  enterDelay: number | null;
  /** Where to grow from (a ghost's spot) instead of fading in place. */
  from?: { x: number; y: number } | null;
  interactive: boolean;
  focus: boolean;
}

function NodeCardImpl({ node, box, chips, files, selected, buildHue, changedHue, doing, enterDelay, from, interactive, focus }: NodeCardProps) {
  const status = node.status;
  const building = status === 'building' || buildHue !== null;
  const childList = chips ? chips.split('\n') : [];
  const shown = fitChips(childList);
  const tech = techLine(node);
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
        className={s.disc}
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
        {box.container && <span className={s.outer} />}
        <span className={s.inner} />
        <div className={s.core}>
          <KindGlyph kind={node.kind} />
          <span className={s.label}>{node.label}</span>
          {files > 0 && (
            <span className={s.count} title={`${files} file${files === 1 ? '' : 's'}`}>
              {files}
            </span>
          )}
        </div>
        {status === 'broken' && (
          <span className={s.broken} title="Something here is broken">
            <Mark name="alert" size={13} />
          </span>
        )}
        {changedHue !== null && (
          <motion.span
            className={s.changed}
            style={{ ['--hue' as string]: `var(--agent-${changedHue % 6})` }}
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.32, ease: EASE_OUT }}
            aria-label="Changed"
          />
        )}
        {building && <span className={s.sheen} style={{ ['--hue' as string]: buildHue !== null ? `var(--agent-${buildHue % 6})` : 'var(--ink-3)' }} />}
      </div>
      <div className={s.caption}>
        {tech && (
          <div className={s.tech}>
            <span className={s.techLine}>
              {tech.name && <span className={s.techName}>{tech.name}</span>}
              {tech.name && tech.stack.length > 0 && ' · '}
              {tech.stack.join(' · ')}
            </span>
          </div>
        )}
        {doing ? (
          doing.split('\n').map((line) => {
            const [hue, text] = line.split('\t');
            return (
              <div key={line} className={s.doing}>
                <span className={s.doingDot} style={{ background: `var(--agent-${Number(hue) % 6})` }} />
                <span className={s.doingText}>{text}</span>
              </div>
            );
          })
        ) : node.summary ? (
          <div className={s.summary}>{node.summary}</div>
        ) : (
          <div className={s.summaryEmpty}>{fallbackLine(node)}</div>
        )}
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

/** The chips that fit one centred row under a container's disc. */
function fitChips(list: string[]): string[] {
  const rowW = CAPTION.w;
  const out: string[] = [];
  let x = 0;
  for (const c of list.slice(0, 4)) {
    const w = Math.min(rowW, c.length * 5.9 + 16);
    const room = rowW - (out.length < list.length - 1 ? 26 : 0);
    if (out.length && x + 4 + w > room) break;
    out.push(c);
    x += (out.length > 1 ? 4 : 0) + w;
  }
  return out;
}

export const NodeCard = memo(NodeCardImpl);
