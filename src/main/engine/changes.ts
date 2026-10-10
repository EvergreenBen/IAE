// What a builder changed, file by file: lines added and removed as it edits.
// An edit counts once its tool result comes back without an error. The count
// comes from Claude Code's own patch when the result carries one (the exact
// lines it wrote); otherwise from the edit itself: old_string → new_string,
// or, for a Write over an existing file, the file as it was when the call
// arrived.

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FileChange } from '../../shared/model';

export interface LineCount {
  added: number;
  removed: number;
}

/** Files kept per builder. */
export const MAX_CHANGES = 100;
/** A Write's previous content is only kept for files up to this size. */
const MAX_BEFORE_BYTES = 2 * 1024 * 1024;
/** Beyond this many differing lines a line diff stops looking for common lines. */
const MAX_EDIT_DISTANCE = 1500;

export const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/** A text's lines, without the empty piece after a final newline. */
export function textLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Shortest edit script length between two line lists (Myers), or null past `maxD`. */
function editDistance(a: string[], b: string[], maxD: number): number | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, maxD);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) return d;
    }
  }
  return null;
}

/** Lines added and removed going from `before` to `after`: a minimal line diff. */
export function countLines(before: string, after: string): LineCount {
  const a = textLines(before);
  const b = textLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const n = endA - start;
  const m = endB - start;
  if (!n || !m) return { added: m, removed: n };
  const d = editDistance(a.slice(start, endA), b.slice(start, endB), MAX_EDIT_DISTANCE);
  // Too different to be worth the search: count it as rewritten.
  if (d === null) return { added: m, removed: n };
  const common = (n + m - d) / 2;
  return { added: m - common, removed: n - common };
}

const add = (a: LineCount, b: LineCount): LineCount => ({ added: a.added + b.added, removed: a.removed + b.removed });
const times = (c: LineCount, k: number): LineCount => ({ added: c.added * k, removed: c.removed * k });
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** How many times `needle` occurs in `hay` (at least once: the edit succeeded). */
function occurrences(hay: string, needle: string): number {
  if (!needle) return 1;
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++;
  return Math.max(1, n);
}

/** Claude Code's `structuredPatch` ({ lines: ["+…", "-…", " …"] }[]): its + and − lines. */
export function patchCount(patch: unknown): LineCount | null {
  if (!Array.isArray(patch)) return null;
  const c = { added: 0, removed: 0 };
  for (const h of patch as { lines?: unknown }[]) {
    if (!h || !Array.isArray(h.lines)) return null;
    for (const l of h.lines) {
      if (typeof l !== 'string') continue;
      if (l.startsWith('+')) c.added++;
      else if (l.startsWith('-')) c.removed++;
    }
  }
  return c;
}

export interface Counted {
  count: LineCount;
  /** The tool result says it created the file. */
  created?: boolean;
}

/** The count from a tool's structured result (`tool_use_result`), when it carries one. */
export function resultCount(tool: string, result: unknown): Counted | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;
  // Held for review instead of written: nothing changed.
  if (r.staged === true) return { count: { added: 0, removed: 0 } };
  switch (tool) {
    case 'Edit':
    case 'MultiEdit': {
      const c = patchCount(r.structuredPatch);
      return c ? { count: c } : null;
    }
    case 'Write': {
      if (typeof r.content !== 'string') return null;
      if (r.type === 'create') return { count: { added: textLines(r.content).length, removed: 0 }, created: true };
      const c = patchCount(r.structuredPatch);
      if (c && (c.added || c.removed)) return { count: c, created: false };
      // An empty patch: nothing changed, or the diff timed out. The original settles which.
      if (typeof r.originalFile === 'string') return { count: countLines(r.originalFile, r.content), created: false };
      return null;
    }
    case 'NotebookEdit': {
      if (typeof r.error === 'string' && r.error) return { count: { added: 0, removed: 0 } };
      if (typeof r.new_source !== 'string') return null;
      const after = r.edit_mode === 'delete' ? '' : r.new_source;
      return { count: countLines(r.edit_mode === 'insert' ? '' : str(r.old_source), after) };
    }
    default:
      return null;
  }
}

/** The count from the call itself. `before`: the file when the call arrived (null: it didn't exist). */
export function inputCount(tool: string, input: Record<string, unknown>, before?: string | null): LineCount | null {
  switch (tool) {
    case 'Edit': {
      const c = countLines(str(input.old_string), str(input.new_string));
      return input.replace_all === true && typeof before === 'string' ? times(c, occurrences(before, str(input.old_string))) : c;
    }
    case 'MultiEdit': {
      if (!Array.isArray(input.edits)) return null;
      let total = { added: 0, removed: 0 };
      for (const e of input.edits as Record<string, unknown>[]) {
        if (!e || typeof e !== 'object') continue;
        const c = countLines(str(e.old_string), str(e.new_string));
        total = add(total, e.replace_all === true && typeof before === 'string' ? times(c, occurrences(before, str(e.old_string))) : c);
      }
      return total;
    }
    case 'Write': {
      if (typeof input.content !== 'string') return null;
      if (before === null) return { added: textLines(input.content).length, removed: 0 };
      return typeof before === 'string' ? countLines(before, input.content) : null;
    }
    case 'NotebookEdit':
      // Only an inserted cell is knowable from the call alone.
      return input.edit_mode === 'insert' ? { added: textLines(str(input.new_source)).length, removed: 0 } : null;
    default:
      return null;
  }
}

/** The list with one more edit to `path` folded in: totals per file, newest first. */
export function addChange(list: FileChange[], path: string, c: LineCount, created: boolean, at: number, max = MAX_CHANGES): FileChange[] {
  const prev = list.find((f) => f.path === path);
  const next: FileChange = {
    path,
    added: (prev?.added ?? 0) + c.added,
    removed: (prev?.removed ?? 0) + c.removed,
    ...(created || prev?.created ? { created: true } : {}),
    at,
  };
  return [next, ...list.filter((f) => f !== prev)].slice(0, max);
}

/** A file's text, or null when it doesn't exist, isn't a file, or is too large to keep. */
export async function readText(abs: string, max = MAX_BEFORE_BYTES): Promise<string | null> {
  try {
    const s = await stat(abs);
    if (!s.isFile() || s.size > max) return null;
    return await readFile(abs, 'utf8');
  } catch {
    return null;
  }
}

interface Pending {
  tool: string;
  path: string;
  input: Record<string, unknown>;
  created: boolean;
  /** The file when the call arrived: undefined when not needed, null when it didn't exist. */
  before?: Promise<string | null>;
}

/** One builder's changes: edits in flight by tool_use id, and the per-file totals. */
export class ChangeTracker {
  private pending = new Map<string, Pending>();
  changes: FileChange[] = [];

  constructor(
    private readonly root: string,
    private readonly read: (abs: string) => Promise<string | null> = readText,
  ) {}

  /** A file-editing call arrived (before it runs). `created`: the file didn't exist yet. */
  begin(toolUseId: string, tool: string, path: string, input: Record<string, unknown>, created: boolean): void {
    if (!EDIT_TOOLS.has(tool)) return;
    const p: Pending = { tool, path, input, created };
    const replaceAll = input.replace_all === true || (Array.isArray(input.edits) && input.edits.some((e) => (e as { replace_all?: unknown })?.replace_all === true));
    if (created && tool === 'Write') p.before = Promise.resolve(null);
    else if (tool === 'Write' || replaceAll) p.before = this.read(join(this.root, path));
    this.pending.set(toolUseId, p);
  }

  /** The call's result came back. Resolves to the new list when it changed something. */
  async finish(toolUseId: string, isError: boolean, result: unknown, at: number): Promise<FileChange[] | null> {
    const p = this.pending.get(toolUseId);
    if (!p) return null;
    this.pending.delete(toolUseId);
    if (isError) return null;
    let counted = resultCount(p.tool, result);
    if (!counted) {
      const count = inputCount(p.tool, p.input, p.before ? await p.before : undefined);
      if (count) counted = { count };
    }
    if (!counted) return null;
    const created = counted.created ?? p.created;
    if (!counted.count.added && !counted.count.removed && !created) return null;
    this.changes = addChange(this.changes, p.path, counted.count, created, at);
    return this.changes;
  }
}
