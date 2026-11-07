// A Codex session behind the Claude Agent SDK's Query: the same options in,
// the same messages out. Each user message is one turn, run as `codex exec`
// (resuming the thread after the first). What carries over from the options:
// working directory, model and effort, system prompt (as developer
// instructions), Arxitect's tools (served over a local connection, with
// PreToolUse hooks in front of them), whether it may write, and resume.
// What doesn't: approvals. Codex runs without asking, inside its sandbox
// (read-only for sessions given only read tools).

import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { relative } from 'node:path';
import type { HookCallbackMatcher, Options, SDKMessage, SDKUserMessage, SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import type { ThreadEvent } from '@openai/codex-sdk';
import { toolDefinitions } from '../agent';
import { readText } from '../changes';
import { debug, errorText, log } from '../sdk';
import { codexBinary, codexEnv } from './binary';
import { serveTools, type ToolGate, type ToolHost } from './tools';
import { CODEX_SESSION, threadIdOf, Translator } from './translate';

const WRITE_TOOLS = ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
/** An ask may wait 15 minutes for the person. */
const TOOL_TIMEOUT_SEC = 20 * 60;
const MAX_STDERR = 8000;

export const CODEX_MISSING = "Codex isn't included in this build of Arxitect.";

export class CodexQuery implements AsyncIterable<SDKMessage> {
  private out: SDKMessage[] = [];
  private wake: (() => void) | null = null;
  private ended = false;
  private failure: Error | null = null;
  private inbox: string[] = [];
  private inputDone = false;
  private inputWake: (() => void) | null = null;
  private closed = false;
  private turn: AbortController | null = null;
  private threadId: string | undefined;
  private tr: Translator;
  private tools: ToolHost[] = [];
  private files = new Map<string, string | null>();

  constructor(
    prompt: string | AsyncIterable<SDKUserMessage>,
    private readonly o: Options,
    private readonly model: string,
  ) {
    this.threadId = threadIdOf(o.resume);
    this.tr = new Translator({
      cwd: this.cwd,
      model: this.modelName ?? 'codex',
      permissionMode: this.sandbox,
      before: (abs) => this.before(abs),
      after: async (abs) => {
        const text = await readText(abs);
        this.files.set(abs, text);
        return text;
      },
    });
    if (this.threadId) this.tr.sessionId = CODEX_SESSION + this.threadId;
    o.abortController?.signal.addEventListener('abort', () => this.close(), { once: true });
    if (typeof prompt === 'string') {
      this.inbox.push(prompt);
      this.inputDone = true;
    } else void this.read(prompt);
    void this.run();
  }

  // ── the Query surface the engine uses ──────────────────────────────────────

  async *[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    while (true) {
      if (this.out.length) {
        yield this.out.shift()!;
        continue;
      }
      if (this.ended) {
        if (this.failure) throw this.failure;
        return;
      }
      await new Promise<void>((r) => (this.wake = r));
    }
  }

  /** Stops the turn in hand; the session carries on with the next message. */
  async interrupt(): Promise<void> {
    this.turn?.abort();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.turn?.abort();
    this.inputDone = true;
    this.inputWake?.();
  }

  async supportedCommands(): Promise<SlashCommand[]> {
    return [];
  }

  async initializationResult(): Promise<never> {
    throw new Error('Not available with Codex.');
  }

  // ── running ────────────────────────────────────────────────────────────────

  private get cwd(): string {
    return this.o.cwd ?? process.cwd();
  }

  /** Codex's model: the one chosen for Codex, else none (Codex's default). Claude's names mean nothing to it. */
  private get modelName(): string | undefined {
    if (this.model) return this.model;
    return this.o.model && !this.o.model.startsWith('claude') ? this.o.model : undefined;
  }

  private get sandbox(): string {
    if (Array.isArray(this.o.tools) && !this.o.tools.some((t) => WRITE_TOOLS.includes(t))) return 'read-only';
    return this.o.permissionMode === 'bypassPermissions' ? 'danger-full-access' : 'workspace-write';
  }

  private async read(prompt: AsyncIterable<SDKUserMessage>): Promise<void> {
    try {
      for await (const m of prompt) {
        if (this.closed) break;
        const c = m.message.content;
        const text = typeof c === 'string' ? c : c.map((b) => (b.type === 'text' ? b.text : '')).join('');
        if (text) this.inbox.push(text);
        this.inputWake?.();
      }
    } finally {
      this.inputDone = true;
      this.inputWake?.();
    }
  }

  private async next(): Promise<string | null> {
    while (!this.inbox.length && !this.inputDone && !this.closed) await new Promise<void>((r) => (this.inputWake = r));
    return this.closed ? null : (this.inbox.shift() ?? null);
  }

  private async run(): Promise<void> {
    try {
      const bin = codexBinary();
      if (!bin) throw new Error(CODEX_MISSING);
      const tools = await this.serveTools();
      for (let text = await this.next(); text !== null; text = await this.next()) await this.runTurn(bin, tools, text);
    } catch (e) {
      this.failure = e instanceof Error ? e : new Error(errorText(e));
    } finally {
      for (const t of this.tools) t.close();
      this.ended = true;
      this.notify();
    }
  }

  private async serveTools(): Promise<Record<string, string>> {
    const urls: Record<string, string> = {};
    const gate = gateFrom(this.o.hooks?.PreToolUse, this.cwd);
    for (const [name, cfg] of Object.entries(this.o.mcpServers ?? {})) {
      if ('instance' in cfg) {
        const host = await serveTools(name, toolDefinitions(cfg), gate);
        this.tools.push(host);
        urls[name] = host.url;
      } else if ('url' in cfg && typeof cfg.url === 'string') urls[name] = cfg.url;
    }
    return urls;
  }

  private args(tools: Record<string, string>): string[] {
    const o = this.o;
    const config: string[] = ['approval_policy="never"'];
    const instructions = typeof o.systemPrompt === 'string' ? o.systemPrompt : o.systemPrompt && 'append' in o.systemPrompt ? o.systemPrompt.append : undefined;
    if (instructions) config.push(`developer_instructions=${JSON.stringify(instructions)}`);
    const effort = o.effort ?? (o.thinking?.type === 'disabled' ? 'low' : undefined);
    if (effort) config.push(`model_reasoning_effort="${effort}"`);
    if (this.sandbox === 'workspace-write') config.push('sandbox_workspace_write.network_access=true');
    for (const [name, url] of Object.entries(tools)) {
      config.push(`mcp_servers.${name}.url=${JSON.stringify(url)}`, `mcp_servers.${name}.tool_timeout_sec=${TOOL_TIMEOUT_SEC}`, `mcp_servers.${name}.startup_timeout_sec=30`);
    }
    const args = ['exec', '--experimental-json', '--skip-git-repo-check', '--cd', this.cwd, '--sandbox', this.sandbox];
    // Arxitect's own lean sessions skip the person's config (their MCP servers would slow every turn); builders keep it.
    if (Array.isArray(o.settingSources) && !o.settingSources.length) args.push('--ignore-user-config');
    if (this.modelName) args.push('--model', this.modelName);
    for (const c of config) args.push('--config', c);
    if (this.threadId) args.push('resume', this.threadId);
    return args;
  }

  private async runTurn(bin: NonNullable<ReturnType<typeof codexBinary>>, tools: Record<string, string>, text: string): Promise<void> {
    const startedAt = Date.now();
    const abort = new AbortController();
    this.turn = abort;
    this.tr.beginTurn();
    const errors: string[] = [];
    let stderr = '';
    let finished = false;

    const child = spawn(bin.path, this.args(tools), { cwd: this.cwd, env: codexEnv(bin), signal: abort.signal, windowsHide: true });
    const exited = new Promise<void>((resolve) => {
      child.once('close', () => resolve());
      child.once('error', (e) => {
        if (!abort.signal.aborted) errors.push(errorText(e));
        resolve();
      });
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString('utf8')).slice(-MAX_STDERR);
      debug('codex', d.toString('utf8').trim());
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(text);

    if (child.stdout) {
      for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
        let ev: ThreadEvent;
        try {
          ev = JSON.parse(line) as ThreadEvent;
        } catch {
          continue;
        }
        if (ev.type === 'thread.started') this.threadId = ev.thread_id;
        for (const m of await this.tr.translate(ev)) this.push(m);
        if (ev.type === 'item.completed' && ev.item.type === 'error') log('codex', 'error item', ev.item.message);
        if (ev.type === 'error') errors.push(ev.message);
        if (ev.type === 'turn.completed') {
          finished = true;
          for (const m of this.tr.init()) this.push(m);
          this.push(this.tr.result(true, { queued: this.inbox.length, ms: Date.now() - startedAt }));
        } else if (ev.type === 'turn.failed') {
          finished = true;
          this.push(this.tr.result(false, { errors: [ev.error.message], ms: Date.now() - startedAt }));
        }
      }
    }
    await exited;
    if (this.turn === abort) this.turn = null;
    if (finished) return;
    const why = abort.signal.aborted ? 'Interrupted.' : errors.join('; ') || lastLines(stderr) || 'Codex stopped without finishing.';
    this.push(this.tr.result(false, { errors: [why], ms: Date.now() - startedAt }));
  }

  /** A file's text before the change Codex just made: what it last saw, else what git last committed. */
  private async before(abs: string): Promise<string | null | undefined> {
    if (this.files.has(abs)) return this.files.get(abs);
    const rel = relative(this.cwd, abs).split('\\').join('/');
    if (rel.startsWith('..')) return undefined;
    return new Promise((resolve) => {
      execFile('git', ['show', `HEAD:${rel}`], { cwd: this.cwd, maxBuffer: 4 * 1024 * 1024, timeout: 5000 }, (err, out) => resolve(err ? undefined : out));
    });
  }

  private push(m: SDKMessage): void {
    this.out.push(m);
    this.notify();
  }

  private notify(): void {
    const w = this.wake;
    this.wake = null;
    w?.();
  }
}

/** The session's PreToolUse hooks, asked before one of Arxitect's own tools runs. */
function gateFrom(matchers: HookCallbackMatcher[] | undefined, cwd: string): ToolGate | undefined {
  if (!matchers?.length) return undefined;
  return async (toolName, toolInput) => {
    for (const m of matchers) {
      if (m.matcher && !new RegExp(`^(?:${m.matcher})$`).test(toolName)) continue;
      for (const hook of m.hooks) {
        const input = { hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput, tool_use_id: '', session_id: '', transcript_path: '', cwd };
        const out = (await hook(input as never, undefined, { signal: new AbortController().signal })) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
        if (out?.hookSpecificOutput?.permissionDecision === 'deny') return out.hookSpecificOutput.permissionDecisionReason || 'Not now.';
      }
    }
    return null;
  };
}

function lastLines(s: string): string {
  return s.trim().split('\n').slice(-3).join(' ').trim();
}
