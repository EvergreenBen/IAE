// Events streamed from the main process (engine) to the renderer.
// The renderer folds these into its store (src/renderer/src/state/store.ts).

import type {
  AgendaItem,
  AgentInfo,
  AgentStep,
  ArchMap,
  ClaudeStatus,
  Decision,
  FileEntry,
  GhostProposal,
  MapOp,
  OpSource,
  ProjectSnapshot,
  Settings,
  TranscriptEntry,
} from './model';

/**
 * The lead's engine-side state. The renderer combines it with its own voice
 * state (listening / speaking) to decide how the avatar behaves.
 * idle     — nothing in flight
 * thinking — a turn was sent, no text yet
 * replying — text is streaming
 */
export type LeadEngineState = 'idle' | 'thinking' | 'replying';

export type EngineEvent =
  // ── project lifecycle
  | { type: 'project/opened'; snapshot: ProjectSnapshot }
  | { type: 'project/closed' }
  // ── architecture map
  | { type: 'map/ops'; ops: MapOp[]; source: OpSource }
  | { type: 'map/replace'; map: ArchMap; source: OpSource }
  // ── files
  | { type: 'files/replace'; files: FileEntry[] }
  /** An agent touched a file — the map pulses the owning node. */
  | { type: 'files/touched'; path: string; agentId: string; action: 'read' | 'edit' | 'create' | 'delete' }
  // ── agents
  | { type: 'agent/upsert'; agent: AgentInfo }
  | { type: 'agent/remove'; agentId: string }
  | { type: 'agent/step'; agentId: string; step: AgentStep }
  // ── the lead's voice
  | { type: 'lead/state'; state: LeadEngineState }
  /** Streaming text of the lead's current reply. `text` is the delta. */
  | { type: 'lead/delta'; turnId: string; text: string }
  /** The full reply, once complete. Empty text = the lead chose silence. */
  | { type: 'lead/done'; turnId: string; text: string }
  // ── agenda (questions anchored on the map)
  | { type: 'agenda/upsert'; item: AgendaItem }
  | { type: 'agenda/remove'; id: string }
  | { type: 'decision/add'; decision: Decision }
  // ── camera: the lead wants the user to look somewhere
  | { type: 'focus'; nodeId: string | null; mode: 'show' | 'enter' }
  // ── architecture autocomplete from the sketch model (lexicon ghosts are renderer-local)
  | { type: 'ghost/proposals'; draftId: string; proposals: GhostProposal[] }
  // ── builder permission prompts
  | { type: 'permission/request'; id: string; agentId: string; tool: string; summary: string; nodeId: string | null }
  | { type: 'permission/resolved'; id: string }
  // ── misc
  | { type: 'transcript/append'; entry: TranscriptEntry }
  | { type: 'settings/changed'; settings: Settings }
  | { type: 'claude/status'; status: ClaudeStatus; detail?: string }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string };

export type EngineEventType = EngineEvent['type'];
