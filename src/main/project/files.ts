// The project's files: a gitignore-aware scan, a debounced watcher, and
// path-safe read/write for the lens.
//
// The scan is a breadth-first walk (so the cap keeps shallow, architectural
// files rather than one deep folder) that prunes ignored directories before
// descending. `.env*` files are always included, even when gitignored: they're
// the headline "find it on the map" case.

import { watch, type FSWatcher } from 'chokidar';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import type { FileContent } from '../../shared/model';

export interface ScannedFile {
  path: string;
  size: number;
  mtime: number;
}

export const MAX_FILES = 6000;
const MAX_READ_BYTES = 1024 * 1024;

const HARD_IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.iae',
  'dist',
  'build',
  'out',
  '.next',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  '.turbo',
  '.cache',
  '.pytest_cache',
  '.mypy_cache',
  '.parcel-cache',
  '.svelte-kit',
  '.nuxt',
]);
const HARD_IGNORED_FILES = new Set(['.DS_Store', 'Thumbs.db']);

export const isEnvFile = (name: string): boolean => name === '.env' || name.startsWith('.env.');

export const toPosix = (p: string): string => (sep === '/' ? p : p.split(sep).join('/'));

// ── ignore rules ─────────────────────────────────────────────────────────────

interface Rule {
  /** Directory (project-relative, '' = root) the .gitignore lives in. */
  base: string;
  ig: Ignore;
}

async function loadRule(root: string, base: string, file: string): Promise<Rule | null> {
  try {
    const text = await readFile(join(root, base, file), 'utf8');
    return { base, ig: ignore().add(text) };
  } catch {
    return null;
  }
}

function isIgnored(rules: Rule[], rel: string, isDir: boolean): boolean {
  for (const r of rules) {
    let sub: string;
    if (!r.base) sub = rel;
    else if (rel.startsWith(r.base + '/')) sub = rel.slice(r.base.length + 1);
    else continue;
    try {
      if (r.ig.ignores(isDir ? sub + '/' : sub)) return true;
    } catch {
      // `ignore` throws on odd paths; treat as not ignored
    }
  }
  return false;
}

/** Root ignore rules (.gitignore + .git/info/exclude), used by the watcher. */
export async function rootRules(root: string): Promise<Rule[]> {
  const rules = [await loadRule(root, '', '.gitignore'), await loadRule(root, '', '.git/info/exclude')];
  return rules.filter((r): r is Rule => !!r);
}

// ── scan ─────────────────────────────────────────────────────────────────────

export async function scanFiles(root: string, max = MAX_FILES): Promise<ScannedFile[]> {
  const found: string[] = [];
  const queue: { rel: string; rules: Rule[] }[] = [{ rel: '', rules: await rootRules(root) }];

  while (queue.length && found.length < max) {
    const { rel: dirRel, rules: inherited } = queue.shift()!;
    let entries;
    try {
      entries = await readdir(join(root, dirRel), { withFileTypes: true });
    } catch {
      continue;
    }
    let rules = inherited;
    if (dirRel && entries.some((e) => e.name === '.gitignore' && e.isFile())) {
      const nested = await loadRule(root, dirRel, '.gitignore');
      if (nested) rules = [...inherited, nested];
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (HARD_IGNORED_DIRS.has(e.name) || isIgnored(rules, rel, true)) continue;
        queue.push({ rel, rules });
      } else if (e.isFile()) {
        if (HARD_IGNORED_FILES.has(e.name)) continue;
        if (!isEnvFile(e.name) && isIgnored(rules, rel, false)) continue;
        found.push(rel);
        if (found.length >= max) break;
      }
      // Symlinks are skipped: they can point outside the project or loop.
    }
  }

  const out: ScannedFile[] = [];
  const CHUNK = 128;
  for (let i = 0; i < found.length; i += CHUNK) {
    const batch = await Promise.all(
      found.slice(i, i + CHUNK).map(async (path) => {
        try {
          const s = await lstat(join(root, path));
          return { path, size: s.size, mtime: Math.round(s.mtimeMs) };
        } catch {
          return null;
        }
      }),
    );
    for (const f of batch) if (f) out.push(f);
  }
  return out;
}

/** True when the folder has nothing but IAE/git scaffolding. */
export function hasNoCode(files: ScannedFile[]): boolean {
  return files.every((f) => f.path === '.gitignore' || f.path.startsWith('.iae/'));
}

// ── watch ────────────────────────────────────────────────────────────────────

export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly root: string,
    private readonly onChange: () => void,
    private readonly debounceMs = 450,
  ) {}

  async start(): Promise<void> {
    const rules = await rootRules(this.root);
    const root = this.root;
    this.watcher = watch(root, {
      ignoreInitial: true,
      persistent: true,
      ignored: (abs: string, stats?: { isDirectory(): boolean }) => {
        const rel = toPosix(relative(root, abs));
        if (!rel || rel.startsWith('..')) return false;
        const parts = rel.split('/');
        if (parts.some((p) => HARD_IGNORED_DIRS.has(p))) return true;
        const name = parts[parts.length - 1];
        if (HARD_IGNORED_FILES.has(name)) return true;
        if (isEnvFile(name)) return false;
        const isDir = stats ? stats.isDirectory() : false;
        return isIgnored(rules, rel, isDir) || (!stats && isIgnored(rules, rel, true));
      },
    });
    this.watcher.on('all', () => this.bump());
    this.watcher.on('error', (e) => console.warn('[iae:files] watch error', (e as Error).message));
  }

  private bump(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.onChange();
    }, this.debounceMs);
  }

  async close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.watcher?.close().catch(() => {});
    this.watcher = null;
  }
}

// ── read / write ─────────────────────────────────────────────────────────────

const LANGUAGES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  md: 'markdown',
  mdx: 'markdown',
  py: 'python',
  css: 'css',
  scss: 'css',
  less: 'css',
  html: 'html',
  htm: 'html',
  sql: 'sql',
  yml: 'yaml',
  yaml: 'yaml',
};

export function detectLanguage(path: string): string {
  const name = basename(path).toLowerCase();
  if (isEnvFile(name) || name.endsWith('.env')) return 'env';
  return LANGUAGES[extname(name).slice(1)] ?? 'text';
}

function isInside(root: string, abs: string): boolean {
  const r = relative(root, abs);
  return r !== '' && !r.startsWith('..') && !isAbsolute(r);
}

/**
 * Resolves a project-relative path, refusing anything that escapes the project
 * (`..`, absolute paths elsewhere, or symlinks pointing outside).
 */
export async function resolveInside(root: string, rel: string): Promise<string> {
  if (typeof rel !== 'string' || !rel.trim()) throw new Error('A file path is required.');
  const abs = resolve(root, rel);
  if (!isInside(root, abs)) throw new Error(`"${rel}" is outside the project.`);
  // Follow symlinks for the deepest existing ancestor and check again.
  const realRoot = await realpath(root).catch(() => root);
  let probe = abs;
  while (!existsSync(probe) && probe !== root) probe = dirname(probe);
  const realProbe = await realpath(probe).catch(() => probe);
  if (realProbe !== realRoot && !isInside(realRoot, realProbe)) throw new Error(`"${rel}" is outside the project.`);
  return abs;
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export async function readProjectFile(root: string, rel: string): Promise<FileContent> {
  const abs = await resolveInside(root, rel);
  const path = toPosix(relative(root, abs));
  const language = detectLanguage(path);
  const s = await stat(abs);
  if (!s.isFile()) throw new Error(`"${path}" is not a file.`);
  if (s.size > MAX_READ_BYTES) return { path, content: '', unreadable: true, size: s.size, language };
  const buf = await readFile(abs);
  if (looksBinary(buf)) return { path, content: '', unreadable: true, size: s.size, language };
  return { path, content: buf.toString('utf8'), size: s.size, language };
}

export async function writeProjectFile(root: string, rel: string, content: string): Promise<string> {
  if (typeof content !== 'string') throw new Error('File content must be text.');
  const abs = await resolveInside(root, rel);
  const path = toPosix(relative(root, abs));
  if (path === '.git' || path.startsWith('.git/')) throw new Error('IAE does not edit files inside .git.');
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
  return path;
}
