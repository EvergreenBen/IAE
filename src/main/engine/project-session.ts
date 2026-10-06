// Everything alive while a project is open: the workspace, the lead, the crew,
// the sketcher, the pulse and (on first open) the cartographer.

import { stat } from 'node:fs/promises';
import type { Presence, SayMeta } from '../../shared/bridge';
import type { EngineEvent } from '../../shared/events';
import type { AgendaItem, AgentInfo, MapOp, ProjectSnapshot, Settings, SlashCommandInfo, ViewContext } from '../../shared/model';
import { readProjectFile, resolveInside } from '../project/files';
import { ATLAS_ID, Cartographer } from './cartographer';
import { Crew, NAME_POOL } from './crew';
import { Lead } from './lead';
import { explainFileText, firstSentence, listProjectCommands } from './passthrough';
import { Pulse } from './pulse';
import { errorText, log } from './sdk';
import { Sketcher } from './sketcher';
import { createLeadTools, type LeadToolHost } from './tools';
import { Workspace } from './workspace';

const TAPPED = 'tapped an answer on the card';

export interface SessionDeps {
  emit: (e: EngineEvent) => void;
  settings: () => Settings;
  onClaudeStatus: (ok: boolean, detail?: string) => void;
}

export class ProjectSession {
  readonly lead: Lead;
  readonly crew: Crew;
  readonly sketcher: Sketcher;
  readonly pulse: Pulse;
  private cartographer: Cartographer | null = null;
  private explained = new Map<string, { mtime: number; text: string }>();
  /** When a question was last answered (a tap or resolve_question). */
  private lastAnswerAt = 0;
  private commands: Promise<SlashCommandInfo[]> | null = null;

  private constructor(
    readonly ws: Workspace,
    private readonly d: SessionDeps,
  ) {
    const emit = d.emit;
    this.crew = new Crew({ ws, emit, settings: d.settings, onLeadEvent: () => this.pulse.poke() });
    const host: LeadToolHost = {
      ws,
      emit,
      answer: (id, answer) => this.resolve(id, answer),
      delegate: (input) => {
        const a = this.crew.spawn({ kind: input.kind, title: input.title, brief: input.brief, nodeId: input.nodeId });
        return { id: a.id, name: a.name, queued: this.crew.isQueued(a.id) };
      },
      messageAgent: (id, message) => this.crew.message(id, message),
      stopAgent: (id) => this.stopAgent(id, 'lead'),
      hasSpoken: () => this.lead.hasSpoken,
      answeredThisTurn: () => {
        const t = this.lead.currentTurn;
        return !!t && (t.body.includes(TAPPED) || this.lastAnswerAt >= t.startedAt);
      },
      leadName: () => d.settings().leadName,
    };
    this.lead = new Lead({
      ws,
      emit,
      settings: d.settings,
      makeTools: () => createLeadTools(host),
      crewLines: () => this.crewLines(),
      agentName: (id) => (id === ATLAS_ID ? 'Atlas' : this.crew.nameOf(id)),
      slots: () => this.crew.slotsNote(),
      onClaudeStatus: d.onClaudeStatus,
      onTurnEnd: (kind) => this.pulse.turnEnded(kind),
    });
    this.sketcher = new Sketcher({ root: ws.root, emit, settings: d.settings, map: () => ws.map, projectName: () => ws.info.name });
    this.pulse = new Pulse({ ws, lead: this.lead, working: () => this.crew.visible().map((a) => ({ id: a.id, name: a.name })) });
  }

  static async open(root: string, d: SessionDeps): Promise<ProjectSession> {
    return new ProjectSession(await Workspace.open(root, d.emit, NAME_POOL), d);
  }

  snapshot(): ProjectSnapshot {
    return this.ws.snapshot(this.agents());
  }

  agents(): AgentInfo[] {
    const list = this.crew.visible();
    if (this.cartographer?.running) list.unshift(this.cartographer.info);
    return list;
  }

  /** Called once the renderer has the snapshot: start everything and greet. */
  start(): void {
    const ws = this.ws;
    void ws.watch();
    this.lead.warm();
    this.sketcher.warm();
    this.pulse.start();
    const empty = Object.keys(ws.map.nodes).length === 0;
    if (!ws.state.cartographedAt && !ws.state.isNew && ws.files.length > 0) this.startCartographer();
    if (this.cartographer) this.lead.send('events', 'project opened for the first time. Atlas (the cartographer) is reading the code now; the map is a rough first draft from folder names and will sharpen.');
    else if (empty) this.lead.send('events', 'project opened: new, empty. Invite the idea in one warm sentence.');
    else this.lead.send('events', 'project reopened. In one or two sentences, pick up where you left off: what is built or in flight, and the one decision that matters next.');
  }

  private startCartographer(): void {
    const c = new Cartographer({
      ws: this.ws,
      emit: this.d.emit,
      settings: this.d.settings,
      onDone: (ok, summary) => {
        if (ok) this.ws.pushEvent(`Atlas finished mapping the codebase: ${summary || 'the map now reflects the code.'}`, true);
        else this.ws.pushEvent(`Atlas couldn't finish mapping (${summary || 'unknown error'}); the map is still the rough draft.`, false);
        this.pulse.poke();
      },
    });
    this.cartographer = c;
    this.d.emit({ type: 'agent/upsert', agent: c.info });
    try {
      c.start();
    } catch (e) {
      log('atlas', 'failed to start', errorText(e));
    }
  }

  private crewLines(): string[] {
    const lines = this.crew.statusLines();
    const atlas = this.cartographer?.info;
    if (atlas && this.cartographer?.running) lines.unshift(`Atlas [atlas] (cartographer, ${atlas.status}) — mapping the codebase${atlas.activity ? ` · ${atlas.activity}` : ''}`);
    return lines;
  }

  // ── conversation ───────────────────────────────────────────────────────────

  private userActive(): void {
    this.ws.noteUserActivity();
    this.pulse.userActive();
  }

  say(text: string, meta?: SayMeta): void {
    const clean = text.trim();
    if (!clean) return;
    this.userActive();
    this.ws.appendTranscript('user', clean, this.ws.view.selectedNodeId);
    // The renderer's guess that this answers the card on screen is only a hint:
    // the lead decides (resolve_question), so "show me the backend" said while a
    // Postgres-vs-Redis card is up doesn't become a decision. Taps answer directly.
    const card = meta?.agendaId ? this.ws.agenda.get(meta.agendaId) : undefined;
    const hint = card?.status === 'open' ? `(said while the card [${card.id}] "${card.prompt}" was on screen; if it answers it, resolve_question) ` : '';
    this.lead.send('user', `${hint}${clean}`);
  }

  draft(draftId: string, text: string): void {
    this.userActive();
    this.sketcher.draft(draftId, text);
  }

  /** Closes a question; the builders that asked get the answer. */
  private resolve(id: string, answer: string): { item: AgendaItem; told: string[] } | null {
    const item = this.ws.agenda.answer(id, answer.trim());
    if (item) this.lastAnswerAt = Date.now();
    return item ? { item, told: this.crew.answered(item) } : null;
  }

  /** The person tapped an option on a question card. */
  answer(id: string, answer: string): void {
    const r = this.resolve(id, answer);
    if (!r) return;
    const { item, told } = r;
    this.userActive();
    this.ws.appendTranscript('user', answer, item.nodeId);
    const relayed = told.length ? `; ${told.join(' and ')} already got the answer` : '';
    this.lead.send('user', `(${TAPPED} [${item.id}] "${item.prompt}" — it's closed${relayed}; record the choice with decide, by "person", and act on it) ${answer}`);
  }

  dismiss(id: string): void {
    const item = this.ws.agenda.dismiss(id);
    if (item) this.ws.pushEvent(`the person dismissed the question [${id}] "${item.prompt}"`);
  }

  setView(view: ViewContext): void {
    this.ws.view = {
      scopeId: typeof view?.scopeId === 'string' ? view.scopeId : null,
      selectedNodeId: typeof view?.selectedNodeId === 'string' ? view.selectedNodeId : null,
      openFile: typeof view?.openFile === 'string' ? view.openFile : null,
    };
  }

  setPresence(presence: Presence): void {
    this.ws.presence = presence === 'speaking' || presence === 'typing' ? presence : 'idle';
    if (presence !== 'idle') this.ws.noteUserActivity();
  }

  applyUserOps(ops: MapOp[]): void {
    if (!Array.isArray(ops) || !ops.length) return;
    this.ws.applyMapOps(ops, 'user');
    this.ws.pushEvent(`the person edited the map: ${describeUserOps(ops)}`);
  }

  // ── agents & commands ──────────────────────────────────────────────────────

  async stopAgent(id: string, by: 'person' | 'lead' = 'person'): Promise<string> {
    if (id === ATLAS_ID && this.cartographer?.running) {
      await this.cartographer.stop();
      return 'Stopped Atlas.';
    }
    return this.crew.stop(id, by);
  }

  runCommand(command: string): void {
    const cmd = command.trim();
    if (!cmd) return;
    const text = cmd.startsWith('/') ? cmd : `/${cmd}`;
    const a = this.crew.spawn({ kind: 'command', title: text, brief: text, nodeId: this.ws.view.selectedNodeId });
    this.ws.pushEvent(`the person ran ${text}; ${a.name} [${a.id}] is on it`);
  }

  listCommands(): Promise<SlashCommandInfo[]> {
    this.commands ??= listProjectCommands(this.ws.root).catch((e) => {
      log('commands', 'listing failed', errorText(e));
      this.commands = null;
      return [];
    });
    return this.commands;
  }

  async explainFile(path: string): Promise<string> {
    const abs = await resolveInside(this.ws.root, path);
    const mtime = (await stat(abs)).mtimeMs;
    const cached = this.explained.get(path);
    if (cached && cached.mtime === mtime) return cached.text;
    const file = await readProjectFile(this.ws.root, path);
    if (file.unreadable) return `${path.split('/').pop()} is binary or too large to read here.`;
    const owner = this.ws.files.find((f) => f.path === file.path)?.nodeId;
    try {
      const text = await explainFileText({
        root: this.ws.root,
        model: this.d.settings().sketchModel,
        path: file.path,
        content: file.content,
        ownerLabel: owner ? this.ws.map.nodes[owner]?.label : undefined,
      });
      if (!text) return this.ws.notes[file.path] ?? '';
      this.explained.set(path, { mtime, text });
      if (!this.ws.notes[file.path]) this.ws.addNotes([{ path: file.path, note: firstSentence(text) }], false);
      return text;
    } catch (e) {
      log('explain', 'failed', errorText(e));
      return this.ws.notes[file.path] ?? '';
    }
  }

  settingsChanged(prev: Settings, next: Settings): void {
    if (prev.leadModel !== next.leadModel || prev.leadEffort !== next.leadEffort || prev.leadName !== next.leadName || prev.maxBuilders !== next.maxBuilders) {
      const renamed = prev.leadName !== next.leadName && next.leadName.trim();
      this.lead.refresh(renamed ? `your name is now ${next.leadName} (it was ${prev.leadName}); use the new name from now on.` : undefined);
    }
    if (next.maxBuilders > prev.maxBuilders) this.crew.kick();
  }

  async close(): Promise<void> {
    this.pulse.stop();
    this.sketcher.close();
    this.lead.close();
    await this.cartographer?.stop();
    await this.crew.closeAll();
    await this.ws.close();
  }
}

function describeUserOps(ops: MapOp[]): string {
  const bits = ops.slice(0, 6).map((o) => {
    switch (o.op) {
      case 'upsertNode':
        return `updated ${o.node.label ?? o.node.id} [${o.node.id}]`;
      case 'removeNode':
        return `removed [${o.id}]`;
      case 'moveNode':
        return `moved [${o.id}] under ${o.parentId ?? 'the top level'}`;
      case 'upsertEdge':
        return `connected ${o.edge.from} → ${o.edge.to}`;
      case 'removeEdge':
        return `removed the connection ${o.id}`;
    }
  });
  return bits.join(', ') + (ops.length > 6 ? `, and ${ops.length - 6} more` : '');
}
