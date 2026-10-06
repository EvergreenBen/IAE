// Line endings for the lens. The editors work in "\n" (CodeMirror normalizes
// line breaks); the file keeps whatever it had. A CRLF file is read as LF,
// compared as LF (so it never opens looking edited) and written back as CRLF.

export type Eol = '\n' | '\r\n';

/** The file's line separator: CRLF when that is what most of its lines use. */
export function detectEol(text: string): Eol {
  const crlf = text.split('\r\n').length - 1;
  if (crlf === 0) return '\n';
  const lf = text.split('\n').length - 1 - crlf;
  return crlf >= lf ? '\r\n' : '\n';
}

/** Every line break as "\n" (CRLF and lone CR alike). */
export const toLf = (text: string): string => (text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text);

/** Back to the file's own separator for writing. */
export const fromLf = (text: string, eol: Eol): string => (eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text);
