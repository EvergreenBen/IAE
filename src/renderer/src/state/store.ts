// The renderer's single store. Engine events are folded in by applyEvent();
// UI-only state (camera scope, voice, lens) lives alongside.
//
// Conventions:
//  - Components select narrowly: useIae((s) => s.map), never the whole state.
//  - Only this file mutates engine-derived state. UI modules own their own
//    slices via the small setters at the bottom.

import { create } from 'zustand';
import type { EngineEvent, LeadEngineState } from '@shared/events';
import { applyOps, assignFiles, emptyMap } from '@shared/map';
import {
  DEFAULT_SETTINGS,
  type AgendaItem,
  type AgentInfo,
  type AgentStep,
  type ArchMap,
  type ClaudeStatus,
  type Decision,
  type FileEntry,
  type GhostProposal,
  type PermissionRequest,
  type ProjectInfo,
  type Settings,
  type TranscriptEntry,
} from '@shared/model';

export type { PermissionRequest };

export interface FileTouch {
  path: string;
  agentId: string;
  action: 'read' | 'edit' | 'create' | 'delete';
  at: number;
}

export interface Notice {
  id: number;
  level: 'info' | 'warn' | 'error';
  text: string;
  at: number;
}

/** Renderer-side voice state, written by src/renderer/src/voice. */
export type MicState = 'off' | 'idle' | 'hearing' | 'transcribing' | 'loading' | 'error';

export interface VoiceState {
  mic: MicState;
  /** Lead's speech is audible right now. */
  speaking: boolean;
  /** 0..1 input level while hearing (for the avatar's listening animation). */
  level: number;
  /** Live transcript of what the user is saying (or typing) right now. */
  interim: string;
  /** Speech-to-text model download/load progress 0..1, when loading. */
  loadProgress?: number;
  error?: string;
}

export interface CameraRequest {
  nodeId: string | null;
  mode: 'show' | 'enter';
  seq: number;
  /** Who asked: the lead ("look at this") defers to a user who is steering; a user's request also selects the node. */
  source?: 'lead' | 'user';
}

export interface IaeState {
  /** 'boot': deciding where to start (a project still open, or the one open at last quit). */
  screen: 'boot' | 'home' | 'project';
  claude: ClaudeStatus;
  claudeDetail?: string;
  settings: Settings;

  project: ProjectInfo | null;
  map: ArchMap;
  files: FileEntry[];
  agenda: AgendaItem[];
  agents: Record<string, AgentInfo>;
  agentSteps: Record<string, AgentStep[]>;
  decisions: Decision[];
  transcript: TranscriptEntry[];

  lead: {
    state: LeadEngineState;
    turnId: string | null;
    /** Text of the reply in progress (or the last one, until the next starts). */
    text: string;
    /** Last completed reply. */
    lastText: string;
    lastAt: number;
    /** The turn in flight has said something (an opener before its tools counts). */
    spoke: boolean;
  };

  voice: VoiceState;

  /** Ghost proposals: lexicon (renderer-local) + sketch (engine). Keyed by proposal key. */
  ghosts: Record<string, GhostProposal>;
  ghostDraftId: string | null;

  permissions: PermissionRequest[];
  touches: FileTouch[];
  notices: Notice[];
  /** Arxitect's own main-process files changed since it started: a restart loads them. */
  stale: string[];

  // ── view (owned by the map / lens)
  scopeId: string | null;
  selectedNodeId: string | null;
  openFile: string | null;
  /** Files show their meaning instead of their name. */
  meaning: boolean;
  camera: CameraRequest | null;
  paletteOpen: boolean;
  transcriptOpen: boolean;
}

/** Lexicon ghosts live beside sketch ghosts with the same proposal key. */
const lexKey = (key: string) => `lex:${key}`;

const MAX_STEPS = 80;
const MAX_TOUCHES = 60;
let noticeSeq = 0;
let cameraSeq = 0;

export const initialState = (): IaeState => ({
  screen: 'boot',
  claude: 'unknown',
  settings: DEFAULT_SETTINGS,
  project: null,
  map: emptyMap(),
  files: [],
  agenda: [],
  agents: {},
  agentSteps: {},
  decisions: [],
  transcript: [],
  lead: { state: 'idle', turnId: null, text: '', lastText: '', lastAt: 0, spoke: false },
  voice: { mic: 'off', speaking: false, level: 0, interim: '' },
  ghosts: {},
  ghostDraftId: null,
  permissions: [],
  touches: [],
  notices: [],
  stale: [],
  scopeId: null,
  selectedNodeId: null,
  openFile: null,
  meaning: false,
  camera: null,
  paletteOpen: false,
  transcriptOpen: false,
});

export const useIae = create<IaeState>(() => initialState());

/** Fold one engine event into the store. Pure with respect to its inputs. */
export function reduce(s: IaeState, e: EngineEvent): Partial<IaeState> {
  switch (e.type) {
    case 'project/opened': {
      const { snapshot } = e;
      const agents: Record<string, AgentInfo> = {};
      for (const a of snapshot.agents) agents[a.id] = a;
      return {
        screen: 'project',
        project: snapshot.project,
        map: snapshot.map,
        files: snapshot.files,
        agenda: snapshot.agenda,
        agents,
        agentSteps: snapshot.agentSteps ?? {},
        decisions: snapshot.decisions,
        transcript: snapshot.transcript,
        ghosts: {},
        permissions: snapshot.permissions ?? [],
        touches: [],
        scopeId: null,
        selectedNodeId: null,
        openFile: null,
        lead: { state: 'idle', turnId: null, text: '', lastText: '', lastAt: 0, spoke: false },
      };
    }
    case 'project/closed':
      return { ...initialState(), claude: s.claude, settings: s.settings, stale: s.stale, screen: 'home' };

    case 'map/ops': {
      const map = applyOps(s.map, e.ops);
      // Ownership can change when nodes gain/lose paths or move in the tree (depth decides ties) — reassign.
      const pathsTouched = e.ops.some(
        (o) =>
          o.op === 'removeNode' ||
          o.op === 'moveNode' ||
          (o.op === 'upsertNode' && (!!o.node.paths || (o.node.parentId !== undefined && !!s.map.nodes[o.node.id] && s.map.nodes[o.node.id].parentId !== o.node.parentId))),
      );
      const files = pathsTouched ? assignFiles(map, s.files) : s.files;
      // Ghosts that just became real stop being ghosts.
      const ghosts = { ...s.ghosts };
      for (const o of e.ops)
        if (o.op === 'upsertNode') {
          delete ghosts[o.node.id];
          delete ghosts[lexKey(o.node.id)];
        }
      const scopeId = s.scopeId && !map.nodes[s.scopeId] ? null : s.scopeId;
      const selectedNodeId = s.selectedNodeId && !map.nodes[s.selectedNodeId] ? null : s.selectedNodeId;
      return { map, files, ghosts, scopeId, selectedNodeId };
    }
    case 'map/replace': {
      const scopeId = s.scopeId && !e.map.nodes[s.scopeId] ? null : s.scopeId;
      return { map: e.map, files: assignFiles(e.map, s.files), scopeId };
    }

    case 'files/replace':
      return { files: e.files };
    case 'files/touched': {
      const touches = [...s.touches, { path: e.path, agentId: e.agentId, action: e.action, at: Date.now() }];
      return { touches: touches.slice(-MAX_TOUCHES) };
    }

    case 'agent/upsert':
      return { agents: { ...s.agents, [e.agent.id]: e.agent } };
    case 'agent/remove': {
      const agents = { ...s.agents };
      delete agents[e.agentId];
      return { agents };
    }
    case 'agent/step': {
      const prev = s.agentSteps[e.agentId] ?? [];
      return { agentSteps: { ...s.agentSteps, [e.agentId]: [...prev, e.step].slice(-MAX_STEPS) } };
    }

    case 'lead/state':
      // A new turn (from idle) hasn't said anything yet.
      return { lead: { ...s.lead, state: e.state, spoke: s.lead.state === 'idle' ? false : s.lead.spoke } };
    case 'lead/delta': {
      const fresh = s.lead.turnId !== e.turnId;
      return { lead: { ...s.lead, state: 'replying', turnId: e.turnId, text: (fresh ? '' : s.lead.text) + e.text, spoke: s.lead.spoke || /\S/.test(e.text) } };
    }
    case 'lead/done':
      return {
        lead: {
          ...s.lead,
          turnId: e.turnId,
          text: e.text,
          lastText: e.text || s.lead.lastText,
          lastAt: e.text ? Date.now() : s.lead.lastAt,
        },
      };

    case 'agenda/upsert': {
      const i = s.agenda.findIndex((a) => a.id === e.item.id);
      const agenda = i === -1 ? [...s.agenda, e.item] : s.agenda.map((a) => (a.id === e.item.id ? e.item : a));
      return { agenda };
    }
    case 'agenda/remove':
      return { agenda: s.agenda.filter((a) => a.id !== e.id) };
    case 'decision/add':
      return { decisions: [...s.decisions, e.decision] };

    case 'focus':
      return { camera: { nodeId: e.nodeId, mode: e.mode, seq: ++cameraSeq, source: 'lead' } };

    case 'ghost/proposals':
      return foldSketch(s, e.draftId, e.proposals);

    case 'permission/request':
      return {
        permissions: [...s.permissions.filter((p) => p.id !== e.id), { id: e.id, agentId: e.agentId, tool: e.tool, summary: e.summary, nodeId: e.nodeId, ...(e.detail ? { detail: e.detail } : {}) }],
      };
    case 'permission/resolved':
      return { permissions: s.permissions.filter((p) => p.id !== e.id) };

    case 'transcript/append':
      return { transcript: [...s.transcript, e.entry].slice(-400) };
    case 'settings/changed':
      return { settings: e.settings };
    case 'claude/status':
      return { claude: e.status, claudeDetail: e.detail };
    case 'notice':
      return { notices: [...s.notices, { id: ++noticeSeq, level: e.level, text: e.text, at: Date.now() }].slice(-5) };
    case 'app/stale':
      return { stale: e.files };
  }
}

/**
 * Sketch proposals for one utterance accumulate: each answer from the sketcher
 * covers the sentence so far, and an idea it leaves out the next time hasn't
 * been unsaid (union by key, the newest proposal for a key wins). A new
 * utterance starts a fresh set. Lexicon ghosts stay under their own keys, so
 * neither source hides the other (the map dedupes).
 */
export function foldSketch(s: Pick<IaeState, 'ghosts' | 'ghostDraftId' | 'map'>, draftId: string, proposals: GhostProposal[]): Pick<IaeState, 'ghosts' | 'ghostDraftId'> {
  const same = draftId === s.ghostDraftId;
  const ghosts: Record<string, GhostProposal> = {};
  for (const [k, g] of Object.entries(s.ghosts)) if (g.source === 'lexicon' || same) ghosts[k] = g;
  for (const p of proposals) if (!s.map.nodes[p.key]) ghosts[p.key] = p;
  return { ghosts, ghostDraftId: draftId };
}

export function applyEvent(e: EngineEvent): void {
  useIae.setState((s) => reduce(s, e));
}

// ── UI setters ──────────────────────────────────────────────────────────────

export const ui = {
  setScope(scopeId: string | null) {
    useIae.setState({ scopeId, selectedNodeId: null });
  },
  select(selectedNodeId: string | null) {
    useIae.setState({ selectedNodeId });
  },
  openFile(openFile: string | null) {
    // The lens takes over from the transcript (one sheet at a time, so Esc always closes what you see).
    useIae.setState(openFile ? { openFile, transcriptOpen: false } : { openFile });
  },
  toggleMeaning() {
    useIae.setState((s) => ({ meaning: !s.meaning }));
  },
  setPalette(paletteOpen: boolean) {
    useIae.setState({ paletteOpen });
  },
  setTranscript(transcriptOpen: boolean) {
    useIae.setState({ transcriptOpen });
  },
  focus(nodeId: string | null, mode: 'show' | 'enter' = 'show') {
    useIae.setState({ camera: { nodeId, mode, seq: ++cameraSeq, source: 'user' } });
  },
  voice(patch: Partial<VoiceState>) {
    useIae.setState((s) => ({ voice: { ...s.voice, ...patch } }));
  },
  setLexiconGhosts(ghosts: GhostProposal[]) {
    useIae.setState((s) => {
      const next: Record<string, GhostProposal> = {};
      for (const [k, g] of Object.entries(s.ghosts)) if (g.source !== 'lexicon') next[k] = g;
      for (const g of ghosts) if (!s.map.nodes[g.key]) next[lexKey(g.key)] = g;
      return { ghosts: next };
    });
  },
  clearGhosts() {
    useIae.setState({ ghosts: {}, ghostDraftId: null });
  },
  dismissNotice(id: number) {
    useIae.setState((s) => ({ notices: s.notices.filter((n) => n.id !== id) }));
  },
};
