// ─────────────────────────────────────────────────────────────────────────────
// Arxitect domain model. Shared by the main process (engine) and the renderer (map).
// This file is the contract — change it deliberately and update both sides.
// ─────────────────────────────────────────────────────────────────────────────

/** What a node *is*. Drives its glyph and default placement on the map. */
export type NodeKind =
  | 'system' //   a large grouping: "Frontend", "Backend", "Data"
  | 'client' //   a UI surface: web app, mobile app, CLI, admin panel
  | 'service' //  a running backend thing: API, worker, function
  | 'module' //   a code-level component inside a service: "Auth", "Billing"
  | 'data' //     database, object storage, cache, search index
  | 'queue' //    queues, streams, pub/sub, schedulers, cron
  | 'external' // third-party API / SaaS: Stripe, Google OAuth, Twilio
  | 'config' //   configuration, secrets, env, feature flags
  | 'infra' //    hosting, CI/CD, containers, DNS
  | 'ai'; //      model / agent / LLM integration

/**
 * Lifecycle of a node.
 * planned  — agreed in conversation, no code yet (drawn dashed)
 * building — an agent is working on it right now
 * built    — code exists and is owned by this node
 * broken   — a build failed / something needs repair
 */
export type NodeStatus = 'planned' | 'building' | 'built' | 'broken';

export interface ArchNode {
  /** Stable, unique across the whole map. Lowercase kebab: "api", "api-auth". */
  id: string;
  /** null → top level of the project. Nodes nest arbitrarily deep. */
  parentId: string | null;
  /** 1–4 plain-English words naming its role: "Signs people in", "Saves your recipes". */
  label: string;
  /**
   * The name a developer would use: "Auth API", "Postgres", "IPC Bridge".
   * Shown on hover or selection. Optional: older maps don't have it.
   */
  techLabel?: string;
  kind: NodeKind;
  status: NodeStatus;
  /** One sentence in everyday words: what it does and why it exists. */
  summary?: string;
  /** Notable technology. ["Next.js", "Prisma"] */
  tech?: string[];
  /**
   * Code this node owns, project-relative, POSIX separators.
   * Directory prefixes end with "/" ("src/api/"), anything else is a glob
   * ("src/**\/*.auth.ts") or an exact file. A file belongs to the deepest
   * node whose paths match it. See assignFiles() in ./map.ts.
   */
  paths?: string[];
  /** Optional ordering hint among siblings (lower first). */
  order?: number;
  createdAt: number;
  updatedAt: number;
}

export type EdgeKind = 'calls' | 'reads' | 'writes' | 'events' | 'depends' | 'auth';

export interface ArchEdge {
  /** Defaults to `${from}->${to}`. */
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  /** 1–4 words: "REST", "webhooks", "session cookie". */
  label?: string;
}

export interface ArchMap {
  version: 1;
  nodes: Record<string, ArchNode>;
  edges: Record<string, ArchEdge>;
}

/** All structural map changes flow through ops — from Claude, the scanner, or the user. */
export type MapOp =
  | { op: 'upsertNode'; node: Partial<ArchNode> & { id: string } }
  | { op: 'removeNode'; id: string } // removes the subtree and attached edges
  | { op: 'moveNode'; id: string; parentId: string | null }
  | { op: 'upsertEdge'; edge: Partial<ArchEdge> & { from: string; to: string } }
  | { op: 'removeEdge'; id: string };

export type OpSource = 'lead' | 'cartographer' | 'builder' | 'user' | 'scanner';

// ── Files ────────────────────────────────────────────────────────────────────

export interface FileEntry {
  /** project-relative, POSIX */
  path: string;
  size: number;
  mtime: number;
  /** Owning node (deepest match), or null when no node claims it yet. */
  nodeId: string | null;
  /** One-line meaning ("what this file is for"), when known. */
  note?: string;
}

export interface FileContent {
  path: string;
  content: string;
  /** true when the file is binary or too large to show; content is then empty. */
  unreadable?: boolean;
  size: number;
  language: string; // 'typescript' | 'json' | 'env' | 'markdown' | 'python' | 'css' | 'html' | 'text' | …
}

// ── Agents ───────────────────────────────────────────────────────────────────

/**
 * lead         — the one conversational partner (default name "Archie")
 * builder      — a Claude Code session doing real work on a node
 * cartographer — reads an existing codebase and draws the map
 * scout        — read-only investigation ("how does auth work today?")
 */
export type AgentRole = 'lead' | 'builder' | 'cartographer' | 'scout';

export type AgentStatus = 'starting' | 'thinking' | 'working' | 'waiting' | 'done' | 'failed' | 'stopped';

export interface AgentInfo {
  id: string;
  name: string;
  role: AgentRole;
  /** Index into the agent palette (tokens.css --agent-0 … --agent-5). */
  hue: number;
  status: AgentStatus;
  /** Short title of the job: "Build session middleware". */
  task: string;
  /** Where on the map this agent is working. */
  nodeId: string | null;
  /** Live one-liner: "Editing src/auth/session.ts". */
  activity?: string;
  /** File currently being touched (project-relative). */
  file?: string;
  startedAt: number;
  endedAt?: number;
  /** Final summary when done/failed. */
  result?: string;
  /** The builder's own plan and how far through it is: drives the progress bar and the time-left estimate. */
  progress?: AgentProgress;
  /** Files it changed, newest first (at most 100): counted as it edits. */
  changes?: FileChange[];
}

/** What a builder changed in one file, counted from its edits (Edit, MultiEdit, Write, NotebookEdit). */
export interface FileChange {
  /** Project-relative, POSIX. */
  path: string;
  /** Lines added and removed, summed over its edits to the file. */
  added: number;
  removed: number;
  /** The builder created the file. */
  created?: boolean;
  /** Its latest edit to the file (epoch ms). */
  at: number;
}

// ── Diffs ────────────────────────────────────────────────────────────────────

/** One line of a diff: unchanged context, added, or removed. */
export interface DiffLine {
  kind: 'ctx' | 'add' | 'del';
  text: string;
  /** Line number in the committed file (context and removed lines). */
  oldNo?: number;
  /** Line number in the file as it is now (context and added lines). */
  newNo?: number;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** What git names the hunk after: usually the first line of the enclosing function. */
  section?: string;
  lines: DiffLine[];
}

/** A file's changes since the last commit (git HEAD). */
export interface FileDiff {
  path: string;
  /** `added`: new or untracked, every line is added. */
  status: 'modified' | 'added' | 'deleted' | 'unchanged';
  added: number;
  removed: number;
  hunks: DiffHunk[];
  /** Git can't show it as text. */
  binary?: boolean;
  /** Too long to show whole: the hunks stop early (the counts still cover everything git showed). */
  truncated?: boolean;
}

/** A builder's plan, as it reported it (Arxitect's `progress` tool, or Claude Code's todo list). */
export interface AgentProgress {
  /** The steps, in order, in plain words. */
  steps: string[];
  /** How many are finished. */
  done: number;
  /** Working time the finished steps took, ms (orienting counts towards the first). */
  spentMs: number;
  /** When the step in hand began (epoch ms). */
  stepAt: number;
}

export type AgentStepKind = 'read' | 'edit' | 'write' | 'bash' | 'search' | 'think' | 'text' | 'tool' | 'result' | 'error';

export interface AgentStep {
  at: number;
  kind: AgentStepKind;
  text: string;
  path?: string;
}

// ── Conversation ─────────────────────────────────────────────────────────────

/**
 * decision — the human must choose; work may be waiting on it
 * idea     — an opportunity worth considering
 * risk     — something that will bite later
 * clarify  — ambiguity in what the user asked
 */
export type AgendaKind = 'decision' | 'idea' | 'risk' | 'clarify';

export interface AgendaItem {
  id: string;
  kind: AgendaKind;
  /** The question as it would be spoken. ≤ 25 words, specific to this system. */
  prompt: string;
  /** One line: why it matters now. */
  why?: string;
  /** 2–4 one-tap answers. The first is the lead's recommended default. */
  options?: string[];
  /** Map anchor. */
  nodeId?: string | null;
  /** Agent ids waiting on this answer. */
  blocking?: string[];
  /** 0..1 — higher is surfaced first. */
  priority: number;
  status: 'open' | 'answered' | 'dismissed';
  answer?: string;
  createdAt: number;
}

export interface Decision {
  id: string;
  title: string;
  rationale?: string;
  nodeId?: string | null;
  at: number;
}

export interface TranscriptEntry {
  id: string;
  at: number;
  who: 'user' | 'lead' | 'system';
  text: string;
  nodeId?: string | null;
}

/** A tentative node suggested while the user is still talking ("architecture autocomplete"). */
export interface GhostProposal {
  /** Stable within an utterance so ghosts don't flicker: usually the slug of the label. */
  key: string;
  label: string;
  kind: NodeKind;
  /** Existing node it most likely belongs under / connects to. */
  nearNodeId?: string | null;
  connectsTo?: string[];
  confidence: number; // 0..1
  source: 'lexicon' | 'sketch';
}

// ── Project & settings ───────────────────────────────────────────────────────

export interface ProjectInfo {
  root: string;
  name: string;
  /** true when the folder had no code when first opened in Arxitect. */
  isNew: boolean;
  lastOpenedAt: number;
  /** One-line description, once known. */
  summary?: string;
}

export interface ProjectSnapshot {
  project: ProjectInfo;
  map: ArchMap;
  files: FileEntry[];
  agenda: AgendaItem[];
  agents: AgentInfo[];
  /** Each live agent's recent steps (so a reloaded window still shows them). */
  agentSteps: Record<string, AgentStep[]>;
  /** Permission requests still waiting for an answer. */
  permissions: PermissionRequest[];
  decisions: Decision[];
  transcript: TranscriptEntry[];
}

/** A builder waiting for the person's OK to run a tool. */
export interface PermissionRequest {
  id: string;
  agentId: string;
  tool: string;
  summary: string;
  nodeId: string | null;
  /** The untruncated request (the whole command), when the summary is clipped. */
  detail?: string;
}

export type ClaudeStatus = 'unknown' | 'connecting' | 'ready' | 'unavailable';

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * ask   — builders ask before editing or running commands
 * edits — builders edit files freely, ask before shell commands (default)
 * full  — builders run unattended (bypass permissions)
 */
export type Autonomy = 'ask' | 'edits' | 'full';

/** What every session runs on: Claude Code, or OpenAI's Codex for people without a Claude account. */
export type Provider = 'claude' | 'codex';

export interface Settings {
  provider: Provider;
  /** Codex's model for every role. Empty → whatever Codex defaults to. The *Model fields are Claude's. */
  codexModel: string;
  leadName: string;
  leadModel: string;
  leadEffort: EffortLevel;
  builderModel: string;
  sketchModel: string;
  autonomy: Autonomy;
  /** Auto mode: every builder/scout permission request is approved without a prompt. */
  autoApprove: boolean;
  maxBuilders: number;
  voice: {
    /** Lead speaks its replies aloud. */
    speak: boolean;
    /** Mic is open and voice activity detection decides turns (vs. hold Space to talk). */
    handsFree: boolean;
    /** Archie's voice: a Kokoro voice id (af_heart…), 'system' for the best system voice, or a system voice's name. Empty → Kokoro's default. */
    ttsVoice: string;
    rate: number;
    /** transformers.js model id for speech-to-text. */
    sttModel: string;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  provider: 'claude',
  codexModel: '',
  leadName: 'Archie',
  leadModel: 'claude-opus-5-5',
  leadEffort: 'low',
  builderModel: 'claude-opus-5-5',
  sketchModel: 'claude-haiku-4-5',
  autonomy: 'edits',
  autoApprove: false,
  maxBuilders: 3,
  voice: {
    speak: true,
    handsFree: false,
    ttsVoice: '',
    rate: 1.05,
    sttModel: 'onnx-community/whisper-base.en',
  },
};

export interface SlashCommandInfo {
  name: string; // without the leading slash
  description: string;
  argumentHint?: string;
}

/** What the user is looking at — lets the lead resolve "this", "here", "that file". */
export interface ViewContext {
  /** Node whose interior is on screen (null = project top level). */
  scopeId: string | null;
  /** Node the user last clicked / hovered with intent. */
  selectedNodeId: string | null;
  /** File open in the lens, if any. */
  openFile: string | null;
}
