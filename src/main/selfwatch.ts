// Arxitect building itself: when it runs from source (scripts/dev.mjs), its
// own main-process code can change under it while builders work. Renderer code
// hot-reloads; this code only loads on a restart, so say when one would.

import { statSync, watch, type FSWatcher } from 'node:fs';
import { join, sep } from 'node:path';

/** Paths (relative to the app's source root) that only load when the app restarts. */
const WATCHED = ['src/main', 'src/preload', 'src/shared', 'electron.vite.config.ts', 'package.json'];

/** Whether a changed file needs a restart to take effect: source, not tests or docs (or a folder macOS reports by name). */
export function needsRestart(rel: string): boolean {
  const p = rel.split(sep).join('/');
  if (WATCHED.includes(p)) return p.includes('.');
  if (!/\.(ts|tsx|js|mjs|cjs|json)$/.test(p) || /\.test\.[cm]?[jt]sx?$/.test(p)) return false;
  return WATCHED.some((w) => p.startsWith(`${w}/`));
}

/**
 * Watches the source tree at `root`. `onStale` gets every file changed since
 * `since` (launch, by default; debounced). Returns a function that stops watching.
 */
export function watchOwnSource(root: string, onStale: (files: string[]) => void, since = Date.now() - process.uptime() * 1000): () => void {
  const changed = new Set<string>();
  const watchers: FSWatcher[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const note = (rel: string) => {
    if (!needsRestart(rel)) return;
    // macOS can replay a change from just before the watch began: one this launch already built in.
    const mtime = statSync(join(root, rel), { throwIfNoEntry: false })?.mtimeMs;
    if (mtime !== undefined && mtime < since) return;
    changed.add(rel.split(sep).join('/'));
    clearTimeout(timer);
    timer = setTimeout(() => onStale([...changed].sort()), 400);
  };
  for (const w of WATCHED) {
    const abs = join(root, w);
    try {
      const isDir = !w.includes('.');
      const fsw = watch(abs, { recursive: isDir, persistent: false }, (_event, name) => {
        if (name) note(isDir ? join(w, name.toString()) : w);
      });
      fsw.on('error', () => {});
      watchers.push(fsw);
    } catch {
      // Not there (or not watchable): nothing to report for it.
    }
  }
  return () => {
    clearTimeout(timer);
    for (const w of watchers) w.close();
  };
}
