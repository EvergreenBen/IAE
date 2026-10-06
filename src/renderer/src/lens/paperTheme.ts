// CodeMirror on the lens. Every colour is a design token, so the editor sits on
// the lens as part of it rather than as a transplanted IDE well.
//   keywords accent · strings spring · numbers amber · comments ink-3 italic
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

const theme = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--ink)',
    backgroundColor: 'transparent',
    fontSize: '12.75px',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: '1.7',
    fontVariantLigatures: 'none',
  },
  '.cm-content': {
    padding: '18px 0 40px',
    caretColor: 'var(--accent)',
  },
  '.cm-line': { padding: '0 28px 0 6px' },
  '.cm-cursor, .cm-dropCursor': { borderLeft: '1.5px solid var(--accent)' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--ink-4)',
    border: 'none',
    paddingLeft: '14px',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    minWidth: '28px',
    padding: '0 10px 0 0',
    fontSize: '11px',
    fontVariantNumeric: 'tabular-nums',
  },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--paper-lift) 42%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--ink-3)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--accent-wash)',
  },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--accent-wash) 60%, transparent)' },
  '&.cm-focused .cm-matchingBracket': {
    backgroundColor: 'transparent',
    outline: '1px solid var(--line-strong)',
    borderRadius: 'var(--r-sm)',
  },
  '.cm-searchMatch': {
    backgroundColor: 'color-mix(in srgb, var(--warn-wash) 85%, transparent)',
    borderRadius: 'var(--r-sm)',
  },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--accent-wash)' },
  // The find bar: a quiet strip on paper, not a toolbar.
  '.cm-panels': {
    backgroundColor: 'var(--paper-raised)',
    color: 'var(--ink-2)',
    fontFamily: 'var(--font-ui)',
  },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--line)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--line)' },
  '.cm-iae-find': {
    display: 'flex',
    alignItems: 'center',
    gap: '2px',
    height: '44px',
    padding: '0 12px 0 20px',
    fontSize: '12.5px',
  },
  '.cm-iae-find-input': {
    flex: '1',
    minWidth: '0',
    height: '30px',
    padding: '0 10px',
    border: '1px solid var(--line)',
    borderRadius: 'var(--r-pill)',
    backgroundColor: 'var(--paper)',
    fontFamily: 'var(--font-mono)',
    fontSize: '12.5px',
    color: 'var(--ink)',
    outline: 'none',
    maxWidth: '340px',
  },
  '.cm-iae-find-input:focus': { borderColor: 'var(--line-strong)', backgroundColor: 'var(--paper-raised)' },
  '.cm-iae-find-input::placeholder': { color: 'var(--ink-3)', fontFamily: 'var(--font-ui)' },
  '.cm-iae-find-count': {
    minWidth: '86px',
    padding: '0 10px',
    color: 'var(--ink-3)',
    fontVariantNumeric: 'tabular-nums',
  },
  '.cm-iae-find-none .cm-iae-find-count': { color: 'var(--bad)' },
  '.cm-iae-find-btn': {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '28px',
    height: '28px',
    borderRadius: 'var(--r-disc)',
    color: 'var(--ink-3)',
    cursor: 'pointer',
  },
  '.cm-iae-find-btn:hover': { backgroundColor: 'var(--paper-lift)', color: 'var(--ink)' },
  '.cm-tooltip': {
    border: '1px solid var(--line)',
    backgroundColor: 'var(--paper-raised)',
    borderRadius: 'var(--r-sm)',
    boxShadow: 'var(--shadow-2)',
  },
}, { dark: true });

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword, t.modifier, t.self], color: 'var(--accent-ink)' },
  { tag: [t.string, t.special(t.string), t.regexp, t.character, t.attributeValue], color: 'var(--agent-1)' },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit], color: 'var(--agent-2)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--ink-3)', fontStyle: 'italic' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--ink-2)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName))], color: 'var(--ink)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--ink-2)' },
  { tag: [t.definition(t.propertyName)], color: 'var(--ink)' },
  { tag: [t.tagName, t.angleBracket], color: 'var(--accent-ink)' },
  { tag: [t.operator, t.punctuation, t.bracket, t.separator], color: 'var(--ink-3)' },
  { tag: t.meta, color: 'var(--ink-3)' },
  { tag: t.invalid, color: 'var(--bad)' },
  // Prose (markdown)
  { tag: t.heading, color: 'var(--ink)', fontWeight: '650' },
  { tag: t.heading1, fontSize: '1.08em' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: '650' },
  { tag: [t.link, t.url], color: 'var(--accent-ink)' },
  { tag: t.monospace, color: 'var(--agent-1)' },
  { tag: [t.quote, t.list], color: 'var(--ink-2)' },
  { tag: t.contentSeparator, color: 'var(--ink-4)' },
]);

export const paperTheme = [theme, syntaxHighlighting(highlight)];
