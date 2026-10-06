// The lens's code surface: CodeMirror 6 on paper. Uncontrolled editor with a
// controlled-ish contract: `doc` replaces the content only when it differs
// from what the editor already holds (reload, revert), so typing never
// round-trips through React. `doc` uses "\n" line breaks; the lens restores
// the file's own endings when it saves (see eol.ts).
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, indentOnInput } from '@codemirror/language';
import { closeSearchPanel, highlightSelectionMatches, search, searchKeymap, searchPanelOpen } from '@codemirror/search';
import { Compartment, EditorState } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { useEffect, useRef } from 'react';
import { ESC, onEscape } from '../ui/escape';
import { findPanel } from './findPanel';
import { languageForFile } from './languages';
import { paperTheme } from './paperTheme';
import s from './Lens.module.css';

interface Props {
  path: string;
  language?: string;
  doc: string;
  onChange: (text: string) => void;
  autoFocus?: boolean;
  /** Soft-wrap long lines (prose) instead of scrolling sideways (code). */
  wrap?: boolean;
}

const wrapping = (on: boolean) => (on ? EditorView.lineWrapping : []);

export function CodeView({ path, language, doc, onChange, autoFocus, wrap = false }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const wrapSlot = useRef(new Compartment());
  const wrapRef = useRef(wrap);
  wrapRef.current = wrap;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const docRef = useRef(doc);
  docRef.current = doc;

  useEffect(() => {
    const lang = languageForFile(path, language);
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: docRef.current,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          search({ top: false, createPanel: findPanel }),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          }),
          EditorView.contentAttributes.of({ 'aria-label': `Contents of ${path}`, spellcheck: 'false', autocorrect: 'off' }),
          paperTheme,
          wrapSlot.current.of(wrapping(wrapRef.current)),
          lang ?? [],
        ],
      }),
    });
    viewRef.current = view;
    if (autoFocus) view.focus();
    // Escape closes the find bar first, before the lens.
    const off = onEscape(() => {
      if (!searchPanelOpen(view.state)) return false;
      closeSearchPanel(view);
      view.focus();
      return true;
    }, ESC.field);
    return () => {
      off();
      view.destroy();
      viewRef.current = null;
    };
    // The editor is rebuilt only for a different file or language.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, language]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== doc) view.dispatch({ changes: { from: 0, to: current.length, insert: doc } });
  }, [doc]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: wrapSlot.current.reconfigure(wrapping(wrap)) });
  }, [wrap]);

  return <div ref={host} className={s.code} />;
}
