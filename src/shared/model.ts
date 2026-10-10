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
  decisions: Decision[];
  transcript: TranscriptEntry[];
}

export type ClaudeStatus = 'unknown' | 'connecting' | 'ready' | 'unavailable';

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * ask   — builders ask before editing or running commands
 * edits — builders edit files freely, ask before shell commands (default)
 * full  — builders run unattended (bypass permissions)
 */
export type Autonomy = 'ask' | 'edits' | 'full';

export interface Settings {
  leadName: string;
  leadModel: string;
  leadEffort: EffortLevel;
  builderModel: string;
  sketchModel: string;
  autonomy: Autonomy;
  maxBuilders: number;
  voice: {
    /** Lead speaks its replies aloud. */
    speak: boolean;
    /** Mic is open and voice activity detection decides turns (vs. hold Space to talk). */
    handsFree: boolean;
    /** Preferred system voice name (TTS). Empty → best available. */
    ttsVoice: string;
    rate: number;
    /** transformers.js model id for speech-to-text. */
    sttModel: string;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  leadName: 'Archie',
  leadModel: 'claude-opus-5-5',
  leadEffort: 'low',
  builderModel: 'claude-opus-5-5',
  sketchModel: 'claude-haiku-4-5',
  autonomy: 'edits',
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
