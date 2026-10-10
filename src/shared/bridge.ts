// The renderer ⇄ main API. The preload script exposes an implementation on
// `window.iae`; in the browser-only dev mode a mock implements the same shape.
//
// Adding a method: add it to IaeApi, to BRIDGE_METHODS, and implement it on the
// Engine (src/main/engine/engine.ts) and the mock (src/renderer/src/bridge/mock.ts).

import type { EngineEvent } from './events';
import type {
  ClaudeStatus,
  FileContent,
  FileDiff,
  MapOp,
  ProjectInfo,
  ProjectSnapshot,
  Settings,
  SlashCommandInfo,
  ViewContext,
} from './model';

export interface HomeInfo {
  recent: ProjectInfo[];
  /** Where new projects are created by default (e.g. ~/Arxitect Projects). */
  defaultParent: string;
  claude: ClaudeStatus;
  claudeDetail?: string;
}

export type Presence = 'speaking' | 'typing' | 'idle';

export interface SayMeta {
  via: 'voice' | 'text';
  /** Set when the utterance answers an agenda item. */
  agendaId?: string;
}

/** Everything the renderer may ask the main process to do. All calls are async. */
export interface IaeApi {
  // ── home & projects
  getHome(): Promise<HomeInfo>;
  pickFolder(): Promise<string | null>;
  openProject(root: string): Promise<ProjectSnapshot>;
  createProject(name: string, parentDir?: string): Promise<ProjectSnapshot>;
  closeProject(): Promise<void>;
  /**
   * What to show when the window loads: the project already open (the window
   * reloaded), else the one that was open when the app last quit. Either way
   * `project/opened` follows. null → Home.
   */
  resume(): Promise<ProjectSnapshot | null>;
  /** Quit and start again, loading new code; unfinished builders pick up where they left off. */
  restartApp(): Promise<void>;

  // ── conversation
  /** A finished user utterance (spoken or typed). */
  say(text: string, meta?: SayMeta): Promise<void>;
  /** Interim text while the user is still talking/typing. Drives architecture autocomplete. */
  draft(draftId: string, text: string): Promise<void>;
  /** Barge-in: the user started talking over the lead. */
  interrupt(): Promise<void>;
  answer(agendaId: string, answer: string): Promise<void>;
  dismiss(agendaId: string): Promise<void>;
  /** What the user is looking at. Cheap; call on every scope/selection change. */
  setView(view: ViewContext): Promise<void>;
  /**
   * Whether the user is mid-utterance. The engine never starts the lead talking
   * over a user who is speaking or typing. Call on every transition.
   */
  setPresence(presence: Presence): Promise<void>;

  // ── map (direct manipulation by the user)
  applyOps(ops: MapOp[]): Promise<void>;

  // ── files
  readFile(path: string): Promise<FileContent>;
  writeFile(path: string, content: string): Promise<void>;
  /** A short plain-language explanation of a file (cached). */
  explainFile(path: string): Promise<string>;
  /** The file's changes since the last commit (an untracked file is all added). null when the project isn't a git repository. */
  diffFile(path: string): Promise<FileDiff | null>;
  revealFile(path: string): Promise<void>;

  // ── agents
  stopAgent(agentId: string): Promise<void>;
  /** Take a finished agent off the crew list (one that changed files stays there for review until cleared). */
  clearAgent(agentId: string): Promise<void>;
  resolvePermission(id: string, decision: 'allow' | 'deny' | 'always'): Promise<void>;

  // ── Claude Code passthrough
  /** Slash commands & skills available in this project (from Claude Code). */
  listCommands(): Promise<SlashCommandInfo[]>;
  /** Run a slash command / skill (e.g. "/review") as a builder session. */
  runCommand(command: string): Promise<void>;

  // ── settings
  getSettings(): Promise<Settings>;
  /** Saves and emits `settings/changed`. Turning `autoApprove` on also approves every permission request already waiting. */
  setSettings(patch: Partial<Settings>): Promise<Settings>;
}

export interface IaeBridge extends IaeApi {
  /** Subscribe to engine events. Returns an unsubscribe function. */
  onEvent(cb: (event: EngineEvent) => void): () => void;
  /** 'electron' in the desktop app, 'mock' in browser dev mode. */
  readonly runtime: 'electron' | 'mock';
}

export const BRIDGE_METHODS = [
  'getHome',
  'pickFolder',
  'openProject',
  'createProject',
  'closeProject',
  'resume',
  'restartApp',
  'say',
  'draft',
  'interrupt',
  'answer',
  'dismiss',
  'setView',
  'setPresence',
  'applyOps',
  'readFile',
  'writeFile',
  'explainFile',
  'diffFile',
  'revealFile',
  'stopAgent',
  'clearAgent',
  'resolvePermission',
  'listCommands',
  'runCommand',
  'getSettings',
  'setSettings',
] as const satisfies readonly (keyof IaeApi)[];

export const IPC_INVOKE = 'iae:invoke';
export const IPC_EVENT = 'iae:event';
