// The lens's Changes view: the file against its last commit. Read-only
// CodeMirror on the same paper as the code view, so it reads as the file with
// its changes marked: added lines on a green wash, removed on a red one, the
// old and new line numbers in the gutter, and each hunk introduced by a quiet
// "Line 40 · the function it's in". ⌘F finds within it.
import { defaultKeymap } from '@codemirror/commands';
import { closeSearchPanel, highlightSelectionMatches, search, searchKeymap, searchPanelOpen } from '@codemirror/search';
import { EditorState, RangeSet, type Range } from '@codemirror/state';
import { Decoration, drawSelection, EditorView, gutter, GutterMarker, gutterLineClass, keymap, WidgetType } from '@codemirror/view';
import type { DiffHunk, DiffLine, FileDiff } from '@shared/model';
import { motion } from 'motion/react';
import { useEffect, useRef, type ReactNode } from 'react';
import { ESC, onEscape } from '../ui/escape';
import { findPanel } from './findPanel';
import { languageForFile } from './languages';
import { paperTheme } from './paperTheme';
import type { DiffState } from './useDiff';
import ls from './Lens.module.css';
import s from './DiffView.module.css';

interface Props {
  path: string;
  language?: string;
  state: DiffState;
}

export function DiffView({ path, language, state }: Props) {
  if (state.status === 'loading') {
    return (
      <motion.p className={ls.opening} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.3 }}>
        Comparing…
      </motion.p>
    );
  }
  if (state.status === 'error') return <Calm title="This file couldn't be compared." body={<code>{state.message}</code>} />;
  if (state.status === 'nogit') return <Calm title="Nothing to compare with." body="This project isn't in git yet, so there's no last commit to compare against." />;
  const d = state.diff;
  if (d.binary) return <Calm title="It's not text." body="This file changed since the last commit, but it can't be shown line by line." />;
  if (!d.hunks.length && d.truncated) return <Calm title="Too large to show." body="This file changed a lot since the last commit: more than can be shown here." />;
  if (!d.hunks.length) return <Calm title="No changes since the last commit." body="The file is as it was." />;
  return (
    <div className={s.wrap}>
      <p className={s.summary}>
        {d.added > 0 && <span className={s.added}>+{d.added}</span>}
        {d.removed > 0 && <span className={s.removed}>−{d.removed}</span>}
        <span>{summaryText(d)}</span>
      </p>
      <DiffCode key={path} path={path} language={language} diff={d} />
    </div>
  );
}

function summaryText(d: FileDiff): string {
  const since = d.status === 'added' ? 'new since the last commit' : d.status === 'deleted' ? 'deleted since the last commit' : 'since the last commit';
  return d.truncated ? `${since} · the first ${d.hunks.reduce((n, h) => n + h.lines.length, 0).toLocaleString()} lines` : since;
}

function Calm({ title, body }: { title: string; body: ReactNode }) {
  return (
    <div className={ls.calm}>
      <p className={ls.calmTitle}>{title}</p>
      <p className={ls.calmBody}>{body}</p>
    </div>
  );
}

// ── the CodeMirror surface ───────────────────────────────────────────────────

class Text extends GutterMarker {
  constructor(readonly text: string) {
    super();
  }
  eq(o: Text): boolean {
    return o.text === this.text;
  }
  toDOM(): Node {
    return document.createTextNode(this.text);
  }
}

class RowClass extends GutterMarker {
  constructor(readonly elementClass: string) {
    super();
  }
}

class HunkHeader extends WidgetType {
  constructor(readonly h: DiffHunk) {
    super();
  }
  eq(o: HunkHeader): boolean {
    return o.h === this.h;
  }
  toDOM(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'cm-iae-hunk';
    const at = el.appendChild(document.createElement('span'));
    at.className = 'cm-iae-hunk-at';
    at.textContent = `Line ${this.h.newStart || this.h.oldStart}`;
    if (this.h.section) {
      const sec = el.appendChild(document.createElement('span'));
      sec.className = 'cm-iae-hunk-section';
      sec.textContent = this.h.section;
    }
    return el;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

const SIGN: Record<DiffLine['kind'], string> = { add: '+', del: '−', ctx: '' };
const ADD_ROW = new RowClass('cm-iae-row-add');
const HUNK_ROW = new RowClass('cm-iae-row-hunk');
const DEL_ROW = new RowClass('cm-iae-row-del');
const ADD_LINE = Decoration.line({ class: 'cm-iae-add' });
const DEL_LINE = Decoration.line({ class: 'cm-iae-del' });

const diffTheme = EditorView.theme(
  {
    '.cm-iae-add': { backgroundColor: 'var(--ok-wash)' },
    '.cm-iae-del': { backgroundColor: 'var(--bad-wash)' },
    '.cm-gutterElement.cm-iae-row-add': { backgroundColor: 'var(--ok-wash)' },
    '.cm-gutterElement.cm-iae-row-del': { backgroundColor: 'var(--bad-wash)' },
    '.cm-gutters': { paddingLeft: '0' },
    '.cm-iae-num .cm-gutterElement': {
      minWidth: '30px',
      padding: '0 8px 0 10px',
      textAlign: 'right',
      fontSize: '11px',
      fontVariantNumeric: 'tabular-nums',
      color: 'var(--ink-4)',
    },
    '.cm-iae-sign .cm-gutterElement': { width: '16px', textAlign: 'center', fontSize: '11.5px' },
    '.cm-iae-sign .cm-iae-row-add': { color: 'var(--ok)' },
    '.cm-iae-sign .cm-iae-row-del': { color: 'var(--bad)' },
    '.cm-content': { paddingTop: '8px' },
    // A hunk's header is a quiet band across the gutters and the text. Padding,
    // never margin: CodeMirror measures a block widget by its border box.
    '.cm-iae-hunk': {
      display: 'flex',
      gap: '10px',
      alignItems: 'baseline',
      padding: '6px 28px 6px 6px',
      fontFamily: 'var(--font-mono)',
      fontSize: '11px',
      lineHeight: '1.5',
      color: 'var(--ink-4)',
      backgroundColor: 'var(--hunk-band)',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      userSelect: 'none',
    },
    '.cm-gutterElement.cm-iae-row-hunk': { backgroundColor: 'var(--hunk-band)' },
    '.cm-iae-hunk-at': { flex: 'none', color: 'var(--ink-3)' },
    '.cm-iae-hunk-section': { overflow: 'hidden', textOverflow: 'ellipsis' },
  },
  { dark: true },
);

/** Everything the editor needs from a diff: the text, and what to mark on each line. */
function build(diff: FileDiff) {
  const rows: DiffLine[] = [];
  const widgets: Range<Decoration>[] = [];
  const lines: Range<Decoration>[] = [];
  const rowClasses: Range<GutterMarker>[] = [];
  // A header marks lines hidden above a hunk: none at the top of the file, none for a whole new (or deleted) file.
  const headers = diff.status === 'modified';
  let pos = 0;
  for (const [i, h] of diff.hunks.entries()) {
    const skipped = i > 0 || h.oldStart > 1 || h.newStart > 1;
    if (headers && skipped && h.lines.length) widgets.push(Decoration.widget({ widget: new HunkHeader(h), block: true, side: -1 }).range(pos));
    for (const l of h.lines) {
      rows.push(l);
      if (l.kind === 'add') {
        lines.push(ADD_LINE.range(pos));
        rowClasses.push(ADD_ROW.range(pos));
      } else if (l.kind === 'del') {
        lines.push(DEL_LINE.range(pos));
        rowClasses.push(DEL_ROW.range(pos));
      }
      pos += l.text.length + 1;
    }
  }
  const widest = Math.max(1, ...rows.map((r) => Math.max(r.oldNo ?? 0, r.newNo ?? 0)));
  return {
    doc: rows.map((r) => r.text).join('\n'),
    rows,
    decorations: Decoration.set([...widgets, ...lines], true),
    rowClasses: RangeSet.of(rowClasses, true),
    widest: String(widest),
  };
}

function DiffCode({ path, language, diff }: { path: string; language?: string; diff: FileDiff }) {
  const host = useRef<HTMLDivElement>(null);
  // A builder editing the file brings a fresh diff: keep the reader's place.
  const scrollTop = useRef(0);

  useEffect(() => {
    const b = build(diff);
    const row = (view: EditorView, from: number) => b.rows[view.state.doc.lineAt(from).number - 1];
    const numbers = (side: 'oldNo' | 'newNo') =>
      gutter({
        class: 'cm-iae-num',
        lineMarker: (view, line) => {
          const n = row(view, line.from)?.[side];
          return n ? new Text(String(n)) : null;
        },
        initialSpacer: () => new Text(b.widest),
        widgetMarker: band,
      });
    const band = (_view: EditorView, widget: WidgetType) => (widget instanceof HunkHeader ? HUNK_ROW : null);
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: b.doc,
        extensions: [
          EditorState.readOnly.of(true),
          numbers('oldNo'),
          numbers('newNo'),
          gutter({
            class: 'cm-iae-sign',
            lineMarker: (view, line) => {
              const r = row(view, line.from);
              return r && r.kind !== 'ctx' ? new Text(SIGN[r.kind]) : null;
            },
            widgetMarker: band,
          }),
          gutterLineClass.of(b.rowClasses),
          EditorView.decorations.of(b.decorations),
          drawSelection(),
          highlightSelectionMatches(),
          search({ top: false, createPanel: findPanel }),
          keymap.of([...defaultKeymap, ...searchKeymap]),
          EditorView.contentAttributes.of({ 'aria-label': `Changes to ${path}` }),
          paperTheme,
          diffTheme,
          languageForFile(path, language) ?? [],
        ],
      }),
    });
    if (scrollTop.current) view.scrollDOM.scrollTop = scrollTop.current;
    const off = onEscape(() => {
      if (!searchPanelOpen(view.state)) return false;
      closeSearchPanel(view);
      view.focus();
      return true;
    }, ESC.field);
    return () => {
      scrollTop.current = view.scrollDOM.scrollTop;
      off();
      view.destroy();
    };
  }, [path, language, diff]);

  return <div ref={host} className={s.code} />;
}
