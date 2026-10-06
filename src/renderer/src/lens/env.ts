// A lossless .env model for the lens's key/value editor.
//
// parseEnv() turns text into items; serializeEnv() turns them back. Untouched
// items keep their exact original text (spacing, quotes, `export`, inline
// comments), so a parse → serialize round trip returns the input unchanged.
// Edited entries are re-formatted minimally.
//
// Comments directly above an entry (no blank line between) become that entry's
// note. Other comments stand alone and read as section headings: a block
// separated from the next entry by a blank line, a ruled comment ("# ── DB ──"),
// and the file's opening comment when it sits on top of a run of entries
// ("# Local dev values" over DATABASE_URL, REDIS_URL, …), which describes the
// file, not just its first key.

export interface EnvEntry {
  id: string;
  kind: 'entry';
  key: string;
  /** The literal value (between quotes when quoted; escapes are not expanded). */
  value: string;
  /** Comment text above the entry, `#` stripped. Null when there is none. */
  note: string | null;
  /** Exact comment lines above the entry, until the note is edited. */
  noteRaw: string[] | null;
  /** Exact original line(s) of the entry, until it is edited. */
  raw: string | null;
  exported: boolean;
  quote: '' | '"' | "'";
  /** Trailing inline comment including its leading whitespace: `  # note`. */
  inline: string;
  /** What the file said when parsed, so an edit undone by hand restores the exact text. Null for new entries. */
  source: { key: string; value: string; raw: string; note: string | null; noteRaw: string[] | null } | null;
}

export interface EnvComment {
  id: string;
  kind: 'comment';
  text: string;
  raw: string;
}

export interface EnvBlank {
  id: string;
  kind: 'blank';
  raw: string;
}

/** A line that isn't a comment or an assignment. Kept verbatim. */
export interface EnvOther {
  id: string;
  kind: 'other';
  raw: string;
}

export type EnvItem = EnvEntry | EnvComment | EnvBlank | EnvOther;

export interface EnvDoc {
  items: EnvItem[];
  eol: '\n' | '\r\n';
  trailingNewline: boolean;
}

let seq = 0;
const nextId = () => `env-${++seq}`;

const ASSIGN = /^(\s*)(export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/;

const commentText = (line: string) => line.replace(/^\s*#\s?/, '');

/** A comment drawn as a rule ("# ── Database ──", "# === Mail ===") is a heading, never a note. */
export const isRuleComment = (text: string): boolean => /^[\s]*[-─━=*#~_]{2,}|[-─━=*#~_]{2,}\s*$/.test(text) && headingText(text) !== '';

export function parseEnv(text: string): EnvDoc {
  const eol: EnvDoc['eol'] = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const trailingNewline = lines.length > 1 && lines[lines.length - 1] === '';
  if (trailingNewline) lines.pop();
  if (lines.length === 1 && lines[0] === '' && !trailingNewline) lines.pop();

  const items: EnvItem[] = [];
  let pending: string[] = [];
  const flush = () => {
    for (const raw of pending) items.push({ id: nextId(), kind: 'comment', text: commentText(raw), raw });
    pending = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*#/.test(line)) {
      if (isRuleComment(commentText(line))) {
        flush();
        items.push({ id: nextId(), kind: 'comment', text: commentText(line), raw: line });
      } else {
        pending.push(line);
      }
      continue;
    }
    const m = ASSIGN.exec(line);
    if (!m) {
      flush();
      items.push(line.trim() === '' ? { id: nextId(), kind: 'blank', raw: line } : { id: nextId(), kind: 'other', raw: line });
      continue;
    }
    const [, , exp, key, rest] = m;
    let value = rest;
    let quote: EnvEntry['quote'] = '';
    let inline = '';
    const rawLines = [line];
    const q = rest[0];
    if (q === '"' || q === "'") {
      // Quoted: find the closing quote, possibly on a later line (multi-line values).
      let body = rest.slice(1);
      let close = findClose(body, q);
      let j = i;
      while (close === -1 && j + 1 < lines.length) {
        j++;
        body += '\n' + lines[j];
        rawLines.push(lines[j]);
        close = findClose(body, q);
      }
      if (close === -1) {
        // Unterminated — treat as a plain value so nothing is lost.
        value = rest;
        rawLines.length = 1;
      } else {
        quote = q;
        value = body.slice(0, close);
        inline = body.slice(close + 1);
        i = j;
      }
    } else {
      const hash = rest.search(/\s+#/);
      if (hash !== -1) {
        value = rest.slice(0, hash);
        inline = rest.slice(hash);
      }
      value = value.replace(/\s+$/, (ws) => {
        inline = ws + inline;
        return '';
      });
    }
    // The file's opening comment over a run of entries is a header, not the first key's note.
    if (pending.length && isFileHeader(items) && i + 1 < lines.length && ASSIGN.test(lines[i + 1])) flush();
    const note = pending.length ? pending.map(commentText).join('\n') : null;
    const noteRaw = pending.length ? pending : null;
    const raw = rawLines.join(eol);
    items.push({
      id: nextId(),
      kind: 'entry',
      key,
      value,
      note,
      noteRaw,
      raw,
      exported: Boolean(exp),
      quote,
      inline,
      source: { key, value, raw, note, noteRaw },
    });
    pending = [];
  }
  flush();
  return { items, eol, trailingNewline };
}

/** Nothing but blank lines came before: a comment here opens the file. */
const isFileHeader = (before: EnvItem[]): boolean => before.every((it) => it.kind === 'blank');

function findClose(body: string, q: string): number {
  for (let k = 0; k < body.length; k++) {
    if (body[k] === '\\' && q === '"') {
      k++;
      continue;
    }
    if (body[k] === q) return k;
  }
  return -1;
}

/** Quote a value only when it needs it, preferring the entry's existing style. */
export function formatValue(value: string, prefer: EnvEntry['quote']): string {
  if (prefer) {
    if (!value.includes(prefer)) return `${prefer}${value}${prefer}`;
  } else if (!/[\s#"'`\\]/.test(value)) {
    return value;
  }
  if (!value.includes('"')) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;
  return `"${value.replace(/"/g, '\\"')}"`;
}

export function formatEntry(e: EnvEntry): string {
  return `${e.exported ? 'export ' : ''}${e.key}=${formatValue(e.value, e.quote)}${e.inline}`;
}

export function serializeEnv(doc: EnvDoc): string {
  const out: string[] = [];
  for (const it of doc.items) {
    if (it.kind === 'entry') {
      if (it.noteRaw) out.push(...it.noteRaw);
      else if (it.note) out.push(...it.note.split('\n').map((l) => (l ? `# ${l}` : '#')));
      out.push(it.raw ?? formatEntry(it));
    } else {
      out.push(it.raw);
    }
  }
  const body = out.join(doc.eol);
  return doc.trailingNewline ? body + doc.eol : body;
}

// ── edits (immutable) ────────────────────────────────────────────────────────

export function updateEntry(doc: EnvDoc, id: string, patch: Partial<Pick<EnvEntry, 'key' | 'value' | 'note'>>): EnvDoc {
  return {
    ...doc,
    items: doc.items.map((it) => {
      if (it.id !== id || it.kind !== 'entry') return it;
      const next: EnvEntry = { ...it, ...patch };
      const src = it.source;
      if ('key' in patch || 'value' in patch) next.raw = src && next.key === src.key && next.value === src.value ? src.raw : null;
      if ('note' in patch) next.noteRaw = src && (next.note || null) === src.note ? src.noteRaw : null;
      return next;
    }),
  };
}

export function addEntry(doc: EnvDoc, key: string, value: string): { doc: EnvDoc; id: string } {
  const entry: EnvEntry = { id: nextId(), kind: 'entry', key, value, note: null, noteRaw: null, raw: null, exported: false, quote: '', inline: '', source: null };
  // Append after the last non-blank item so trailing blank lines stay trailing.
  const items = [...doc.items];
  let at = items.length;
  while (at > 0 && items[at - 1].kind === 'blank') at--;
  items.splice(at, 0, entry);
  return { doc: { ...doc, items, trailingNewline: doc.trailingNewline || doc.items.length === 0 }, id: entry.id };
}

export function removeItem(doc: EnvDoc, id: string): { doc: EnvDoc; removed: EnvItem | null; index: number } {
  const index = doc.items.findIndex((it) => it.id === id);
  if (index === -1) return { doc, removed: null, index };
  const items = [...doc.items];
  const [removed] = items.splice(index, 1);
  return { doc: { ...doc, items }, removed, index };
}

export function insertItem(doc: EnvDoc, item: EnvItem, index: number): EnvDoc {
  const items = [...doc.items];
  items.splice(Math.min(Math.max(index, 0), items.length), 0, item);
  return { ...doc, items };
}

export const entriesOf = (doc: EnvDoc): EnvEntry[] => doc.items.filter((it): it is EnvEntry => it.kind === 'entry');

/** Keys that appear more than once (the last one wins at runtime). */
export function duplicateKeys(doc: EnvDoc): Set<string> {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const e of entriesOf(doc)) (seen.has(e.key) ? dup : seen).add(e.key);
  return dup;
}

/** Turn whatever someone types into a conventional env key: API_KEY. */
export function normalizeKey(input: string): string {
  return input
    .replace(/[\s-]+/g, '_')
    .replace(/[^A-Za-z0-9_.]/g, '')
    .replace(/^[0-9.]+/, '')
    .toUpperCase();
}

/** A free-standing comment as a quiet heading: strips rule characters like ── or ===. */
export function headingText(text: string): string {
  return text.replace(/^[\s\-─━=*#~_]+|[\s\-─━=*#~_]+$/g, '').trim();
}
