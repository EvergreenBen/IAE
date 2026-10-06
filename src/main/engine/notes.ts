// One-line file meanings for files a builder created without noting them, so
// meaning mode never shows "No note yet" for new code. One cheap batched call
// (the sketch model) after the build; builder-written notes are never replaced.

import { readProjectFile } from '../project/files';
import { errorText, leanOptions, log, oneShot } from './sdk';
import type { Workspace } from './workspace';

const MAX_FILES = 12;
const HEAD_CHARS = 1_500;

const SYSTEM = `You write one-line meanings for files in a software project: what each file is for, in plain words, at most 15 words, no markdown. Reply with only a JSON object mapping each path to its line.`;

/** Reads the model's JSON object of path → note, keeping only the paths asked about. */
export function parseNotes(raw: string, paths: string[]): { path: string; note: string }[] {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return [];
  let obj: unknown;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!obj || typeof obj !== 'object') return [];
  const wanted = new Set(paths);
  return Object.entries(obj as Record<string, unknown>)
    .filter((e): e is [string, string] => wanted.has(e[0]) && typeof e[1] === 'string' && !!e[1].trim())
    .map(([path, note]) => ({ path, note: note.trim() }));
}

export async function noteNewFiles(ws: Workspace, paths: string[], model: string): Promise<number> {
  const todo = paths.filter((p) => ws.hasFile(p) && !ws.notes[p]).slice(0, MAX_FILES);
  if (!todo.length || ws.isClosed) return 0;
  const parts: string[] = [];
  const asked: string[] = [];
  for (const path of todo) {
    const f = await readProjectFile(ws.root, path).catch(() => null);
    if (!f || f.unreadable) continue;
    asked.push(path);
    parts.push(`<file path="${path}">\n${f.content.slice(0, HEAD_CHARS)}${f.content.length > HEAD_CHARS ? '\n…' : ''}\n</file>`);
  }
  if (!asked.length) return 0;
  try {
    const raw = await oneShot(
      `${parts.join('\n\n')}\n\nPaths: ${asked.join(', ')}`,
      { ...leanOptions(ws.root), model, thinking: { type: 'disabled' }, tools: [], permissionMode: 'dontAsk', systemPrompt: SYSTEM, persistSession: false, maxTurns: 1 },
      30_000,
    );
    return ws.addNotes(parseNotes(raw, asked), false);
  } catch (e) {
    log('notes', 'failed', errorText(e));
    return 0;
  }
}
