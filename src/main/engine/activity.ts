// Turns a session's tool calls into what the map shows: a step in the agent's
// log, a one-line activity ("Editing session.ts"), and file touches.

import { existsSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import type { AgentStepKind } from '../../shared/model';

export interface ToolActivity {
  kind: AgentStepKind;
  /** Spoken-style one-liner shown next to the agent. */
  activity: string;
  /** Project-relative POSIX path, when the tool targets a file inside the project. */
  path?: string;
  touch?: 'read' | 'edit' | 'create';
}

const clip = (s: string, n: number): string => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
};

/** Project-relative POSIX path, or null when it's outside the project. */
export function projectPath(root: string, p: unknown): string | null {
  if (typeof p !== 'string' || !p) return null;
  const abs = isAbsolute(p) ? p : resolve(root, p);
  const rel = relative(root, abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split('\\').join('/');
}

function fileTool(root: string, raw: unknown, verb: string, kind: AgentStepKind, touch: ToolActivity['touch']): ToolActivity {
  const path = projectPath(root, raw);
  const name = typeof raw === 'string' ? basename(raw) : 'a file';
  return { kind, activity: `${verb} ${name}`, ...(path ? { path, touch } : {}) };
}

/**
 * Describes a tool_use block. `fileExists` is injectable for tests; Write is a
 * "create" when the file didn't exist when the call was made.
 */
export function describeToolUse(
  root: string,
  name: string,
  input: Record<string, unknown>,
  fileExists: (abs: string) => boolean = existsSync,
): ToolActivity {
  switch (name) {
    case 'Read':
      return fileTool(root, input.file_path, 'Reading', 'read', 'read');
    case 'Edit':
    case 'MultiEdit':
      return fileTool(root, input.file_path, 'Editing', 'edit', 'edit');
    case 'NotebookEdit':
      return fileTool(root, input.notebook_path, 'Editing', 'edit', 'edit');
    case 'Write': {
      const raw = input.file_path;
      const abs = typeof raw === 'string' ? (isAbsolute(raw) ? raw : resolve(root, raw)) : '';
      const creating = !!abs && !fileExists(abs);
      return fileTool(root, raw, creating ? 'Creating' : 'Writing', 'write', creating ? 'create' : 'edit');
    }
    case 'Bash':
      return { kind: 'bash', activity: typeof input.command === 'string' ? humanCommand(input.command, root) : 'Running a command' };
    case 'Grep': {
      const pattern = typeof input.pattern === 'string' ? input.pattern : '';
      return { kind: 'search', activity: pattern ? `Searching for '${clip(pattern, 32)}'` : 'Searching the code' };
    }
    case 'Glob': {
      const pattern = typeof input.pattern === 'string' ? input.pattern : '';
      return { kind: 'search', activity: pattern ? `Looking for ${clip(pattern, 36)}` : 'Looking through files' };
    }
    case 'LS':
      return { kind: 'search', activity: 'Looking through files' };
    case 'WebFetch': {
      let host = '';
      try {
        host = new URL(String(input.url)).hostname;
      } catch {
        // not a URL
      }
      return { kind: 'tool', activity: host ? `Reading ${host}` : 'Reading the web' };
    }
    case 'WebSearch':
      return { kind: 'search', activity: `Searching the web for '${clip(String(input.query ?? ''), 32)}'` };
    case 'Task':
    case 'Agent':
      return { kind: 'tool', activity: `Delegating: ${clip(String(input.description ?? 'a subtask'), 40)}` };
    case 'TodoWrite':
      return { kind: 'think', activity: 'Planning the next steps' };
    case 'Skill':
      return { kind: 'tool', activity: `Using ${clip(String(input.skill ?? input.command ?? 'a skill'), 36)}` };
    case 'mcp__iae__map_update':
      return { kind: 'tool', activity: 'Updating the map' };
    case 'mcp__iae__file_notes':
      return { kind: 'tool', activity: 'Noting what files are for' };
    case 'mcp__iae__ask_architect':
      return { kind: 'tool', activity: 'Asking a question' };
    default: {
      const m = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
      if (m) return { kind: 'tool', activity: `Using ${m[1].replace(/[-_]/g, ' ')} ${m[2].replace(/[-_]/g, ' ')}` };
      return { kind: 'tool', activity: `Using ${name}` };
    }
  }
}

// What a shell command is for, in plain words. Builders often run
// `cd "<project>" && …`: the cd says nothing, so it's stripped first. A chain
// ("ls && npm install && npm test") is named by its most telling step; plain
// housekeeping (rm, mkdir, kill, ls…) names it only when nothing else does, so
// "start the server, curl it, rm the log" reads as a server check.
const TELLING: [RegExp, string][] = [
  [/^(npm|pnpm|yarn|bun)\s+(i|install|ci|add)\b|^pip3?\s+install\b|^(poetry|uv)\s+(add|install|sync)\b|^cargo\s+add\b|^go\s+get\b/, 'Installing packages'],
  [/\b(prisma\s+(migrate|db\s+push)|drizzle-kit|knex\s+migrate|alembic\s+upgrade)\b|\brun\s+(db:)?migrat/, 'Running migrations'],
  [/^(npm|pnpm|yarn|bun)\s+(t|test)\b|\brun\s+test|^(npx\s+)?(vitest|jest|mocha|playwright\s+test)\b|^pytest\b|^(go|cargo)\s+test\b/, 'Running tests'],
  [/^(npx\s+)?tsc\b|\brun\s+(typecheck|type-check|tsc|check)\b/, 'Typechecking'],
  [/\brun\s+build\b|^(npx\s+)?(next|vite|tsup|esbuild)\s+build\b|^(go|cargo)\s+build\b|^make\b/, 'Building'],
  [/\brun\s+lint\b|^(npx\s+)?(eslint|prettier|biome)\b/, 'Checking code style'],
  [/^(curl|wget|https?|xh)\b.*(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/, 'Checking the running server'],
  [/\brun\s+(dev|start|serve)\b|^(npx\s+)?(next|vite)\s+dev\b|^(npm|pnpm|yarn)\s+start\b/, 'Starting the dev server'],
  [/^git\s+(add|commit)\b/, 'Committing changes'],
  [/^git\s+(status|diff)\b/, 'Reviewing changes'],
  [/^git\s+(log|show|blame)\b/, 'Reading git history'],
  [/^docker\b|^open\s+-a\s+docker/i, 'Using Docker'],
  [/^(curl|wget|https?|xh)\b/, 'Calling a web address'],
];
const HOUSEKEEPING: [RegExp, string][] = [
  [/^mkdir\b/, 'Creating folders'],
  [/^(rm|rmdir)\b/, 'Removing files'],
  [/^(mv|cp)\b/, 'Moving files'],
  [/^(kill|pkill|killall|lsof|fuser)\b/, 'Stopping a process'],
  [/^(ls|find|tree|cat|head|tail|grep|rg|wc|pwd|which|stat|file|du|echo|printf|sed\s+-n|node\s+(-v|--version)|(npm|pnpm|yarn)\s+(-v|--version|ls|list|view|info))\b/, 'Checking the project'],
];
/** Says nothing about what the command is for. */
const NOISE = /^(cd|pushd|popd|export|unset|set|source|\.|sleep|wait|true|false|:|trap|read|fi|done|esac|then|do|else|exit|return)$/;
/** Words in front of the real command ("nohup node server.js", "timeout 10 curl …", "xargs kill"). */
const WRAPPERS = /^(?:(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)|nohup|time|exec|env|command|builtin|xargs(?:\s+-\S+)*|if|then|do|else|elif|while|until|!|\(|\{|timeout\s+\d+[smh]?)\s+)+/;

/** Splits a shell line into simple commands at && || ; | & and newlines, outside quotes. */
export function splitShell(command: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      cur += ch;
      if (ch === '\\' && quote === '"' && i + 1 < command.length) cur += command[++i];
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\\' && i + 1 < command.length) {
      cur += ch + command[++i];
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    const next = command[i + 1];
    const prev = command[i - 1];
    const isSep = ch === ';' || ch === '\n' || ch === '|' || (ch === '&' && prev !== '>' && next !== '>');
    if (!isSep) {
      cur += ch;
      continue;
    }
    if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) i++;
    out.push(cur);
    cur = '';
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** One simple command without redirections, wrappers or subshell brackets: "node server.js". */
function coreCommand(segment: string): string {
  let c = segment
    .replace(/\s*(?:\d*>>?|&>)\s*(?:"[^"]*"|'[^']*'|[^\s&|;]+)/g, ' ')
    .replace(/\s*\d*>&\d/g, ' ')
    .replace(/\s+<\s*\S+/g, ' ')
    .trim();
  c = c.replace(/^[({]\s*/, '').replace(WRAPPERS, '').replace(/\s*[)}]+$/, '').trim();
  return c;
}

const progOf = (c: string) => c.split(/\s+/)[0] ?? '';

/** "Running tests", "Checking the running server", or the command word and its target (≤ 40 chars). */
export function humanCommand(command: string, root?: string): string {
  const segments = splitShell(withoutRoot(command, root))
    .map(coreCommand)
    .filter((c) => c && !NOISE.test(progOf(c)));
  for (const [re, phrase] of TELLING) if (segments.some((c) => re.test(c))) return phrase;
  const housekeeping = (c: string) => HOUSEKEEPING.find(([re]) => re.test(c));
  // Nothing telling: the first real command, or failing that the first chore.
  const first = segments.find((c) => !housekeeping(c));
  if (!first) return segments.length ? housekeeping(segments[0])![1] : 'Running a command';
  const [prog, ...args] = first.split(/\s+/);
  const target = args.find((a) => !a.startsWith('-'));
  return clip(`Running ${basename(prog)}${target ? ` ${basename(target.replace(/^["']|["']$/g, ''))}` : ''}`, 40);
}

function withoutRoot(command: string, root?: string): string {
  if (!root) return command;
  return command.split(`"${root}"`).join('.').split(`'${root}'`).join('.').split(root).join('.');
}

const CD_PREFIX = /^(?:cd|pushd)\s+(?:"[^"]*"|'[^']*'|(?:\\.|[^\s;&|])+)[ \t]*(?:&&|;|\n)\s*/;

/** The command without a leading `cd … &&` (or `cd …;`, or a cd on its own line), the project root as ".". */
export function stripCd(command: string, root?: string): string {
  let c = withoutRoot(command.trim(), root);
  for (let i = 0; i < 3; i++) {
    const m = CD_PREFIX.exec(c);
    if (!m) break;
    c = c.slice(m[0].length);
  }
  return c;
}

/** The interesting part of a shell command: its first line, without a leading `cd … &&` (and the project root as "."). */
export function shortCommand(command: string, root?: string): string {
  return stripCd(command, root).split('\n')[0].trim();
}

/** Long absolute paths shortened in the middle: /Users/ana/code/crag/server/src/index.ts → /Users/…/src/index.ts. */
export function shortenPaths(text: string, home?: string): string {
  let t = home && home.length > 1 ? text.split(home + '/').join('~/') : text;
  t = t.replace(/(^|[\s"'=(:])(~?\/(?:[^\s"'/;&|)]+\/){3,}[^\s"'/;&|)]*)/g, (_, lead: string, path: string) => {
    if (path.length <= 32) return lead + path;
    const parts = path.split('/');
    const head = parts[0] === '~' ? '~' : `/${parts[1]}`;
    return `${lead}${head}/…/${parts.slice(-2).join('/')}`;
  });
  return t;
}

/** What a permission card says for a shell command: the real command, not the cd in front of it. */
export function commandSummary(command: string, root?: string, home?: string, max = 90): string {
  const lines = stripCd(command, root)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return clip(shortenPaths(command.trim(), home), max);
  return clip(shortenPaths(lines[0], home) + (lines.length > 1 ? ' …' : ''), max);
}

/** Short first line of a text block, for the agent's step log. */
export function stepText(text: string, max = 160): string {
  return clip(text, max);
}
