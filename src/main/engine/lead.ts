// The lead: one warm Agent SDK session per open project, fed by a streaming
// input queue. One turn is in flight at a time; later turns queue and coalesce.
// Text deltas become lead/delta, the reply becomes lead/done.

import type { McpSdkServerConfigWithInstance, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { query, resumable, type Query } from './agent';
import { nanoid } from 'nanoid';
import type { EngineEvent } from '../../shared/events';
import type { Settings } from '../../shared/model';
import { buildContext, wrapTurn, type MapSeen, type TurnKind } from './context';
import { leadOptions } from './lead-options';
import { errorText, InputQueue, log, looksLikeAuthError } from './sdk';
import { AskedQuestions, withoutDropped, type RepeatGuard } from './repeat';
import { cleanReply, SpeechFilter } from './speech';
import { CameraWalk } from './tools';
import type { LeadEvent, Workspace } from './workspace';

export interface LeadDeps {
  ws: Workspace;
  emit: (e: EngineEvent) => void;
  settings: () => Settings;
  /** A fresh in-process MCP server: an instance binds to one session's transport. */
  makeTools: () => McpSdkServerConfigWithInstance;
  crewLines: () => string[];
  agentName: (id: string) => string;
  /** Set when a new job would have to wait for a builder slot. */
  slots?: () => string | undefined;
  onClaudeStatus: (ok: boolean, detail?: string) => void;
  /** A turn ended (spoken, silent or cut off). */
  onTurnEnd?: (kind: TurnKind, spoke: boolean) => void;
}

interface PendingTurn {
  kind: TurnKind;
  body: string;
  retries: number;
  /**
   * Asks again for the spoken answer to the person's words (`body`): the
   * first reply had no words ("silent"), or looked at the code and never
   * said what it found ("look").
   */
  unheard?: 'silent' | 'look';
}

interface Turn extends PendingTurn {
  id: string;
  startedAt: number;
  raw: string;
  filter: SpeechFilter;
  /** Trims a repeat of an open card's question from later sentences (null: nothing to guard). */
  guard: RepeatGuard | null;
  replying: boolean;
  /** What was last sent to the caption and voice ended in a space (a sentence break). */
  saidBreak: boolean;
  streamed: Set<string>;
  textBlocks: number;
  /** A tool call happened; later text is muted if the opening already said enough. */
  afterTools: boolean;
  /** A quick look at code (Read, Grep, Glob) ran since the last text: the next text is its answer, and is spoken. */
  looking: boolean;
  /** Camera moves held back this turn until the look's answer is said. */
  held: number;
  /** Where those moves were going: played, paced, once the answer starts. */
  deferred: { nodeId: string | null; mode: 'show' | 'enter' }[];
  muted: boolean;
  interrupted: boolean;
  /** Barged in after the opening was said: tools finish, nothing more is spoken. */
  softStopped: boolean;
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
/** An opening shorter than this ("Sure.") may be followed by text after tools. */
const MIN_OPENING_WORDS = 6;
/**
 * Tools that look at the code. What they find is the answer, so the text
 * after them is spoken however long the opening was ("Let me look at the
 * worker." → Grep → the answer).
 */
export const LOOK_TOOLS = new Set(['Read', 'Grep', 'Glob']);
/**
 * Why a camera move waits while a look's answer is owed: left alone, the lead
 * moves the camera through the parts it means to talk about, then stays
 * silent. The move isn't lost: it plays as the answer is spoken.
 */
export const HOLD_FOR_ANSWER =
  "Noted: the camera goes there as you speak. The person has only heard your opening, so give them your answer now, out loud, what you found in plain spoken sentences. No need to call focus again, and don't mention this.";
/** The tools held back while a look's answer is owed: only camera moves (never the work itself). */
const HELD_TOOLS = new Set(['mcp__iae__focus']);
/** At most this many tool calls are held back per turn (then the retry is the net). */
const MAX_HELD = 12;
/** Said for the lead when a reply to the person goes straight to a look without a word. */
export const LOOK_OPENING = 'Let me check the code.';
/** Sent when a reply to the person left them without an answer. */
export const UNHEARD = {
  silent:
    "Your reply to what the person just said had no words in it, so they heard nothing. Answer them now, out loud: your sentence first, then any tools. Don't mention this note. Reply <silence/> only if they asked you to be quiet.",
  look: "You looked at the code but never said what you found, so the person heard only your opening. Tell them now, out loud, as you would have right after the look: plain spoken sentences, no lists or markdown, without repeating the opening. Don't mention this note.",
} as const;
/** The whole map is re-sent at least this often (in turns) when it keeps changing. */
const FULL_MAP_EVERY = 25;

export class Lead {
  private session: Session | null = null;
  private queue: PendingTurn[] = [];
  private turn: Turn | null = null;
  /** The map as this session last saw it (null: it hasn't seen one yet). */
  private seen: MapSeen | null = null;
  private turnsSinceFullMap = 0;
  private sessionTurns = 0;
  /** Failed attempts to resume the stored session; after two, start fresh for this run. */
  private resumeTries = 0;
  /** One-time notes for the next turn's context. */
  private notes: string[] = [];
  /** The questions the lead asked out loud in earlier turns (so it doesn't keep asking them). */
  private asked = new AskedQuestions();
  private stale = false;
  private closed = false;
  /** Camera moves the lead's turns make outside its tools (held for a look's answer). */
  private readonly walk = new CameraWalk(
    (nodeId, mode) => this.d.emit({ type: 'focus', nodeId, mode }),
    (since) => !!this.d.ws.isClosed || this.d.ws.lastUserActivityAt > since,
  );
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

  /** The turn in flight: what prompted it and when it started. */
  get currentTurn(): { kind: TurnKind; body: string; startedAt: number } | null {
    const t = this.turn;
    return t ? { kind: t.kind, body: t.body, startedAt: t.startedAt } : null;
  }

  /** The turn in flight has already said its piece (later text won't be spoken). Not while a look is out: its answer is still to come. */
  get hasSpoken(): boolean {
    const t = this.turn;
    if (!t) return false;
    // Chose silence up front (a pulse with nothing to say): that is its piece.
    if (t.filter.silent) return true;
    return !t.looking && cleanReply(t.raw).split(/\s+/).filter(Boolean).length >= MIN_OPENING_WORDS;
  }

  send(kind: TurnKind, body: string): void {
    if (this.closed) return;
    if (kind === 'user') {
      // New words supersede asking again for the answer to the last ones.
      const queuedUser = this.queue.find((t) => t.kind === 'user' && !t.unheard);
      // Anything else waiting rides along as context; user words go first.
      for (const t of this.queue) if (t.kind === 'events' && t.body) this.d.ws.pushEvent(t.body);
      if (queuedUser) queuedUser.body += `\n${body}`;
      this.queue = [queuedUser ?? { kind, body, retries: 0 }];
      // Don't make the person wait behind a turn they didn't ask for that hasn't spoken yet.
      if (this.turn && (this.turn.kind !== 'user' || this.turn.unheard) && !this.turn.replying) void this.interrupt();
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
    if (!turn || !session || turn.interrupted || turn.softStopped) return;
    // The person already heard the opening ("I've added Billing, Ada's starting it");
    // cutting the tool calls now would make that untrue. Let them finish silently;
    // the person's next words run right after.
    if (this.saidOpening(turn)) {
      turn.softStopped = true;
      turn.muted = true;
      this.d.emit({ type: 'lead/state', state: 'thinking' });
      return;
    }
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

  /**
   * Settings changed (model, effort, name): use a fresh session (resumed, so
   * the conversation continues) from the next turn. A note tells the lead what
   * changed — its history still says the old name.
   */
  refresh(note?: string): void {
    if (note) this.notes.push(note);
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
    const saved = ws.state.leadSessionId;
    const resume = this.resumeTries < 2 && resumable(saved) ? saved : undefined;
    const input = new InputQueue();
    const q = query({ prompt: input, options: leadOptions(ws.root, s, this.d.makeTools(), resume, (tool, toolInput) => this.holdForAnswer(tool, toolInput)) });
    const session: Session = { q, input, usedResume: !!resume, gotInit: false, closing: false };
    // A fresh session hasn't seen the map yet (a resumed one saw an old one).
    this.seen = null;
    this.sessionTurns = 0;
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
    if (session.usedResume && !session.gotInit) return this.resumeFailed(session, turn, failure ?? '');
    if (failure && looksLikeAuthError(failure)) this.d.onClaudeStatus(false, failure);
    else if (failure) this.d.emit({ type: 'notice', level: 'warn', text: `${this.d.settings().leadName} lost the connection to Claude and is reconnecting.` });
    if (turn) this.finishTurn(turn);
    this.pump();
  }

  /**
   * The stored session couldn't be resumed. Forget it only when Claude Code
   * says it's gone; a transient startup failure is retried once with resume,
   * then this run starts fresh. The turn is retried.
   */
  private resumeFailed(session: Session, turn: Turn | null, why: string): void {
    const gone = /no conversation found|session[^.]*not found/i.test(why);
    this.resumeTries = gone ? 2 : this.resumeTries + 1;
    if (gone) this.d.ws.saveState({ leadSessionId: undefined });
    log('lead', `could not resume the previous session (${why || 'no reason given'}); ${this.resumeTries < 2 ? 'trying again' : 'starting a fresh one'}`);
    this.dropSession(session);
    if (turn && turn.retries < 2) {
      this.clearTurn(turn);
      for (const e of turn.events) this.d.ws.pushEvent(e.text, e.urgent);
      this.queue.unshift({ kind: turn.kind, body: turn.body, retries: turn.retries + 1, ...(turn.unheard ? { unheard: turn.unheard } : {}) });
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
    const stale = this.turnsSinceFullMap >= FULL_MAP_EVERY && this.seen?.version !== ws.mapVersion;
    const context = buildContext({
      ws,
      crew: this.d.crewLines(),
      agentName: this.d.agentName,
      seen: stale ? null : this.seen,
      withDecisions: this.sessionTurns === 0,
      slots: this.d.slots?.(),
      notes: this.notes.splice(0),
      kind: pending.kind,
      askedAloud: (item) => this.asked.askedAloud(item),
    });
    this.seen = { version: ws.mapVersion, ids: new Set(Object.keys(ws.map.nodes)) };
    this.turnsSinceFullMap = context.fullMap ? 0 : this.turnsSinceFullMap + 1;
    this.sessionTurns++;
    const events = ws.takeEvents();
    // The person's words are already in the session; a retry only asks for the spoken answer.
    const text = pending.unheard ? `${wrapTurn(context.text, events, 'events', '')}\n<unheard>${UNHEARD[pending.unheard]}</unheard>` : wrapTurn(context.text, events, pending.kind, pending.body);
    const turn: Turn = {
      ...pending,
      id: `turn-${nanoid(8)}`,
      startedAt: Date.now(),
      raw: '',
      filter: new SpeechFilter(),
      guard: this.asked.guard(pending.kind, pending.body, ws.agenda.open()),
      replying: false,
      saidBreak: false,
      streamed: new Set(),
      textBlocks: 0,
      afterTools: false,
      looking: false,
      held: 0,
      deferred: [],
      muted: false,
      interrupted: false,
      softStopped: false,
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
      // This session (resumed or fresh) is the one to resume from now on.
      this.resumeTries = 0;
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
      else if (ev.type === 'content_block_start') this.blockStart(turn, ev.content_block.type, (ev.content_block as { name?: string }).name);
      else if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta' && !turn.muted) this.feed(turn, ev.delta.text);
      return;
    }
    if (m.type === 'assistant') {
      if (m.parent_tool_use_id) return;
      if (m.error) log('lead', 'assistant error', m.error);
      if (m.error === 'authentication_failed' || m.error === 'oauth_org_not_allowed') this.d.onClaudeStatus(false, 'Claude Code is not signed in.');
      // Without partial messages for this message (rare), speak whole blocks at once.
      if (!turn.streamed.has(m.message.id)) {
        for (const block of m.message.content as { type: string; text?: string; name?: string }[]) {
          this.blockStart(turn, block.type, block.name);
          if (block.type === 'text' && block.text && !turn.muted) this.feed(turn, block.text);
        }
      }
      return;
    }
    if (m.type === 'result') {
      if (m.subtype !== 'success' && session.usedResume && !session.gotInit) return this.resumeFailed(session, turn, m.errors?.join('; ') ?? '');
      if (m.session_id && m.session_id !== this.d.ws.state.leadSessionId) this.d.ws.saveState({ leadSessionId: m.session_id });
      if (m.subtype !== 'success' && !turn.interrupted) log('lead', 'turn ended with', m.subtype, m.errors?.join('; '));
      this.finishTurn(turn);
      this.pump();
    }
  }

  /**
   * The person asked, the lead looked at the code, and hasn't said what it
   * found: camera moves wait until it has (the reason goes back to the lead
   * as the call's result). Everything else runs.
   */
  private holdForAnswer(tool: string, input?: unknown): string | null {
    const t = this.turn;
    if (!t || t.kind !== 'user' || !t.looking || t.softStopped || t.interrupted || !HELD_TOOLS.has(tool) || t.held >= MAX_HELD) return null;
    t.held++;
    const i = (input ?? {}) as { node_id?: unknown; mode?: unknown };
    const nodeId = typeof i.node_id === 'string' && i.node_id ? i.node_id : null;
    if (nodeId === null || this.d.ws.map.nodes[nodeId]) t.deferred.push({ nodeId, mode: i.mode === 'enter' ? 'enter' : 'show' });
    return HOLD_FOR_ANSWER;
  }

  /** The camera moves held back for a look's answer play now, paced like any walk. */
  private playDeferred(turn: Turn): void {
    for (const f of turn.deferred.splice(0)) this.walk.go(f.nodeId, f.mode);
  }

  private saidOpening(turn: Turn): boolean {
    return turn.afterTools && cleanReply(turn.raw).split(/\s+/).filter(Boolean).length >= MIN_OPENING_WORDS;
  }

  /**
   * One utterance per turn: the opening is spoken; once tools have run, any
   * further text is muted if the opening already said something real (it
   * would only restate it). Except after a quick look at code: then the text
   * is the answer the look found, and it is spoken.
   */
  private blockStart(turn: Turn, type: string, name?: string): void {
    if (type === 'tool_use' || type === 'server_tool_use') {
      // The text before the tools is complete: release its last sentence now
      // (with the trailing break the filter held, so it reads as finished).
      if (!turn.muted) {
        const tail = turn.filter.flushTail();
        this.say(turn, turn.guard ? turn.guard.push(tail) + turn.guard.flush() : tail);
        // A break after it, so the voice knows that sentence is over and says it now ("Let me look at the jobs worker.").
        if (turn.replying && !turn.saidBreak) this.say(turn, ' ');
      }
      turn.afterTools = true;
      if (name && LOOK_TOOLS.has(name)) {
        // Unless the person talked over this turn, what the look finds gets said.
        if (!turn.softStopped && !turn.interrupted) turn.muted = false;
        // Straight to the code without a word: say so now, so the person isn't
        // waiting on the look in silence.
        if (turn.kind === 'user' && !turn.unheard && !turn.muted && !turn.filter.silent && !cleanReply(turn.raw)) this.feed(turn, `${LOOK_OPENING} `);
        turn.looking = true;
      }
    }
    if (type !== 'text' || turn.muted) return;
    // After a look the answer is still to come (an empty text block doesn't count as it).
    if (!turn.looking && this.saidOpening(turn)) {
      turn.muted = true;
      return;
    }
    if (turn.textBlocks++ > 0 && !/\s$/.test(turn.raw)) {
      // The break was already sent when the tools started: only the reply's text needs it.
      if (turn.saidBreak) turn.raw += ' ';
      else this.feed(turn, ' ');
    }
  }

  private feed(turn: Turn, chunk: string): void {
    turn.raw += chunk;
    const out = turn.filter.push(chunk);
    // Words after a look are its answer; once they flow, the look is over (a silence tag isn't words),
    // and the camera moves held for it start walking with them.
    if (turn.looking && out.trim()) {
      turn.looking = false;
      this.playDeferred(turn);
    }
    this.say(turn, turn.guard ? turn.guard.push(out) : out);
  }

  private say(turn: Turn, out: string): void {
    if (!out) return;
    turn.saidBreak = /\s$/.test(out);
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
    if (!turn.interrupted && !turn.softStopped) this.playDeferred(turn);
    let tail = turn.filter.end();
    if (turn.guard) tail = turn.guard.push(tail) + turn.guard.flush();
    if (tail && !turn.filter.silent && !turn.interrupted) this.d.emit({ type: 'lead/delta', turnId: turn.id, text: tail });
    const dropped = turn.guard?.dropped ?? [];
    if (dropped.length) log('lead', `trimmed a repeat of an open card: ${dropped.map((d) => `"${d.trim()}"`).join(' ')}`);
    const text = turn.filter.silent ? '' : dropped.length ? withoutDropped(cleanReply(turn.raw), dropped) : cleanReply(turn.raw);
    // The person spoke and heard nothing back (straight to tools, then quiet), or
    // only "Let me look…" (a look whose answer never came): ask once more for
    // the spoken answer, ahead of anything else. If they already said more,
    // their new words get the answer instead.
    const unheard = !text ? 'silent' : turn.looking ? 'look' : null;
    if (unheard && turn.kind === 'user' && !turn.unheard && !turn.interrupted && !turn.softStopped && !this.closed && !this.queue.some((t) => t.kind === 'user')) {
      log('lead', unheard === 'look' ? 'a look ended without its answer; asking for it' : 'a reply to the person had no words; asking for the spoken answer');
      this.queue.unshift({ kind: 'user', body: turn.body, retries: 0, unheard });
    }
    if (text && !turn.interrupted) {
      const added = this.d.ws.agenda.open().filter((i) => i.createdAt >= turn.startedAt);
      this.asked.record(text, added.map((i) => i.id));
    }
    this.clearTurn(turn);
    this.d.emit({ type: 'lead/done', turnId: turn.id, text });
    this.d.emit({ type: 'lead/state', state: 'idle' });
    this.lastDoneAt = Date.now();
    const words = text ? text.split(/\s+/).length : 0;
    // Silence, or a reply the person talked over, leaves nothing to wait out.
    const audible = words > 0 && !turn.interrupted && !turn.softStopped;
    this.speechEndsAt = this.lastDoneAt + (audible ? Math.max(4000, words * 360) : 0);
    // A reply cut off by barge-in is kept only if it said something, marked as cut ("—").
    const kept = turn.interrupted ? (words >= 3 ? `${text.replace(/[\s,;:]+$/, '')}—` : '') : text;
    if (kept) this.d.ws.appendTranscript('lead', kept, this.d.ws.view.selectedNodeId);
    this.d.onTurnEnd?.(turn.kind, !!text);
  }
}
