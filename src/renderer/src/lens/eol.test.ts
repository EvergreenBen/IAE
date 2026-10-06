import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { detectEol, fromLf, toLf } from './eol';

describe('line endings', () => {
  it('detects the separator a file mostly uses', () => {
    expect(detectEol('a\nb\n')).toBe('\n');
    expect(detectEol('a\r\nb\r\n')).toBe('\r\n');
    expect(detectEol('a\r\nb\r\nc\n')).toBe('\r\n');
    expect(detectEol('a\nb\nc\r\n')).toBe('\n');
    expect(detectEol('')).toBe('\n');
  });

  it('round-trips a CRLF file through the editor without looking edited', () => {
    const file = 'const a = 1;\r\n\r\nexport default a;\r\n';
    const text = toLf(file);
    // What the lens hands CodeMirror and compares against: the editor gives it back unchanged.
    const editor = EditorState.create({ doc: text });
    expect(editor.doc.toString()).toBe(text);
    expect(fromLf(editor.doc.toString(), detectEol(file))).toBe(file);
  });

  it('writes edits with the file’s own separator', () => {
    const file = 'A=1\r\nB=2\r\n';
    const edited = toLf(file).replace('B=2', 'B=2\nC=3');
    expect(fromLf(edited, detectEol(file))).toBe('A=1\r\nB=2\r\nC=3\r\n');
  });

  it('leaves LF files alone', () => {
    const file = 'a\nb\n';
    expect(toLf(file)).toBe(file);
    expect(fromLf(file, '\n')).toBe(file);
  });
});
