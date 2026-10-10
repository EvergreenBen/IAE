// The engine: implements IaeApi for the renderer. Electron specifics (dialogs,
// paths, the shell) come in through EngineHost, so the engine also runs in
// plain Node (scripts/smoke-engine.mjs).

import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { HomeInfo, IaeApi, Presence, SayMeta } from '../../shared/bridge';
import type { EngineEvent } from '../../shared/events';
import {
  DEFAULT_SETTINGS,
  type ClaudeStatus,
  type FileContent,
  type FileDiff,
  type MapOp,
  type ProjectSnapshot,
  type Settings,
  type SlashCommandInfo,
  type ViewContext,
} from '../../shared/model';
import { readProjectFile, resolveInside, writeProjectFile } from '../project/files';
import { diffFile } from '../project/git';
import { AppStore, createProjectFolder, defaultProjectsDir, mergeSettings } from '../project/store';
import { checkClaude } from './passthrough';
import { ProjectSession } from './project-session';
import { errorText, log } from './sdk';

export interface EngineHost {
  /** Native folder picker; null when cancelled. */
  pickFolder(): Promise<string | null>;
  /** Where app-level state (recent projects, settings) lives. */
  userDataDir(): string;
  homeDir(): string;
  /** Show a file in Finder / the platform file manager. */
  revealFile(absPath: string): void;
  /** Quit and launch again (after the engine has shut down). Absent where there's nothing to relaunch. */
  restart?(): void;
}

export class Engine implements IaeApi {
  private readonly app: AppStore;
  private settings: Settings = DEFAULT_SETTINGS;
  private ready: Promise<void>;
  private claude: { status: ClaudeStatus; detail?: string } = { status: 'unknown' };
  private project: ProjectSession | null = null;
  private switching: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly emit: (e: EngineEvent) => void,
    private readonly host: EngineHost,
  ) {
    this.app = new AppStore(host.userDataDir());
    this.ready = this.app.loadSettings().then((s) => {
      this.settings = s;
    });
  }

  async boot(): Promise<void> {
    await this.ready;
    this.emit({ type: 'settings/changed', settings: this.settings });
    await this.checkStatus();
  }

  /** Lightweight auth/spawn check: no tokens are spent. */
  async checkStatus(): Promise<void> {
    this.setClaude('connecting');
    const r = await checkClaude(this.host.homeDir());
    if (r.ok) this.setClaude('ready');
    else if (this.claude.status !== 'ready') this.setClaude('unavailable', r.detail);
  }

  private setClaude(status: ClaudeStatus, detail?: string): void {
    if (this.claude.status === status && this.claude.detail === detail) return;
    this.claude = { status, detail };
    this.emit({ type: 'claude/status', status, ...(detail ? { detail } : {}) });
    log('engine', `claude ${status}${detail ? `: ${detail}` : ''}`);
  }

  private onClaudeStatus = (ok: boolean, detail?: string): void => {
    if (ok) this.setClaude('ready');
    else this.setClaude('unavailable', detail);
  };

  async shutdown(): Promise<void> {
    await this.closeCurrent();
    await this.app.flush();
  }

  // ── home & projects ────────────────────────────────────────────────────────

  async getHome(): Promise<HomeInfo> {
    await this.ready;
    return {
      recent: await this.app.recent(),
      defaultParent: defaultProjectsDir(this.host.homeDir()),
      claude: this.claude.status,
      ...(this.claude.detail ? { claudeDetail: this.claude.detail } : {}),
    };
  }

  pickFolder(): Promise<string | null> {
    return this.host.pickFolder();
  }

  openProject(root: string): Promise<ProjectSnapshot> {
    const next = this.switching.then(() => this.doOpen(root));
    this.switching = next.catch(() => {});
    return next;
  }

  private async doOpen(rootIn: string): Promise<ProjectSnapshot> {
    await this.ready;
    if (typeof rootIn !== 'string' || !rootIn.trim()) throw new Error('Choose a folder to open.');
    const s = await stat(resolve(rootIn)).catch(() => null);
    if (!s?.isDirectory()) throw new Error(`"${rootIn}" isn't a folder.`);
    // Canonical path: Claude Code reports real paths (macOS /var → /private/var), and
    // file ownership on the map depends on matching them.
    const root = await realpath(resolve(rootIn)).catch(() => resolve(rootIn));
    const hadProject = !!this.project;
    await this.closeCurrent();
    let session: ProjectSession;
    try {
      session = await ProjectSession.open(root, {
        emit: this.emit,
        settings: () => this.settings,
        onClaudeStatus: this.onClaudeStatus,
      });
    } catch (e) {
      // The previous project is already closed: don't leave the window on it.
      if (hadProject) this.emit({ type: 'project/closed' });
      this.emit({ type: 'notice', level: 'error', text: `Couldn't open ${root}: ${errorText(e)}` });
      throw e;
    }
    this.project = session;
    const snapshot = session.snapshot();
    this.emit({ type: 'project/opened', snapshot });
    await this.app.touchRecent({ ...snapshot.project, lastOpenedAt: Date.now() });
    await this.app.setLastOpen(root);
    session.start();
    return snapshot;
  }

  async createProject(name: string, parentDir?: string): Promise<ProjectSnapshot> {
    const parent = parentDir?.trim() ? resolve(parentDir) : defaultProjectsDir(this.host.homeDir());
    const dir = await createProjectFolder(typeof name === 'string' ? name : '', parent);
    return this.openProject(dir);
  }

  /** The person closed the project: the next launch starts at Home. Serialized with openProject, so a close can't land in the middle of an open. */
  closeProject(): Promise<void> {
    return this.close(true);
  }

  /** The window went away: stop working, but reopen this project next time. */
  suspend(): Promise<void> {
    return this.close(false);
  }

  private close(forget: boolean): Promise<void> {
    const next = this.switching.then(async () => {
      if (forget) await this.app.setLastOpen(null);
      if (!this.project) return;
      await this.closeCurrent();
      this.emit({ type: 'project/closed' });
    });
    this.switching = next.catch(() => {});
    return next;
  }

  /**
   * A window loaded. If a project is still open (the window reloaded), it gets
   * that project again, builders and all; otherwise the one that was open when
   * the app last quit reopens, and its unfinished builders resume.
   */
  resume(): Promise<ProjectSnapshot | null> {
    const next = this.switching.then(async (): Promise<ProjectSnapshot | null> => {
      await this.ready;
      if (this.project) {
        const snapshot = this.project.snapshot();
        this.emit({ type: 'project/opened', snapshot });
        return snapshot;
      }
      const root = await this.app.lastOpen();
      if (!root) return null;
      try {
        return await this.doOpen(root);
      } catch {
        await this.app.setLastOpen(null);
        return null;
      }
    });
    this.switching = next.catch(() => {});
    return next;
  }

  /** Shut down cleanly (builders save where they are), then relaunch: new code loads, the project reopens, builders resume. */
  async restartApp(): Promise<void> {
    if (!this.host.restart) throw new Error("This copy of Arxitect can't restart itself.");
    log('engine', 'restarting to load new code');
    await this.shutdown();
    this.host.restart();
  }

  private async closeCurrent(): Promise<void> {
    const p = this.project;
    if (!p) return;
    this.project = null;
    if (p.ws.state.summary) await this.app.touchRecent({ ...p.ws.info, lastOpenedAt: Date.now() });
    await p.close().catch((e) => log('engine', 'close failed', errorText(e)));
  }

  private need(): ProjectSession {
    if (!this.project) throw new Error('No project is open.');
    return this.project;
  }

  // ── conversation ───────────────────────────────────────────────────────────

  async say(text: string, meta?: SayMeta): Promise<void> {
    if (typeof text === 'string') this.project?.say(text, meta);
  }

  async draft(draftId: string, text: string): Promise<void> {
    if (typeof text === 'string') this.project?.draft(String(draftId), text);
  }

  async interrupt(): Promise<void> {
    await this.project?.lead.interrupt();
  }

  async answer(agendaId: string, answer: string): Promise<void> {
    if (typeof answer === 'string' && answer.trim()) this.project?.answer(agendaId, answer.trim());
  }

  async dismiss(agendaId: string): Promise<void> {
    this.project?.dismiss(agendaId);
  }

  async setView(view: ViewContext): Promise<void> {
    this.project?.setView(view);
  }

  async setPresence(presence: Presence): Promise<void> {
    this.project?.setPresence(presence);
  }

  // ── map ────────────────────────────────────────────────────────────────────

  async applyOps(ops: MapOp[]): Promise<void> {
    this.project?.applyUserOps(ops);
  }

  // ── files ──────────────────────────────────────────────────────────────────

  async readFile(path: string): Promise<FileContent> {
    return readProjectFile(this.need().ws.root, path);
  }

  async writeFile(path: string, content: string): Promise<void> {
    const p = this.need();
    const rel = await writeProjectFile(p.ws.root, path, content);
    p.ws.pushEvent(`the person edited ${rel} by hand`);
    void p.ws.rescan();
  }

  explainFile(path: string): Promise<string> {
    return this.need().explainFile(path);
  }

  diffFile(path: string): Promise<FileDiff | null> {
    return diffFile(this.need().ws.root, path);
  }

  async revealFile(path: string): Promise<void> {
    this.host.revealFile(await resolveInside(this.need().ws.root, path));
  }

  // ── agents ─────────────────────────────────────────────────────────────────

  async stopAgent(agentId: string): Promise<void> {
    await this.project?.stopAgent(agentId);
  }

  async clearAgent(agentId: string): Promise<void> {
    if (typeof agentId === 'string') this.project?.crew.clear(agentId);
  }

  async resolvePermission(id: string, decision: 'allow' | 'deny' | 'always'): Promise<void> {
    this.project?.crew.resolvePermission(id, decision);
  }

  // ── Claude Code passthrough ────────────────────────────────────────────────

  async listCommands(): Promise<SlashCommandInfo[]> {
    return this.project ? this.project.listCommands() : [];
  }

  async runCommand(command: string): Promise<void> {
    if (typeof command === 'string') this.project?.runCommand(command);
  }

  // ── settings ───────────────────────────────────────────────────────────────

  async getSettings(): Promise<Settings> {
    await this.ready;
    return this.settings;
  }

  async setSettings(patch: Partial<Settings>): Promise<Settings> {
    await this.ready;
    const prev = this.settings;
    this.settings = mergeSettings(prev, patch);
    await this.app.saveSettings(this.settings);
    this.emit({ type: 'settings/changed', settings: this.settings });
    this.project?.settingsChanged(prev, this.settings);
    return this.settings;
  }
}
