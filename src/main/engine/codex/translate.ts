// Codex's events, as the Claude Agent SDK messages the engine already reads.
// Codex's own actions become the Claude Code tools that mean the same thing
// (a command → Bash, a patch → Write, its plan → TodoWrite), so a builder's
// activity line, its place on the map, its progress bar and its line counts
// work unchanged. Text arrives a whole message at a time (no partial messages).

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ThreadEvent, ThreadItem } from '@openai/codex-sdk';
import { isAbsolute, join } from 'node:path';

/** Session ids carry their agent, so a Claude session is never handed to Codex to resume (or the reverse). */
export const CODEX_SESSION = 'codex:';
export const threadIdOf = (sessionId: string | undefined): string | undefined => (sessionId?.startsWith(CODEX_SESSION) ? sessionId.slice(CODEX_SESSION.length) : undefined);

/** Output kept from a command for its tool result. */
const MAX_OUTPUT = 4000;

type Block = Record<string, unknown>;

export interface TranslateContext {
  cwd: string;
  model: string;
  permissionMode: string;
  /** A changed file's text before this change (null: it didn't exist; undefined: unknown). */
  before(absPath: string): Promise<string | null | undefined>;
  /** Its text now (null: gone). */
  after(absPath: string): Promise<string | null>;
}

export class Translator {
  sessionId = '';
  /** The last thing it said: the turn's result when Codex gives none. */
  lastText = '';
  private initSent = false;
  private started = new Set<string>();
  private todoCalls = 0;
  private n = 0;

  constructor(private readonly ctx: TranslateContext) {}

  /** The session's start, once: on the thread's first event, or (a resumed thread that doesn't announce itself) its first turn's end. */
  init(): SDKMessage[] {
    if (this.initSent || !this.sessionId) return [];
    this.initSent = true;
    return [this.msg({ type: 'system', subtype: 'init', model: this.ctx.model, permissionMode: this.ctx.permissionMode, cwd: this.ctx.cwd, tools: [], mcp_servers: [], slash_commands: [], apiKeySource: 'none' })];
  }

  /** A fresh turn on the same thread. */
  beginTurn(): void {
    this.lastText = '';
  }

  async translate(ev: ThreadEvent): Promise<SDKMessage[]> {
    switch (ev.type) {
      case 'thread.started':
        this.sessionId = CODEX_SESSION + ev.thread_id;
        return this.init();
      case 'item.started':
      case 'item.updated':
        return this.started_(ev.item, ev.type === 'item.updated');
      case 'item.completed':
        return this.completed(ev.item);
      default:
        // turn.started / turn.completed / turn.failed / error: the query decides how a turn ends.
        return [];
    }
  }

  private started_(item: ThreadItem, update: boolean): SDKMessage[] {
    if (item.type === 'todo_list') return this.todos(item.items);
    if (update || this.started.has(item.id)) return [];
    const call = this.callFor(item);
    if (!call) return [];
    this.started.add(item.id);
    return [this.toolUse(item.id, call.name, call.input)];
  }

  private async completed(item: ThreadItem): Promise<SDKMessage[]> {
    switch (item.type) {
      case 'agent_message':
        if (!item.text.trim()) return [];
        this.lastText = item.text;
        return [this.assistant([{ type: 'text', text: item.text }])];
      case 'todo_list':
        return this.todos(item.items);
      case 'file_change':
        return this.fileChanges(item.id, item.changes, item.status === 'failed');
      case 'reasoning':
      case 'error':
        // Its thinking isn't said; a non-fatal error is logged by the query.
        return [];
      default: {
        const call = this.callFor(item);
        if (!call) return [];
        const out: SDKMessage[] = this.started.has(item.id) ? [] : [this.toolUse(item.id, call.name, call.input)];
        this.started.delete(item.id);
        out.push(this.toolResult(item.id, call.result ?? '', call.failed ?? false));
        return out;
      }
    }
  }

  /** The Claude Code tool a Codex action stands for. */
  private callFor(item: ThreadItem): { name: string; input: Block; result?: string; failed?: boolean } | null {
    switch (item.type) {
      case 'command_execution':
        return { name: 'Bash', input: { command: item.command }, result: clip(item.aggregated_output), failed: item.status === 'failed' || (item.exit_code ?? 0) !== 0 };
      case 'mcp_tool_call':
        return {
          name: `mcp__${item.server}__${item.tool}`,
          input: (item.arguments && typeof item.arguments === 'object' ? item.arguments : {}) as Block,
          result: item.error?.message ?? textOf(item.result?.content),
          failed: item.status === 'failed',
        };
      case 'web_search':
        return { name: 'WebSearch', input: { query: item.query } };
      default:
        return null;
    }
  }

  private todos(items: { text: string; completed: boolean }[]): SDKMessage[] {
    if (!items.length) return [];
    const id = `todo-${++this.todoCalls}`;
    const todos = items.map((t) => ({ content: t.text, status: t.completed ? 'completed' : 'pending' }));
    return [this.toolUse(id, 'TodoWrite', { todos }), this.toolResult(id, 'Updated.', false)];
  }

  /** Each file in a patch, as a Write of what it holds now (with what it held before, for the line count). */
  private async fileChanges(id: string, changes: { path: string; kind: string }[], failed: boolean): Promise<SDKMessage[]> {
    const out: SDKMessage[] = [];
    for (const [i, c] of changes.entries()) {
      const abs = isAbsolute(c.path) ? c.path : join(this.ctx.cwd, c.path);
      const callId = `${id}-${i}`;
      if (c.kind === 'delete') {
        out.push(this.toolUse(callId, 'Bash', { command: `rm ${JSON.stringify(abs)}` }), this.toolResult(callId, '', failed));
        continue;
      }
      const before = failed ? undefined : await this.ctx.before(abs);
      const content = failed ? null : await this.ctx.after(abs);
      out.push(this.toolUse(callId, 'Write', { file_path: abs, content: content ?? '' }));
      const structured =
        content === null ? undefined : c.kind === 'add' || before === null ? { type: 'create', content } : typeof before === 'string' ? { type: 'update', content, originalFile: before } : undefined;
      out.push(this.toolResult(callId, failed ? 'The patch failed.' : 'Done.', failed, structured));
    }
    return out;
  }

  // ── message shapes ─────────────────────────────────────────────────────────

  private msg(m: Block): SDKMessage {
    return { ...m, session_id: this.sessionId, uuid: `codex-${++this.n}` } as unknown as SDKMessage;
  }

  private assistant(content: Block[]): SDKMessage {
    return this.msg({
      type: 'assistant',
      message: { id: `codex-msg-${this.n + 1}`, type: 'message', role: 'assistant', model: this.ctx.model, content, stop_reason: null, usage: {} },
      parent_tool_use_id: null,
    });
  }

  private toolUse(id: string, name: string, input: Block): SDKMessage {
    return this.assistant([{ type: 'tool_use', id, name, input }]);
  }

  private toolResult(id: string, text: string, isError: boolean, structured?: unknown): SDKMessage {
    return this.msg({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] },
      parent_tool_use_id: null,
      ...(structured ? { tool_use_result: structured } : {}),
    });
  }

  result(ok: boolean, detail: { errors?: string[]; queued?: number; ms: number }): SDKMessage {
    return this.msg({
      type: 'result',
      subtype: ok ? 'success' : 'error_during_execution',
      is_error: !ok,
      result: this.lastText,
      errors: detail.errors ?? [],
      queued_turn_count: detail.queued ?? 0,
      duration_ms: detail.ms,
      duration_api_ms: detail.ms,
      num_turns: 1,
      total_cost_usd: 0,
      usage: {},
      modelUsage: {},
      permission_denials: [],
    });
  }
}

function clip(s: string): string {
  return s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n…` : s;
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (b && typeof b === 'object' && (b as { type?: string }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : ''))
    .join('');
}
