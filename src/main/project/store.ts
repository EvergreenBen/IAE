// Persistence. Per-project state lives in `<project>/.iae/`; app-level state
// (recent projects, settings) lives in Electron's userData directory.
// JSON writes are debounced and atomic (tmp file + rename).

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { emptyMap, projectFolderName } from '../../shared/map';
import {
  DEFAULT_SETTINGS,
  type AgendaItem,
  type AgentProgress,
  type FileChange,
  type AgentStatus,
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
  /** The folder had no code the first time Arxitect opened it. */
  isNew?: boolean;
  /** One line describing the system (from the cartographer or the lead). */
  summary?: string;
  /** When Arxitect last closed it (a quick reopen is a restart, not a return). */
  closedAt?: number;
}

export type Notes = Record<string, string>;

/** A builder or scout job in `.iae/crew.json`, so an unfinished one can resume after a restart. */
export interface SavedJob {
  id: string;
  name: string;
  hue: number;
  kind: 'build' | 'investigate' | 'command';
  title: string;
  nodeId: string | null;
  brief: string;
  status: AgentStatus;
  /** The Claude Code session, once it has started: resumed rather than started over. */
  sessionId?: string;
  /** The permission it was waiting for when the app closed. */
  waitingFor?: string;
  startedAt: number;
  /** Its plan and how far through it was. */
  progress?: AgentProgress;
  /** The files it had changed. */
  changes?: FileChange[];
}

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
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return fallback;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    // Unreadable (a merge conflict, a torn write): keep a copy before Arxitect writes a fresh one over it.
    await writeFile(`${file}.${Date.now()}.bak`, text).catch(() => {});
    console.warn(`[iae:store] ${file} couldn't be parsed; kept a .bak copy and started fresh`);
    return fallback;
  }
}

/** Adds a line to an existing `.iae/.gitignore` (written before that file existed). */
async function ignoreAlso(gitignore: string, name: string): Promise<void> {
  const text = await readFile(gitignore, 'utf8').catch(() => null);
  if (text === null || text.split('\n').some((l) => l.trim() === name)) return;
  await appendFile(gitignore, `${text && !text.endsWith('\n') ? '\n' : ''}${name}\n`).catch(() => {});
}

const isMap = (m: unknown): m is ArchMap =>
  !!m && typeof m === 'object' && typeof (m as ArchMap).nodes === 'object' && typeof (m as ArchMap).edges === 'object';

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
    if (!existsSync(gitignore)) await writeFile(gitignore, 'transcript.jsonl\nstate.json\ncrew.json\n*.tmp\n').catch(() => {});
    else await ignoreAlso(gitignore, 'crew.json');
    const map = existsSync(this.file('map.json')) ? await readJson<ArchMap | null>(this.file('map.json'), null) : null;
    // A map that couldn't be read counts as no map: the project gets redrawn rather than opening blank.
    const hadMap = isMap(map);
    return {
      map: hadMap ? map : emptyMap(),
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
  saveCrew(jobs: SavedJob[]): void {
    this.json.schedule(this.file('crew.json'), () => jobs);
  }

  async loadCrew(): Promise<SavedJob[]> {
    const jobs = await readJson<unknown>(this.file('crew.json'), []);
    return Array.isArray(jobs) ? (jobs as SavedJob[]) : [];
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
  if (typeof merged.autoApprove !== 'boolean') merged.autoApprove = base.autoApprove;
  if (!['claude', 'codex'].includes(merged.provider)) merged.provider = base.provider;
  merged.codexModel = typeof merged.codexModel === 'string' ? merged.codexModel.trim() : base.codexModel;
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

  /** The project that was open when the app last quit (or the window closed), if it's still there. */
  async lastOpen(): Promise<string | null> {
    const saved = await readJson<{ open?: unknown }>(this.file('session.json'), {});
    return typeof saved.open === 'string' && existsSync(saved.open) ? saved.open : null;
  }

  /** null: the person closed it themselves, so the next launch starts at Home. */
  async setLastOpen(root: string | null): Promise<void> {
    await mkdir(this.userDataDir, { recursive: true });
    this.json.schedule(this.file('session.json'), () => ({ open: root }));
  }

  flush(): Promise<void> {
    return this.json.flush();
  }
}

// ── New projects ─────────────────────────────────────────────────────────────

export function defaultProjectsDir(homeDir: string): string {
  return join(homeDir, 'Arxitect Projects');
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
  const base = projectFolderName(name);
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
