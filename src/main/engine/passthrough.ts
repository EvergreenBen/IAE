// Claude Code passthrough: is Claude available, which slash commands exist in
// this project, and quick plain-language file explanations.

import type { SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import { provider, query } from './agent';
import { checkCodex } from './codex/status';
import type { SlashCommandInfo } from '../../shared/model';
import { baseOptions, errorText, InputQueue, leanOptions, oneShot } from './sdk';

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

export interface ClaudeCheck {
  ok: boolean;
  detail?: string;
}

const NOT_SIGNED_IN = 'Claude Code is not signed in. Run `claude` in a terminal and use /login, then reopen Arxitect.';

/** Whether the chosen agent (Claude Code or Codex) can run. */
export function checkAgent(cwd: string): Promise<ClaudeCheck> {
  return provider() === 'codex' ? checkCodex() : checkClaude(cwd);
}

/**
 * Starts a session without sending anything (no tokens spent) and reads the
 * account from its initialize response.
 */
export async function checkClaude(cwd: string): Promise<ClaudeCheck> {
  const input = new InputQueue();
  const q = query({ prompt: input, options: { ...leanOptions(cwd), tools: [], persistSession: false } });
  try {
    const init = await withTimeout(q.initializationResult(), 30_000, 'Starting Claude Code');
    const a = init.account ?? {};
    const thirdParty = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'ANTHROPIC_API_KEY'].some((k) => process.env[k]);
    if (a.email || a.apiKeySource || a.tokenSource || a.apiProvider || thirdParty) return { ok: true };
    return { ok: false, detail: NOT_SIGNED_IN };
  } catch (e) {
    const msg = errorText(e);
    if (/native cli binary|not found|ENOENT|spawn/i.test(msg)) return { ok: false, detail: `Couldn't start Claude Code: ${msg}` };
    return { ok: false, detail: msg };
  } finally {
    input.close();
    q.close();
  }
}

/** Built-in commands that only make sense in the terminal UI, not in a builder session. */
const LOCAL_ONLY = new Set([
  'clear',
  'color',
  'compact',
  'config',
  'context',
  'cost',
  'effort',
  'exit',
  'fast',
  'focus',
  'heapdump',
  'help',
  'model',
  'output-style',
  'rename',
  'resume',
  'status',
  'statusline',
  'usage',
  'usage-credits',
  'extra-usage',
  'insights',
  'recap',
  'autocompact',
  'auto-mode-setup',
  'agents',
  'mcp',
  'import',
  'reload-plugins',
  'reload-skills',
  'doctor',
  'skill-doctor',
  'loop',
  'login',
  'logout',
  'permissions',
  'hooks',
  'memory',
  'theme',
  'vim',
  'terminal-setup',
  'ide',
  'workflow-launch-exec',
]);

export function toCommandInfos(cmds: SlashCommand[]): SlashCommandInfo[] {
  const seen = new Set<string>();
  const out: SlashCommandInfo[] = [];
  for (const c of cmds) {
    const name = c.name.replace(/^\//, '');
    if (!name || name.startsWith('_') || seen.has(name) || (c.builtin && LOCAL_ONLY.has(name))) continue;
    seen.add(name);
    out.push({ name, description: c.description || '', ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The project's commands and skills, exactly as Claude Code sees them (user + project + plugins). */
export async function listProjectCommands(cwd: string): Promise<SlashCommandInfo[]> {
  // Codex's slash commands only exist in its terminal UI.
  if (provider() === 'codex') return [];
  const input = new InputQueue();
  const q = query({ prompt: input, options: { ...baseOptions(cwd), settingSources: ['user', 'project', 'local'], persistSession: false } });
  try {
    return toCommandInfos(await withTimeout(q.supportedCommands(), 30_000, 'Listing commands'));
  } finally {
    input.close();
    q.close();
  }
}

const EXPLAIN_SYSTEM = `You explain one file of a software project to the person who designs that system. Reply in 2–3 plain spoken sentences, under 55 words: what the file is for and how it fits the system. Describe, don't judge; mention a risk only if it's real and specific. No markdown, no code, no lists, no preamble.`;

export interface ExplainInput {
  root: string;
  model: string;
  path: string;
  content: string;
  ownerLabel?: string;
}

export async function explainFileText(i: ExplainInput): Promise<string> {
  const body = i.content.length > 24_000 ? `${i.content.slice(0, 24_000)}\n… (truncated)` : i.content;
  const prompt = `File: ${i.path}${i.ownerLabel ? ` (part of "${i.ownerLabel}" on the architecture map)` : ''}\n\n<file>\n${body}\n</file>`;
  const text = await oneShot(
    prompt,
    {
      ...leanOptions(i.root),
      model: i.model,
      thinking: { type: 'disabled' },
      tools: ['Read'],
      allowedTools: ['Read'],
      permissionMode: 'dontAsk',
      systemPrompt: EXPLAIN_SYSTEM,
      persistSession: false,
      maxTurns: 3,
    },
    45_000,
  );
  return text.replace(/\s+/g, ' ').trim();
}

/** First sentence, clipped: a one-line note for notes.json. */
export function firstSentence(text: string, max = 140): string {
  const m = /^(.+?[.!?])(\s|$)/.exec(text);
  const s = (m ? m[1] : text).trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
