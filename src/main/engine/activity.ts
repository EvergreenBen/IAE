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

// What a shell command is for, in plain words. A chain ("ls && npm install &&
// npm test") is named by its most telling step.
const COMMAND_PHRASES: [RegExp, string][] = [
  [/^(npm|pnpm|yarn|bun)\s+(i|install|ci|add)\b|^pip3?\s+install\b|^(poetry|uv)\s+(add|install|sync)\b|^cargo\s+add\b|^go\s+get\b/, 'Installing packages'],
  [/\b(prisma\s+(migrate|db\s+push)|drizzle-kit|knex\s+migrate|alembic\s+upgrade)\b|\brun\s+(db:)?migrat/, 'Running migrations'],
  [/^(npm|pnpm|yarn|bun)\s+(t|test)\b|\brun\s+test|^(npx\s+)?(vitest|jest|mocha|playwright\s+test)\b|^pytest\b|^(go|cargo)\s+test\b/, 'Running tests'],
  [/^(npx\s+)?tsc\b|\brun\s+(typecheck|type-check|tsc|check)\b/, 'Typechecking'],
  [/\brun\s+build\b|^(npx\s+)?(next|vite|tsup|esbuild)\s+build\b|^(go|cargo)\s+build\b|^make\b/, 'Building'],
  [/\brun\s+lint\b|^(npx\s+)?(eslint|prettier|biome)\b/, 'Checking code style'],
  [/\brun\s+(dev|start|serve)\b|^(npx\s+)?(next|vite)\s+dev\b|^(npm|pnpm|yarn)\s+start\b/, 'Starting the dev server'],
  [/^git\s+(add|commit)\b/, 'Committing changes'],
  [/^git\s+(status|diff)\b/, 'Reviewing changes'],
  [/^git\s+(log|show|blame)\b/, 'Reading git history'],
  [/^docker\b|^open\s+-a\s+docker/i, 'Using Docker'],
  [/^(mkdir)\b/, 'Creating folders'],
  [/^(rm|rmdir)\b/, 'Removing files'],
  [/^(mv|cp)\b/, 'Moving files'],
  [/^(curl|wget)\b/, 'Calling a web address'],
  [/^(ls|find|tree|cat|head|tail|grep|rg|wc|pwd|which|stat|file|du|echo|printf|sed\s+-n|node\s+(-v|--version)|(npm|pnpm|yarn)\s+(-v|--version|ls|list|view|info))\b/, 'Checking the project'],
];

/** "Running tests", "Installing packages", or the command word and its target (≤ 40 chars). */
export function humanCommand(command: string, root?: string): string {
  const segments = command
    .split(/&&|\|\||;|\||\n/)
    .map((s) => shortCommand(s, root).replace(/^([A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '').trim())
    .filter((s) => s && !/^(cd|export|set|source|\.)\b/.test(s));
  for (const [re, phrase] of COMMAND_PHRASES) if (segments.some((s) => re.test(s))) return phrase;
  const first = segments[0];
  if (!first) return 'Running a command';
  const [prog, ...args] = first.split(/\s+/);
  const target = args.find((a) => !a.startsWith('-'));
  return clip(`Running ${basename(prog)}${target ? ` ${basename(target.replace(/^["']|["']$/g, ''))}` : ''}`, 40);
}

/** The interesting part of a shell command: first line, without a leading `cd … &&`. */
export function shortCommand(command: string, root?: string): string {
  let c = command.split('\n')[0].trim();
  if (root) c = c.split(`"${root}"`).join('.').split(`'${root}'`).join('.').split(root).join('.');
  for (let i = 0; i < 3; i++) {
    const m = /^cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*/.exec(c);
    if (!m) break;
    c = c.slice(m[0].length);
  }
  return c;
}

/** Short first line of a text block, for the agent's step log. */
export function stepText(text: string, max = 160): string {
  return clip(text, max);
}
