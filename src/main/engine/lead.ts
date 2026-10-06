// The lead: one warm Agent SDK session per open project, fed by a streaming
// input queue. One turn is in flight at a time; later turns queue and coalesce.
// Text deltas become lead/delta, the reply becomes lead/done.

import { query, type McpSdkServerConfigWithInstance, type Query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { nanoid } from 'nanoid';
import type { EngineEvent } from '../../shared/events';
import type { Settings } from '../../shared/model';
import { buildContext, wrapTurn, type TurnKind } from './context';
import { leadSystemPrompt } from './prompts';
import { baseOptions, errorText, InputQueue, log, looksLikeAuthError } from './sdk';
import { cleanReply, SpeechFilter } from './speech';
import { LEAD_TOOL_NAMES } from './tools';
import type { LeadEvent, Workspace } from './workspace';

export interface LeadDeps {
  ws: Workspace;
  emit: (e: EngineEvent) => void;
  settings: () => Settings;
  /** A fresh in-process MCP server: an instance binds to one session's transport. */
  makeTools: () => McpSdkServerConfigWithInstance;
  crewLines: () => string[];
  agentName: (id: string) => string;
  onClaudeStatus: (ok: boolean, detail?: string) => void;
}

interface PendingTurn {
  kind: TurnKind;
  body: string;
  retries: number;
}

interface Turn extends PendingTurn {
  id: string;
  raw: string;
  filter: SpeechFilter;
  replying: boolean;
  streamed: Set<string>;
  textBlocks: number;
  /** A tool call happened; later text is muted if the opening already said enough. */
  afterTools: boolean;
  muted: boolean;
  interrupted: boolean;
  heard: boolean;
  /** Events this turn delivered (restored if the turn has to be retried). */
  events: LeadEvent[];
  watchdog: ReturnType<typeof setTimeout> | null;
}

interface Session {
  q: Query;
  input: InputQueue;
  usedResume: boolean;
  gotInit: boolean;
  closing: boolean;
}

const FIRST_MESSAGE_TIMEOUT = 60_000;
const TURN_TIMEOUT = 240_000;
const INTERRUPT_GRACE = 4_000;
/** An opening shorter than this ("Let me look.") may be followed by text after tools. */
const MIN_OPENING_WORDS = 6;

export class Lead {
  private session: Session | null = null;
  private queue: PendingTurn[] = [];
  private turn: Turn | null = null;
  private sentMapVersion = 0;
  private stale = false;
  private closed = false;
  /** When the last reply finished, and roughly when its speech will end. */
  lastDoneAt = 0;
  speechEndsAt = 0;

  constructor(private readonly d: LeadDeps) {}

  /** Spawns the session ahead of the first turn, so the first reply is fast. */
  warm(): void {
    if (!this.session && !this.closed) this.session = this.createSession();
  }

  get busy(): boolean {
    return !!this.turn || this.queue.length > 0;
  }

  get turnKind(): TurnKind | null {
    return this.turn?.kind ?? null;
  }

  send(kind: TurnKind, body: string): void {
    if (this.closed) return;
    const queuedUser = this.queue.find((t) => t.kind === 'user');
    if (kind === 'user') {
      // Anything else waiting rides along as context; user words go first.
      for (const t of this.queue) if (t.kind === 'events' && t.body) this.d.ws.pushEvent(t.body);
      if (queuedUser) queuedUser.body += `\n${body}`;
      this.queue = [queuedUser ?? { kind, body, retries: 0 }];
      // Don't make the person wait behind an unprompted turn that hasn't spoken yet.
      if (this.turn && this.turn.kind !== 'user' && !this.turn.replying) void this.interrupt();
    } else if (kind === 'events') {
      if (this.queue.length) {
        if (body) this.d.ws.pushEvent(body);
        this.queue = this.queue.filter((t) => t.kind !== 'pulse');
        if (!this.queue.length) this.queue.push({ kind, body: '', retries: 0 });
      } else this.queue.push({ kind, body, retries: 0 });
    } else if (!this.turn && !this.queue.length) {
      this.queue.push({ kind, body, retries: 0 });
    }
    this.pump();
  }

  async interrupt(): Promise<void> {
    const turn = this.turn;
    const session = this.session;
    if (!turn || !session || turn.interrupted) return;
    turn.interrupted = true;
    // If the session doesn't come back promptly, finish the turn ourselves.
    setTimeout(() => {
      if (this.turn !== turn) return;
      log('lead', 'interrupt grace expired; restarting session');
      this.finishTurn(turn);
      this.dropSession(session);
      this.pump();
    }, INTERRUPT_GRACE);
    try {
      await session.q.interrupt();
    } catch (e) {
      log('lead', 'interrupt failed', errorText(e));
    }
  }

  /** Settings changed (model, effort, name): use a fresh session from the next turn. */
  refresh(): void {
    this.stale = true;
    if (!this.turn && this.session) this.dropSession(this.session);
  }

  close(): void {
    this.closed = true;
    this.queue = [];
    if (this.turn?.watchdog) clearTimeout(this.turn.watchdog);
    this.turn = null;
    if (this.session) this.dropSession(this.session);
  }

  // ── sessions ───────────────────────────────────────────────────────────────

  private createSession(): Session {
    const s = this.d.settings();
    const ws = this.d.ws;
    const resume = ws.state.leadSessionId;
    const input = new InputQueue();
    const q = query({
      prompt: input,
      options: {
        ...baseOptions(ws.root),
        model: s.leadModel,
        effort: s.leadEffort,
        systemPrompt: leadSystemPrompt(s.leadName, s.maxBuilders),
        tools: ['Read', 'Glob', 'Grep'],
        mcpServers: { iae: this.d.makeTools() },
        allowedTools: [...LEAD_TOOL_NAMES.map((n) => `mcp__iae__${n}`), 'Read', 'Glob', 'Grep'],
        permissionMode: 'dontAsk',
        strictMcpConfig: true,
        settingSources: [],
        includePartialMessages: true,
        persistSession: true,
        ...(resume ? { resume } : {}),
      },
    });
    const session: Session = { q, input, usedResume: !!resume, gotInit: false, closing: false };
    // A fresh session hasn't seen the map yet (a resumed one saw an old one).
    this.sentMapVersion = 0;
    this.stale = false;
    void this.consume(session);
    log('lead', `session started (${s.leadModel}, effort ${s.leadEffort}${resume ? ', resumed' : ''})`);
    return session;
  }

  private dropSession(session: Session): void {
    session.closing = true;
    session.input.close();
    try {
      session.q.close();
    } catch {
      // already gone
    }
    if (this.session === session) this.session = null;
  }

  private async consume(session: Session): Promise<void> {
    let failure: string | null = null;
    try {
      for await (const m of session.q) {
        if (this.session !== session) break;
        this.onMessage(session, m);
      }
    } catch (e) {
      failure = errorText(e);
    }
    if (session.closing) return;
    this.onSessionEnded(session, failure);
  }

  private onSessionEnded(session: Session, failure: string | null): void {
    if (this.session === session) this.session = null;
    if (this.closed) return;
    log('lead', 'session ended', failure ?? '(stream closed)');
    const turn = this.turn;
    if (session.usedResume && !session.gotInit) return this.resumeFailed(session, turn);
    if (failure && looksLikeAuthError(failure)) this.d.onClaudeStatus(false, failure);
    else if (failure) this.d.emit({ type: 'notice', level: 'warn', text: `${this.d.settings().leadName} lost the connection to Claude and is reconnecting.` });
    if (turn) this.finishTurn(turn);
    this.pump();
  }

  /** The stored session couldn't be resumed: forget it, start fresh, retry the turn once. */
  private resumeFailed(session: Session, turn: Turn | null): void {
    log('lead', 'could not resume the previous session; starting a fresh one');
    this.d.ws.saveState({ leadSessionId: undefined });
    this.dropSession(session);
    if (turn && turn.retries < 1) {
      this.clearTurn(turn);
      for (const e of turn.events) this.d.ws.pushEvent(e.text, e.urgent);
      this.queue.unshift({ kind: turn.kind, body: turn.body, retries: turn.retries + 1 });
    } else if (turn) this.finishTurn(turn);
    this.pump();
  }

  // ── turns ──────────────────────────────────────────────────────────────────

  private pump(): void {
    if (this.turn || this.closed || !this.queue.length) return;
    if (this.stale && this.session) this.dropSession(this.session);
    if (!this.session) this.session = this.createSession();
    const next = this.queue.shift()!;
    this.startTurn(this.session, next);
  }

  private startTurn(session: Session, pending: PendingTurn): void {
    const ws = this.d.ws;
    const includeMap = this.sentMapVersion !== ws.mapVersion;
    this.sentMapVersion = ws.mapVersion;
    const context = buildContext({ ws, crew: this.d.crewLines(), agentName: this.d.agentName, includeMap });
    const events = ws.takeEvents();
    const text = wrapTurn(context, events, pending.kind, pending.body);
    const turn: Turn = {
      ...pending,
      id: `turn-${nanoid(8)}`,
      raw: '',
      filter: new SpeechFilter(),
      replying: false,
      streamed: new Set(),
      textBlocks: 0,
      afterTools: false,
      muted: false,
      interrupted: false,
      heard: false,
      events,
      watchdog: null,
    };
    this.turn = turn;
    this.armWatchdog(turn, FIRST_MESSAGE_TIMEOUT);
    // Unprompted turns stay visually quiet until there's something to say.
    if (pending.kind !== 'pulse') this.d.emit({ type: 'lead/state', state: 'thinking' });
    session.input.push(text);
  }

  private armWatchdog(turn: Turn, ms: number): void {
    if (turn.watchdog) clearTimeout(turn.watchdog);
    turn.watchdog = setTimeout(() => {
      if (this.turn !== turn) return;
      log('lead', `turn ${turn.id} timed out; restarting session`);
      const session = this.session;
      this.finishTurn(turn);
      if (session) this.dropSession(session);
      this.pump();
    }, ms);
  }

  private onMessage(session: Session, m: SDKMessage): void {
    const turn = this.turn;
    if (m.type === 'system' && m.subtype === 'init') {
      session.gotInit = true;
      this.d.onClaudeStatus(true);
      if (m.session_id && m.session_id !== this.d.ws.state.leadSessionId) this.d.ws.saveState({ leadSessionId: m.session_id });
      return;
    }
    if (!turn) return;
    if (!turn.heard) {
      turn.heard = true;
      this.armWatchdog(turn, TURN_TIMEOUT);
    }

    if (m.type === 'stream_event') {
      if (m.parent_tool_use_id) return;
      const ev = m.event;
      if (ev.type === 'message_start') turn.streamed.add(ev.message.id);
      else if (ev.type === 'content_block_start') this.blockStart(turn, ev.content_block.type);
      else if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta' && !turn.muted) this.feed(turn, ev.delta.text);
      return;
    }
    if (m.type === 'assistant') {
      if (m.parent_tool_use_id) return;
      if (m.error) log('lead', 'assistant error', m.error);
      if (m.error === 'authentication_failed' || m.error === 'oauth_org_not_allowed') this.d.onClaudeStatus(false, 'Claude Code is not signed in.');
      // Without partial messages for this message (rare), speak whole blocks at once.
      if (!turn.streamed.has(m.message.id)) {
        for (const block of m.message.content as { type: string; text?: string }[]) {
          this.blockStart(turn, block.type);
          if (block.type === 'text' && block.text && !turn.muted) this.feed(turn, block.text);
        }
      }
      return;
    }
    if (m.type === 'result') {
      if (m.subtype !== 'success' && session.usedResume && !session.gotInit) return this.resumeFailed(session, turn);
      if (m.session_id && m.session_id !== this.d.ws.state.leadSessionId) this.d.ws.saveState({ leadSessionId: m.session_id });
      if (m.subtype !== 'success' && !turn.interrupted) log('lead', 'turn ended with', m.subtype, m.errors?.join('; '));
      this.finishTurn(turn);
      this.pump();
    }
  }

  /**
   * One utterance per turn: the opening is spoken; once tools have run, any
   * further text is muted if the opening already said something real.
   */
  private blockStart(turn: Turn, type: string): void {
    if (type === 'tool_use' || type === 'server_tool_use') turn.afterTools = true;
    if (type !== 'text' || turn.muted) return;
    if (turn.afterTools && cleanReply(turn.raw).split(/\s+/).filter(Boolean).length >= MIN_OPENING_WORDS) {
      turn.muted = true;
      return;
    }
    if (turn.textBlocks++ > 0) this.feed(turn, ' ');
  }

  private feed(turn: Turn, chunk: string): void {
    turn.raw += chunk;
    const out = turn.filter.push(chunk);
    if (!out) return;
    if (!turn.replying) {
      turn.replying = true;
      this.d.emit({ type: 'lead/state', state: 'replying' });
    }
    this.d.emit({ type: 'lead/delta', turnId: turn.id, text: out });
  }

  private clearTurn(turn: Turn): void {
    if (turn.watchdog) clearTimeout(turn.watchdog);
    turn.watchdog = null;
    if (this.turn === turn) this.turn = null;
  }

  private finishTurn(turn: Turn): void {
    if (this.turn !== turn) return;
    const tail = turn.filter.end();
    if (tail && !turn.filter.silent) this.d.emit({ type: 'lead/delta', turnId: turn.id, text: tail });
    const text = turn.filter.silent ? '' : cleanReply(turn.raw);
    this.clearTurn(turn);
    this.d.emit({ type: 'lead/done', turnId: turn.id, text });
    this.d.emit({ type: 'lead/state', state: 'idle' });
    this.lastDoneAt = Date.now();
    const words = text ? text.split(/\s+/).length : 0;
    this.speechEndsAt = this.lastDoneAt + Math.max(4000, words * 360);
    // A reply cut off by barge-in is kept only if it said something (with an ellipsis).
    const kept = turn.interrupted ? (words >= 3 ? `${text}…` : '') : text;
    if (kept) this.d.ws.appendTranscript('lead', kept, this.d.ws.view.selectedNodeId);
  }
}
