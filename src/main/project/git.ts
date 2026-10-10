// A file's changes since the last commit. Git runs with execFile in the
// project root (never through a shell), and only ever reads. The unified-diff
// parser is pure, so the lens's diff view is tested without a repository.

import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { relative } from 'node:path';
import type { DiffHunk, DiffLine, FileDiff } from '../../shared/model';
import { resolveInside, toPosix } from './files';

/** Lines a diff shows before it stops (the counts keep going). */
export const MAX_DIFF_LINES = 4000;
/** An untracked file larger than this isn't read. */
const MAX_UNTRACKED_BYTES = 1024 * 1024;
const MAX_BUFFER = 16 * 1024 * 1024;
const TIMEOUT_MS = 10_000;

export interface ParsedDiff {
  hunks: DiffHunk[];
  added: number;
  removed: number;
  binary: boolean;
  truncated: boolean;
  /** The patch creates the file ("new file mode"). */
  created: boolean;
  /** The patch deletes the file ("deleted file mode"). */
  deleted: boolean;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/**
 * Parses `git diff` output for one file. A hunk ends when its line counts are
 * used up, so a removed line that starts with "--" is never taken for a header.
 */
export function parseUnifiedDiff(text: string, maxLines = MAX_DIFF_LINES): ParsedDiff {
  const out: ParsedDiff = { hunks: [], added: 0, removed: 0, binary: false, truncated: false, created: false, deleted: false };
  let hunk: DiffHunk | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  let oldNo = 0;
  let newNo = 0;
  let shown = 0;
  const push = (line: DiffLine) => {
    if (!hunk) return;
    if (shown >= maxLines) {
      out.truncated = true;
      return;
    }
    hunk.lines.push(line);
    shown++;
  };

  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      const c = line[0];
      if (c === '+') {
        out.added++;
        newLeft--;
        push({ kind: 'add', text: line.slice(1), newNo: newNo++ });
        continue;
      }
      if (c === '-') {
        out.removed++;
        oldLeft--;
        push({ kind: 'del', text: line.slice(1), oldNo: oldNo++ });
        continue;
      }
      if (c === ' ' || line === '') {
        oldLeft--;
        newLeft--;
        push({ kind: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
        continue;
      }
      if (c === '\\') continue; // "\ No newline at end of file"
      // Anything else ends a malformed hunk; read it as a header.
      oldLeft = newLeft = 0;
    }
    const m = HUNK.exec(line);
    if (m) {
      oldNo = Number(m[1]);
      newNo = Number(m[3]);
      oldLeft = m[2] === undefined ? 1 : Number(m[2]);
      newLeft = m[4] === undefined ? 1 : Number(m[4]);
      const section = m[5].trim();
      hunk = { oldStart: oldNo, oldLines: oldLeft, newStart: newNo, newLines: newLeft, ...(section ? { section } : {}), lines: [] };
      if (shown < maxLines) out.hunks.push(hunk);
      else out.truncated = true;
      continue;
    }
    if (line.startsWith('Binary files ') || line === 'GIT binary patch') out.binary = true;
    else if (line.startsWith('new file mode')) out.created = true;
    else if (line.startsWith('deleted file mode')) out.deleted = true;
  }
  return out;
}

/** A file git doesn't know yet: every line is added. */
export function allAdded(path: string, content: string, maxLines = MAX_DIFF_LINES): FileDiff {
  const lines = content.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  const shown = lines.slice(0, maxLines).map((text, i): DiffLine => ({ kind: 'add', text, newNo: i + 1 }));
  return {
    path,
    status: 'added',
    added: lines.length,
    removed: 0,
    hunks: lines.length ? [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: shown }] : [],
    ...(lines.length > maxLines ? { truncated: true } : {}),
  };
}

/** A parsed patch as the bridge returns it. */
export function toFileDiff(path: string, p: ParsedDiff): FileDiff {
  const status = p.created ? 'added' : p.deleted ? 'deleted' : p.hunks.length || p.binary || p.added || p.removed ? 'modified' : 'unchanged';
  return {
    path,
    status,
    added: p.added,
    removed: p.removed,
    hunks: p.hunks,
    ...(p.binary ? { binary: true } : {}),
    ...(p.truncated ? { truncated: true } : {}),
  };
}

// ── running git ──────────────────────────────────────────────────────────────

interface GitResult {
  ok: boolean;
  stdout: string;
  /** The output outgrew the buffer. */
  overflow?: boolean;
}

// Reads only: no optional index refresh (so it never holds the lock a builder's
// git needs), pathspecs taken literally, never a prompt, English messages.
const GIT_ENV = { GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };

function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-c', 'core.fsmonitor=false', '-c', 'core.quotepath=off', ...args],
      { cwd, env: { ...process.env, ...GIT_ENV }, maxBuffer: MAX_BUFFER, timeout: TIMEOUT_MS, windowsHide: true },
      (err, stdout) => {
        if (!err) return resolve({ ok: true, stdout });
        const code = (err as NodeJS.ErrnoException).code;
        resolve({ ok: false, stdout: String(stdout ?? ''), ...(code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? { overflow: true } : {}) });
      },
    );
  });
}

/**
 * `path`'s changes against HEAD: `git diff --no-color -U3 HEAD -- <path>`,
 * parsed. A file git doesn't track (or a repository with no commits yet) is
 * all added. Not a git repository, or no git at all → null.
 */
export async function diffFile(root: string, rel: string): Promise<FileDiff | null> {
  const abs = await resolveInside(root, rel);
  const path = toPosix(relative(root, abs));
  const st = await stat(abs).catch(() => null);
  if (st?.isDirectory()) throw new Error(`"${path}" is a folder.`);
  const repo = await git(root, ['rev-parse', '--is-inside-work-tree']);
  if (!repo.ok || repo.stdout.trim() !== 'true') return null;

  const head = (await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'])).ok;
  if (head) {
    const d = await git(root, ['diff', '--no-color', '--no-ext-diff', '-U3', 'HEAD', '--', path]);
    if (d.overflow) return { path, status: 'modified', added: 0, removed: 0, hunks: [], truncated: true };
    if (d.ok && d.stdout.trim()) return toFileDiff(path, parseUnifiedDiff(d.stdout));
    // Nothing against HEAD: unchanged, unless git doesn't track it.
    const tracked = await git(root, ['ls-files', '--', path]);
    if (!tracked.ok || tracked.stdout.trim()) return { path, status: 'unchanged', added: 0, removed: 0, hunks: [] };
  }
  if (!st?.isFile()) return { path, status: 'unchanged', added: 0, removed: 0, hunks: [] };
  if (st.size > MAX_UNTRACKED_BYTES) return { path, status: 'added', added: 0, removed: 0, hunks: [], truncated: true };
  const buf = await readFile(abs);
  if (buf.subarray(0, 8000).includes(0)) return { path, status: 'added', added: 0, removed: 0, hunks: [], binary: true };
  return allAdded(path, buf.toString('utf8'));
}
