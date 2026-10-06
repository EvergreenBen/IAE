// Persistence. Per-project state lives in `<project>/.iae/`; app-level state
// (recent projects, settings) lives in Electron's userData directory.
// JSON writes are debounced and atomic (tmp file + rename).

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { emptyMap } from '../../shared/map';
import {
  DEFAULT_SETTINGS,
  type AgendaItem,
  type ArchMap,
  type Decision,
  type ProjectInfo,
  type Settings,
  type TranscriptEntry,
} from '../../shared/model';

export interface ProjectState {
  leadSessionId?: string;
  cartographedAt?: number;
  createdAt: number;
  /** The folder had no code the first time IAE opened it. */
  isNew?: boolean;
  /** One line describing the system (from the cartographer or the lead). */
  summary?: string;
}

export type Notes = Record<string, string>;

export interface LoadedProject {
  map: ArchMap;
  /** false when `.iae/map.json` didn't exist yet (first open). */
  hadMap: boolean;
  agenda: AgendaItem[];
  decisions: Decision[];
  transcript: TranscriptEntry[];
  notes: Notes;
  state: ProjectState;
}

const DEBOUNCE_MS = 400;
const TRANSCRIPT_TAIL = 60;

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, file);
}

/** Debounced JSON files: the latest value for each file wins. */
class DebouncedJson {
  private pending = new Map<string, () => unknown>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();

  schedule(file: string, value: () => unknown): void {
    this.pending.set(file, value);
    if (!this.timer) this.timer = setTimeout(() => void this.flush(), DEBOUNCE_MS);
  }

  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const batch = [...this.pending];
    this.pending.clear();
    this.chain = this.chain.then(async () => {
      for (const [file, value] of batch) {
        try {
          await writeJsonAtomic(file, value());
        } catch (e) {
          console.warn('[iae:store] write failed', file, (e as Error).message);
        }
      }
    });
    return this.chain;
  }
}

export class ProjectStore {
  readonly dir: string;
  private json = new DebouncedJson();
  private appendChain: Promise<void> = Promise.resolve();

  constructor(readonly root: string) {
    this.dir = join(root, '.iae');
  }

  private file(name: string): string {
    return join(this.dir, name);
  }

  async load(): Promise<LoadedProject> {
    await mkdir(this.dir, { recursive: true });
    const gitignore = this.file('.gitignore');
    // Session ids and the raw transcript are personal; the map, agenda and decisions are worth sharing.
    if (!existsSync(gitignore)) await writeFile(gitignore, 'transcript.jsonl\nstate.json\n*.tmp\n').catch(() => {});
    const hadMap = existsSync(this.file('map.json'));
    const map = await readJson<ArchMap>(this.file('map.json'), emptyMap());
    return {
      map: map && map.nodes && map.edges ? map : emptyMap(),
      hadMap,
      agenda: await readJson<AgendaItem[]>(this.file('agenda.json'), []),
      decisions: await readJson<Decision[]>(this.file('decisions.json'), []),
      transcript: await this.readTranscriptTail(TRANSCRIPT_TAIL),
      notes: await readJson<Notes>(this.file('notes.json'), {}),
      state: await readJson<ProjectState>(this.file('state.json'), { createdAt: Date.now() }),
    };
  }

  private async readTranscriptTail(n: number): Promise<TranscriptEntry[]> {
    try {
      const text = await readFile(this.file('transcript.jsonl'), 'utf8');
      const out: TranscriptEntry[] = [];
      for (const line of text.split('\n').slice(-n - 1)) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line) as TranscriptEntry);
        } catch {
          // a torn last line after a crash — skip it
        }
      }
      return out.slice(-n);
    } catch {
      return [];
    }
  }

  saveMap(map: ArchMap): void {
    this.json.schedule(this.file('map.json'), () => map);
  }
  saveAgenda(items: AgendaItem[]): void {
    this.json.schedule(this.file('agenda.json'), () => items);
  }
  saveDecisions(decisions: Decision[]): void {
    this.json.schedule(this.file('decisions.json'), () => decisions);
  }
  saveNotes(notes: Notes): void {
    this.json.schedule(this.file('notes.json'), () => notes);
  }
  saveState(state: ProjectState): void {
    this.json.schedule(this.file('state.json'), () => state);
  }

  appendTranscript(entry: TranscriptEntry): void {
    const line = JSON.stringify(entry) + '\n';
    this.appendChain = this.appendChain.then(() => appendFile(this.file('transcript.jsonl'), line).catch(() => {}));
  }

  async flush(): Promise<void> {
    await this.json.flush();
    await this.appendChain;
  }
}

// ── App-level store ──────────────────────────────────────────────────────────

const MAX_RECENT = 20;

export function mergeSettings(base: Settings, patch: Partial<Settings> | undefined): Settings {
  const p = patch ?? {};
  const merged: Settings = { ...base, ...p, voice: { ...base.voice, ...(p.voice ?? {}) } };
  if (!['ask', 'edits', 'full'].includes(merged.autonomy)) merged.autonomy = base.autonomy;
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(merged.leadEffort)) merged.leadEffort = base.leadEffort;
  const n = Number(merged.maxBuilders);
  merged.maxBuilders = Number.isFinite(n) ? Math.min(8, Math.max(1, Math.round(n))) : base.maxBuilders;
  for (const k of ['leadName', 'leadModel', 'builderModel', 'sketchModel'] as const) {
    if (typeof merged[k] !== 'string' || !merged[k].trim()) merged[k] = base[k];
  }
  return merged;
}

export class AppStore {
  private json = new DebouncedJson();
  private recentCache: ProjectInfo[] | null = null;

  constructor(private readonly userDataDir: string) {}

  private file(name: string): string {
    return join(this.userDataDir, name);
  }

  async loadSettings(): Promise<Settings> {
    const saved = await readJson<Partial<Settings>>(this.file('settings.json'), {});
    return mergeSettings(DEFAULT_SETTINGS, saved);
  }

  async saveSettings(settings: Settings): Promise<void> {
    await mkdir(this.userDataDir, { recursive: true });
    this.json.schedule(this.file('settings.json'), () => settings);
  }

  async recent(): Promise<ProjectInfo[]> {
    if (!this.recentCache) this.recentCache = await readJson<ProjectInfo[]>(this.file('recent.json'), []);
    return this.recentCache.filter((p) => existsSync(p.root));
  }

  async touchRecent(info: ProjectInfo): Promise<void> {
    const list = (await this.recent()).filter((p) => p.root !== info.root);
    list.unshift(info);
    this.recentCache = list.slice(0, MAX_RECENT);
    await mkdir(this.userDataDir, { recursive: true });
    this.json.schedule(this.file('recent.json'), () => this.recentCache);
  }

  flush(): Promise<void> {
    return this.json.flush();
  }
}

// ── New projects ─────────────────────────────────────────────────────────────

export function defaultProjectsDir(homeDir: string): string {
  return join(homeDir, 'IAE Projects');
}

function cleanName(name: string): string {
  const cleaned = name
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/^\.+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned || 'Untitled';
}

async function isEmptyDir(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir);
    return entries.filter((e) => e !== '.DS_Store').length === 0;
  } catch {
    return true;
  }
}

/** Creates `<parent>/<Name>` (or `<Name 2>` if taken), and runs `git init` quietly. */
export async function createProjectFolder(name: string, parentDir: string): Promise<string> {
  const base = cleanName(name);
  await mkdir(parentDir, { recursive: true });
  let dir = join(parentDir, base);
  for (let i = 2; existsSync(dir) && !(await isEmptyDir(dir)); i++) dir = join(parentDir, `${base} ${i}`);
  await mkdir(dir, { recursive: true });
  await new Promise<void>((resolve) => {
    execFile('git', ['init', '-q'], { cwd: dir, timeout: 5000 }, () => resolve());
  });
  return dir;
}

export function projectName(root: string): string {
  return basename(root) || root;
}
