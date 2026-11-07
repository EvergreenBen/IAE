// Small helpers around the Claude Agent SDK shared by every session type.

import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { query } from './agent';

export const CLIENT_APP = 'iae/0.1.0';

const t0 = Date.now();
export function log(scope: string, ...args: unknown[]): void {
  console.log(`[arxitect:${scope} +${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...args);
}
export const debug = (scope: string, ...args: unknown[]): void => {
  if (process.env.IAE_DEBUG) log(scope, ...args);
};

export const userMessage = (text: string): SDKUserMessage => ({
  type: 'user',
  message: { role: 'user', content: text },
  parent_tool_use_id: null,
});

/**
 * An async queue of user messages: the streaming input of a long-lived
 * session. `close()` ends the stream, which lets the session finish.
 */
export class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(text: string): void {
    if (this.closed) return;
    this.items.push(userMessage(text));
    this.notify();
  }

  close(): void {
    this.closed = true;
    this.notify();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private notify(): void {
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (true) {
      if (this.items.length) {
        yield this.items.shift()!;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((r) => (this.wake = r));
    }
  }
}

/** Options every Arxitect session shares: identification and an optional binary override. */
export function baseOptions(cwd: string): Options {
  const opts: Options = {
    cwd,
    env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: CLIENT_APP },
    stderr: (d: string) => debug('cli', d.trim()),
  };
  // IAE_CLAUDE_PATH is the old name, still honoured for anyone who set it.
  const claudePath = process.env.ARXITECT_CLAUDE_PATH || process.env.IAE_CLAUDE_PATH;
  if (claudePath) opts.pathToClaudeCodeExecutable = claudePath;
  return opts;
}

/** Concatenated text blocks of an assistant message. */
export function assistantText(m: SDKMessage): string {
  if (m.type !== 'assistant') return '';
  const blocks = m.message.content as { type: string; text?: string }[];
  return blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

const AUTH_PATTERNS = /(not logged in|log ?in|authenticat|oauth|api key|invalid x-api-key|credential|401|unauthori[sz]ed)/i;
export const looksLikeAuthError = (text: string): boolean => AUTH_PATTERNS.test(text);

/**
 * A one-shot query: send a prompt, return the final result text. Used for
 * explanations and other short side questions. Rejects on timeout or error.
 */
export async function oneShot(prompt: string, options: Options, timeoutMs = 45_000): Promise<string> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  const q = query({ prompt, options: { ...options, abortController: abort } });
  let text = '';
  try {
    for await (const m of q) {
      if (m.type === 'assistant') text = assistantText(m) || text;
      if (m.type === 'result') {
        if (m.subtype === 'success') return m.result || text;
        throw new Error(m.errors?.join('; ') || m.subtype);
      }
    }
    return text;
  } finally {
    clearTimeout(timer);
    q.close();
  }
}

/** Lean defaults for Arxitect-internal sessions: no user settings, no connectors. */
export function leanOptions(cwd: string): Options {
  return {
    ...baseOptions(cwd),
    settingSources: [],
    strictMcpConfig: true,
  };
}
