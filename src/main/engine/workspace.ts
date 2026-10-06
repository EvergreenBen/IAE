// The open project: map, files, notes, agenda, transcript and the event digest
// for the lead. Every subsystem (lead, crew, cartographer…) changes project
// state through here so persistence and events stay consistent.

import { nanoid } from 'nanoid';
import type { Presence } from '../../shared/bridge';
import type { EngineEvent } from '../../shared/events';
import { applyOps, assignFiles } from '../../shared/map';
import type {
  AgentInfo,
  ArchMap,
  FileEntry,
  MapOp,
  NodeStatus,
  OpSource,
  ProjectInfo,
  ProjectSnapshot,
  TranscriptEntry,
  ViewContext,
} from '../../shared/model';
import { FileWatcher, hasNoCode, scanFiles, type ScannedFile } from '../project/files';
import { buildHeuristicMap } from '../project/heuristic';
import { ProjectStore, projectName, type Notes, type ProjectState } from '../project/store';
import { Agenda } from './agenda';
import { log } from './sdk';

export interface LeadEvent {
  text: string;
  /** Worth interrupting the quiet for (a build finished, a builder is blocked). */
  urgent: boolean;
  at: number;
}

const MAX_EVENTS = 30;

export class Workspace {
  readonly store: ProjectStore;
  readonly agenda: Agenda;
  info: ProjectInfo;
  map: ArchMap;
  notes: Notes;
  state: ProjectState;
  transcript: TranscriptEntry[];
  /** True when this open drew a fresh map (no `.iae/map.json` before). */
  readonly firstOpen: boolean;

  view: ViewContext = { scopeId: null, selectedNodeId: null, openFile: null };
  presence: Presence = 'idle';
  lastUserActivityAt = Date.now();
  /** Bumped on every map change; the lead re-sends the map when it moved. */
  mapVersion = 1;

  private scanned: ScannedFile[];
  private filesCache: FileEntry[] | null = null;
  private filesSignature = '';
  private events: LeadEvent[] = [];
  private watcher: FileWatcher | null = null;
  private closed = false;
  private rescanning: Promise<void> | null = null;
  private rescanAgain = false;

  private constructor(
    readonly root: string,
    private readonly emit: (e: EngineEvent) => void,
    init: {
      store: ProjectStore;
      map: ArchMap;
      firstOpen: boolean;
      notes: Notes;
      state: ProjectState;
      transcript: TranscriptEntry[];
      agenda: Agenda;
      scanned: ScannedFile[];
    },
  ) {
    this.store = init.store;
    this.map = init.map;
    this.firstOpen = init.firstOpen;
    this.notes = init.notes;
    this.state = init.state;
    this.transcript = init.transcript;
    this.agenda = init.agenda;
    this.scanned = init.scanned;
    this.filesSignature = signature(init.scanned);
    this.info = {
      root,
      name: projectName(root),
      isNew: !!init.state.isNew,
      lastOpenedAt: Date.now(),
      summary: init.state.summary,
    };
  }

  static async open(root: string, emit: (e: EngineEvent) => void): Promise<Workspace> {
    const t = Date.now();
    const store = new ProjectStore(root);
    const loaded = await store.load();
    const scanned = await scanFiles(root);
    const state = loaded.state;
    if (state.isNew === undefined) state.isNew = hasNoCode(scanned);
    let map = loaded.map;
    const firstOpen = !loaded.hadMap;
    if (firstOpen && scanned.length && !state.isNew) map = buildHeuristicMap(root, scanned.map((f) => f.path));
    const agenda = new Agenda(loaded.agenda, loaded.decisions, {
      upsert: (item) => emit({ type: 'agenda/upsert', item }),
      remove: (id) => emit({ type: 'agenda/remove', id }),
      decision: (decision) => emit({ type: 'decision/add', decision }),
      persist: (items, decisions) => {
        store.saveAgenda(items);
        store.saveDecisions(decisions);
      },
    });
    const ws = new Workspace(root, emit, { store, map, firstOpen, notes: loaded.notes, state, transcript: loaded.transcript, agenda, scanned });
    store.saveState(state);
    if (firstOpen) store.saveMap(map);
    log('project', `opened ${root} (${scanned.length} files, ${Object.keys(map.nodes).length} nodes) in ${Date.now() - t}ms`);
    return ws;
  }

  /** Starts watching the folder; changes become `files/replace`. */
  async watch(): Promise<void> {
    this.watcher = new FileWatcher(this.root, () => void this.rescan());
    await this.watcher.start().catch((e) => log('files', 'watch failed', (e as Error).message));
  }

  // ── map ────────────────────────────────────────────────────────────────────

  applyMapOps(ops: MapOp[], source: OpSource): void {
    if (!ops.length || this.closed) return;
    const next = applyOps(this.map, ops);
    if (next === this.map) return;
    this.map = next;
    this.mapVersion++;
    if (ops.some((o) => o.op !== 'upsertEdge' && o.op !== 'removeEdge')) this.filesCache = null;
    this.emit({ type: 'map/ops', ops, source });
    this.store.saveMap(this.map);
  }

  setNodeStatus(nodeId: string | null | undefined, status: NodeStatus, source: OpSource = 'builder'): void {
    if (!nodeId || !this.map.nodes[nodeId] || this.map.nodes[nodeId].status === status) return;
    this.applyMapOps([{ op: 'upsertNode', node: { id: nodeId, status } }], source);
  }

  // ── files ──────────────────────────────────────────────────────────────────

  get files(): FileEntry[] {
    if (!this.filesCache) {
      this.filesCache = assignFiles(this.map, this.scanned.map((f) => ({ ...f, nodeId: null, note: this.notes[f.path] })));
    }
    return this.filesCache;
  }

  hasFile(path: string): boolean {
    return this.scanned.some((f) => f.path === path);
  }

  /** Rescans the folder; emits `files/replace` when anything changed. Coalesces bursts. */
  rescan(): Promise<void> {
    if (this.rescanning) {
      this.rescanAgain = true;
      return this.rescanning;
    }
    this.rescanning = (async () => {
      do {
        this.rescanAgain = false;
        const scanned = await scanFiles(this.root).catch(() => this.scanned);
        if (this.closed) return;
        const sig = signature(scanned);
        if (sig !== this.filesSignature) {
          this.filesSignature = sig;
          this.scanned = scanned;
          this.filesCache = null;
          this.emit({ type: 'files/replace', files: this.files });
        }
      } while (this.rescanAgain && !this.closed);
    })().finally(() => {
      this.rescanning = null;
    });
    return this.rescanning;
  }

  /** Merges one-line file meanings. Existing notes are kept unless `overwrite`. */
  addNotes(entries: { path: string; note: string }[], overwrite = true): number {
    let n = 0;
    for (const { path, note } of entries) {
      const clean = note.replace(/\s+/g, ' ').trim().slice(0, 200);
      if (!path || !clean || (!overwrite && this.notes[path])) continue;
      this.notes[path] = clean;
      n++;
    }
    if (!n) return 0;
    this.filesCache = null;
    this.store.saveNotes(this.notes);
    this.emit({ type: 'files/replace', files: this.files });
    return n;
  }

  // ── lead digest ────────────────────────────────────────────────────────────

  pushEvent(text: string, urgent = false): void {
    this.events.push({ text, urgent, at: Date.now() });
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
  }

  takeEvents(): LeadEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  hasEvents(urgentOnly = false): boolean {
    return urgentOnly ? this.events.some((e) => e.urgent) : this.events.length > 0;
  }

  // ── transcript & state ─────────────────────────────────────────────────────

  appendTranscript(who: TranscriptEntry['who'], text: string, nodeId?: string | null): TranscriptEntry {
    const entry: TranscriptEntry = { id: `t-${nanoid(8)}`, at: Date.now(), who, text, ...(nodeId ? { nodeId } : {}) };
    this.transcript.push(entry);
    if (this.transcript.length > 200) this.transcript.splice(0, this.transcript.length - 200);
    this.store.appendTranscript(entry);
    this.emit({ type: 'transcript/append', entry });
    return entry;
  }

  saveState(patch: Partial<ProjectState>): void {
    this.state = { ...this.state, ...patch };
    if (patch.summary) this.info = { ...this.info, summary: patch.summary };
    this.store.saveState(this.state);
  }

  noteUserActivity(): void {
    this.lastUserActivityAt = Date.now();
  }

  snapshot(agents: AgentInfo[]): ProjectSnapshot {
    return {
      project: this.info,
      map: this.map,
      files: this.files,
      agenda: this.agenda.open(),
      agents,
      decisions: this.agenda.allDecisions(),
      transcript: this.transcript.slice(-60),
    };
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.agenda.shutdown();
    await this.watcher?.close();
    await this.store.flush();
  }
}

function signature(files: ScannedFile[]): string {
  let h = files.length;
  for (const f of files) {
    const s = `${f.path}|${f.size}|${f.mtime}`;
    for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  }
  return `${files.length}:${h}`;
}
