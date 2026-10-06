// Files live inside the node that owns them: a quiet shelf of chips inside a
// scope's frame, or a calm grid of tiles when the scope is a leaf.
import { memo } from 'react';
import { motion } from 'motion/react';
import { ui, useIae } from '../state/store';
import { FileGlyph } from './glyphs';
import type { FileChip } from './layout';
import s from './Files.module.css';

const EASE_OUT = [0.22, 1, 0.36, 1] as const;

export const Shelf = memo(function Shelf({ chips, label, delay }: { chips: FileChip[]; label?: { x: number; y: number }; delay: number }) {
  const meaning = useIae((st) => st.meaning);
  const open = useIae((st) => st.openFile);
  return (
    <>
      {label && (
        <div className={s.shelfLabel} style={{ transform: `translate(${label.x}px, ${label.y}px)` }}>
          Project files
        </div>
      )}
      {chips.map((c, i) => (
        <motion.button
          key={c.path}
          type="button"
          className={s.chip}
          data-nopan
          data-open={open === c.path || undefined}
          data-meaning={(meaning && !!c.note) || undefined}
          title={c.path}
          initial={{ opacity: 0, x: c.x, y: c.y }}
          animate={{ opacity: 1, x: c.x, y: c.y }}
          transition={{ opacity: { duration: 0.3, delay: delay + 0.2 + Math.min(i, 12) * 0.02, ease: EASE_OUT }, x: { duration: 0.42 }, y: { duration: 0.42 } }}
          style={{ width: c.w, height: c.h }}
          onClick={(e) => {
            e.stopPropagation();
            ui.openFile(c.path);
          }}
        >
          <FileGlyph path={c.path} size={13} />
          <span className={s.chipText}>{meaning && c.note ? c.note : c.name}</span>
        </motion.button>
      ))}
    </>
  );
});

export const Tiles = memo(function Tiles({ tiles, delay }: { tiles: FileChip[]; delay: number }) {
  const meaning = useIae((st) => st.meaning);
  const open = useIae((st) => st.openFile);
  return (
    <>
      {tiles.map((t, i) => (
        <motion.button
          key={t.path}
          type="button"
          className={s.tile}
          data-nopan
          data-file={t.path}
          data-open={open === t.path || undefined}
          title={t.path}
          initial={{ opacity: 0, scale: 0.97, x: t.x, y: t.y, height: t.h }}
          animate={{ opacity: 1, scale: 1, x: t.x, y: t.y, height: t.h }}
          transition={{ opacity: { duration: 0.32, delay: delay + Math.min(i, 16) * 0.03, ease: EASE_OUT }, scale: { duration: 0.32, delay: delay + Math.min(i, 16) * 0.03 }, x: { duration: 0.42 }, y: { duration: 0.42 }, height: { duration: 0.42 } }}
          style={{ width: t.w }}
          onClick={(e) => {
            e.stopPropagation();
            ui.openFile(t.path);
          }}
        >
          <span className={s.tileHead}>
            <FileGlyph path={t.path} size={15} />
            <span className={s.tileName}>{t.name}</span>
          </span>
          {meaning ? <span className={s.tileNote}>{t.note ?? <span className={s.noNote}>{t.dir || '/'}</span>}</span> : <span className={s.tileDir}>{t.dir || '/'}</span>}
        </motion.button>
      ))}
    </>
  );
});

export function EmptyLeaf({ x, y, w, h, planned }: { x: number; y: number; w: number; h: number; planned: boolean }) {
  return (
    <div className={s.empty} style={{ transform: `translate(${x}px, ${y}px)`, width: w, height: h }}>
      <span className={s.emptyLine}>{planned ? 'Planned. Files appear here as it gets built.' : 'No files here yet.'}</span>
    </div>
  );
}
