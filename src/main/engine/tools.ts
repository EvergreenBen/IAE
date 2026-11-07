// The lead's in-process MCP server ("iae"). Handlers are fast and never block
// on a builder: delegate queues a job and returns at once.

import { tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { toolServer } from './agent';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { EngineEvent } from '../../shared/events';
import type { AgendaItem, AgendaKind, NodeStatus } from '../../shared/model';
import { anchorNode, type DecidedBy } from './agenda';
import { describeResult, normalizeOps, opInput } from './mapops';
import { errorText, log } from './sdk';
import type { Workspace } from './workspace';

export const LEAD_TOOL_NAMES = [
  'sketch_map',
  'focus',
  'ask',
  'resolve_question',
  'drop_question',
  'decide',
  'delegate',
  'message_agent',
  'stop_agent',
] as const;

export interface DelegateInput {
  title: string;
  brief: string;
  nodeId: string | null;
  kind: 'build' | 'investigate';
}

export interface LeadToolHost {
  ws: Workspace;
  emit: (e: EngineEvent) => void;
  /** Resolves a question; `told` names the builders that now have the answer. */
  answer(id: string, answer: string): { item: AgendaItem; told: string[] } | null;
  delegate(input: DelegateInput): { id: string; name: string; queued: boolean };
  messageAgent(agentId: string, message: string): string;
  stopAgent(agentId: string): Promise<string>;
  /** The lead already spoke this turn: results remind it to end without more text. */
  hasSpoken?: () => boolean;
  /** The person answered a question during this turn (a tap, or resolve_question): a decide without `by` is theirs. */
  answeredThisTurn?: () => boolean;
  leadName?: () => string;
}

/** Appended to tool results once the turn's sentence is out (text after tools isn't spoken). */
export const END_HINT = '\n(You already spoke this turn; nothing after your tools is heard. When your tool calls are done, end the turn by replying exactly <silence/>.)';
/**
 * Appended while the turn hasn't said its piece yet (nothing said, a short
 * opening, or a look whose answer hasn't come): text after the tools is heard,
 * so a lead that believes otherwise doesn't end in silence.
 */
export const SAY_HINT = "\n(Your words after these tools are heard: if you haven't yet told the person what you found or answered them, do it now, out loud, in full.)";

/** A tool result with what happens to text after it (unknown: no hint). */
export function hinted(text: string, spoken: boolean | undefined): string {
  return spoken === undefined ? text : text + (spoken ? END_HINT : SAY_HINT);
}

export const ok = (text: string): CallToolResult => ({ content: [{ type: 'text', text }] });
const okResult = ok;
export const fail = (text: string): CallToolResult => ({ content: [{ type: 'text', text }], isError: true });

/** Runs a handler, turning any throw into an error result the model can read. */
export async function guard(name: string, fn: () => CallToolResult | Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (e) {
    log('tools', `${name} failed`, errorText(e));
    return fail(`${name} failed: ${errorText(e)}`);
  }
}

const AGENDA_KINDS: AgendaKind[] = ['decision', 'idea', 'risk', 'clarify'];

/** About one spoken sentence: how long the camera stays on each part of a walkthrough. */
export const FOCUS_STEP_MS = 3_500;
/** Focus calls closer together than this belong to one walk (one batch of tools). */
const FOCUS_BATCH_MS = 2_000;

/**
 * Several focus calls in one batch walk the camera through them in order, one
 * step every few seconds, so it follows an explanation as it is spoken instead
 * of jumping to the last part. The first goes at once. A walk still pending is
 * dropped when the person does anything or a later turn moves the camera.
 */
export class CameraWalk {
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private lastCallAt = -Infinity;
  private nextAt = 0;

  constructor(
    private readonly move: (nodeId: string | null, mode: 'show' | 'enter') => void,
    /** True when the person was active after `since` (or the project closed): skip the step. */
    private readonly overtaken: (since: number) => boolean,
    private readonly now: () => number = Date.now,
  ) {}

  /** Moves now or later; returns the delay in ms. */
  go(nodeId: string | null, mode: 'show' | 'enter'): number {
    const now = this.now();
    if (now - this.lastCallAt > FOCUS_BATCH_MS) {
      this.cancel();
      this.nextAt = now;
    }
    this.lastCallAt = now;
    const at = Math.max(now, this.nextAt);
    this.nextAt = at + FOCUS_STEP_MS;
    const delay = at - now;
    if (!delay) {
      this.move(nodeId, mode);
      return 0;
    }
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.overtaken(now)) this.move(nodeId, mode);
    }, delay);
    this.timers.add(timer);
    return delay;
  }

  cancel(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}

/** Status for a node the lead creates: built when its paths already hold files. */
export function statusForPaths(ws: Workspace, paths: string[] | undefined): NodeStatus {
  if (!paths?.length) return 'planned';
  const files = ws.files;
  const owns = (p: string) =>
    files.some((f) => (p.endsWith('/') ? f.path.startsWith(p) : f.path === p || f.path.startsWith(p + '/')));
  return paths.some(owns) ? 'built' : 'planned';
}

export function createLeadTools(host: LeadToolHost): McpSdkServerConfigWithInstance {
  const { ws } = host;
  // Results say what happens to text after them. Once the sentence is out it
  // isn't heard (the model otherwise writes its reply a second time, unspoken
  // and slow); before that it is, so the answer must come (never silence).
  const ok = (text: string): CallToolResult => okResult(hinted(text, host.hasSpoken?.()));
  const walk = new CameraWalk(
    (nodeId, mode) => host.emit({ type: 'focus', nodeId, mode }),
    (since) => ws.isClosed || ws.lastUserActivityAt > since,
  );
  const nodeOrNull = (id: string | null | undefined): { id: string | null; note: string } => {
    if (!id) return { id: null, note: '' };
    if (ws.map.nodes[id]) return { id, note: '' };
    return { id: null, note: ` (no node "${id}", so it isn't anchored)` };
  };

  return toolServer({
    name: 'iae',
    version: '0.1.0',
    alwaysLoad: true,
    tools: [
      tool(
        'sketch_map',
        'Change the architecture map. Ops apply in order (create a parent before its children). Ops: {op:"upsertNode", node:{id, parentId?, label?, techLabel?, kind?, status?, summary?, tech?, paths?}} (creates or merges; new nodes default to "planned"), {op:"removeNode", id} (removes its subtree), {op:"moveNode", id, parentId}, {op:"upsertEdge", edge:{from, to, kind?, label?}}, {op:"removeEdge", id:"from->to"}. Returns the ids applied and any fixes.',
        { ops: z.array(opInput).describe('Map operations, applied in order.') },
        (args) =>
          guard('sketch_map', () => {
            if (!args.ops?.length) return fail('No ops given.');
            const r = normalizeOps(args.ops, ws.map, { root: ws.root, defaultStatus: ({ paths }) => statusForPaths(ws, paths) });
            ws.applyMapOps(r.ops, 'lead');
            return r.ops.length ? ok(describeResult(r)) : fail(describeResult(r));
          }),
      ),
      tool(
        'focus',
        'Move the person\'s camera to a node: "show" frames it, "enter" dives inside it (its children and files show). Use it whenever you point at a node or a file. Walking through several parts? Call it once per part, in the order you name them, all in one batch: the camera follows your words, a step every few seconds. node_id null returns to the top level.',
        {
          node_id: z.string().nullable().describe('Node id, or null for the top level.'),
          mode: z.string().optional().describe('"show" (default) or "enter".'),
        },
        (args) =>
          guard('focus', () => {
            const id = args.node_id || null;
            if (id && !ws.map.nodes[id]) return fail(`No node "${id}". Known top-level ids: ${topIds(ws).join(', ') || '(none)'}.`);
            const mode = args.mode === 'enter' ? 'enter' : 'show';
            const later = walk.go(id, mode);
            return ok(`Camera ${later ? 'goes ' : ''}${mode === 'enter' ? 'inside' : 'on'} ${id ?? 'the top level'}${later ? ` in ${Math.round(later / 100) / 10}s` : ''}.`);
          }),
      ),
      tool(
        'ask',
        'Put a question on the map, anchored to its node. Only for what changes what gets built and only the person can answer (taste, business facts, priorities between conflicting options, risk appetite) — never to ask leave to start, restart, fix or check something: do that. Give 2–4 short options; the first is your recommendation. Returns the question id.',
        {
          prompt: z.string().describe('The question as spoken, ≤ 25 words, naming real parts of this system.'),
          kind: z.string().optional().describe('decision | idea | risk | clarify (default decision).'),
          why: z.string().optional().describe('One line: why it matters now.'),
          options: z.array(z.string()).optional().describe('2–4 one-tap answers, recommended first.'),
          node_id: z.string().optional().describe('Node it is about, at the level the person is looking at (a deep node is shown on its visible ancestor).'),
          priority: z.number().optional().describe('0..1, the cost of getting it wrong (default 0.5).'),
        },
        (args) =>
          guard('ask', () => {
            if (!args.prompt?.trim()) return fail('prompt is required.');
            const node = nodeOrNull(args.node_id);
            const kind = AGENDA_KINDS.includes(args.kind as AgendaKind) ? (args.kind as AgendaKind) : 'decision';
            const nodeId = anchorNode(ws.map, node.id, ws.view.scopeId);
            const item = ws.agenda.ask({ prompt: args.prompt, kind, why: args.why, options: args.options, nodeId, priority: args.priority });
            const still = ws.agenda.get(item.id)?.status === 'open';
            const moved = nodeId && nodeId !== node.id ? ` (shown on ${nodeId}, where the person is looking)` : '';
            return ok(still ? `Asked [${item.id}]${node.note}${moved}.` : `[${item.id}] was pruned: five higher-priority questions are already open. Drop one first if this matters more.`);
          }),
      ),
      tool(
        'resolve_question',
        'Close an open question with the person\'s answer (even one given in passing). Builders who asked it get the answer directly. Record the choice itself once with decide, in your own words.',
        { id: z.string(), answer: z.string().describe('The answer, in a few words.') },
        (args) =>
          guard('resolve_question', () => {
            const r = host.answer(args.id, args.answer);
            if (!r) return fail(`No open question "${args.id}" (already answered or dropped).`);
            const told = r.told.length ? `; ${r.told.join(' and ')} got the answer directly, so don't relay it` : '';
            return ok(`Resolved [${r.item.id}]${told}.`);
          }),
      ),
      tool(
        'drop_question',
        'Remove an open question that is stale or no longer matters.',
        { id: z.string() },
        (args) =>
          guard('drop_question', () => (ws.agenda.dismiss(args.id) ? ok(`Dropped [${args.id}].`) : fail(`No open question "${args.id}".`))),
      ),
      tool(
        'decide',
        'Record a decision so builders and future turns follow it. Say whose call it was: "person" when the person said or chose it (an answer to a card included), "me" when you decided it yourself.',
        {
          title: z.string().describe('The decision, ≤ 12 words: "Sessions live in Postgres".'),
          rationale: z.string().optional().describe('One line: why.'),
          by: z.string().optional().describe('"person" (they said or chose it) or "me" (your own call).'),
          node_id: z.string().optional(),
        },
        (args) =>
          guard('decide', () => {
            if (!args.title?.trim()) return fail('title is required.');
            const by = decidedBy(args.by, host.answeredThisTurn?.() ?? false);
            const d = ws.agenda.decide({ title: args.title, rationale: args.rationale, nodeId: nodeOrNull(args.node_id).id, by, leadName: host.leadName?.() });
            return ok(`Recorded [${d.id}] as ${by === 'person' ? "the person's choice" : 'your own call'}.`);
          }),
      ),
      tool(
        'delegate',
        'Start a builder (kind "build": full Claude Code session that edits code) or a scout (kind "investigate": read-only). Several independent jobs: call it once per job, all in the same batch. The brief must be self-contained: goal, node, relevant paths, decisions, constraints, and what done means. Returns immediately with the agent\'s id.',
        {
          title: z.string().describe('Short job title, ≤ 6 words: "Build session middleware".'),
          brief: z.string().describe('Self-contained instructions. Builders cannot hear the conversation.'),
          node_id: z.string().optional().describe('Node the work belongs to.'),
          kind: z.string().optional().describe('"build" (default) or "investigate".'),
        },
        (args) =>
          guard('delegate', () => {
            if (!args.title?.trim() || !args.brief?.trim()) return fail('title and brief are required.');
            const node = nodeOrNull(args.node_id);
            const kind = args.kind === 'investigate' ? 'investigate' : 'build';
            const a = host.delegate({ title: args.title.trim(), brief: args.brief.trim(), nodeId: node.id, kind });
            return ok(`${a.name} [${a.id}] ${a.queued ? 'is queued (crew is full)' : 'is starting'}${node.note}.`);
          }),
      ),
      tool(
        'message_agent',
        'Pass a new instruction or decision to a running builder.',
        { agent_id: z.string().describe('Agent id or name.'), message: z.string() },
        (args) => guard('message_agent', () => ok(host.messageAgent(args.agent_id, args.message))),
      ),
      tool(
        'stop_agent',
        'Stop a running builder or scout.',
        { agent_id: z.string().describe('Agent id or name.') },
        (args) => guard('stop_agent', async () => ok(await host.stopAgent(args.agent_id))),
      ),
    ],
  });
}

/** Whose decision it is: what the lead said, else the person's when they answered a question this turn. */
export function decidedBy(by: unknown, answeredThisTurn: boolean): DecidedBy {
  const b = typeof by === 'string' ? by.trim().toLowerCase() : '';
  if (/^(person|user|human|they|them|the person|owner|client)$/.test(b)) return 'person';
  if (/^(me|i|lead|the lead|self|myself|mine|own|my call)$/.test(b)) return 'lead';
  return answeredThisTurn ? 'person' : 'lead';
}

function topIds(ws: Workspace): string[] {
  return Object.values(ws.map.nodes)
    .filter((n) => !n.parentId)
    .map((n) => n.id)
    .slice(0, 12);
}
