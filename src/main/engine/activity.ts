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
    case 'Bash': {
      const cmd = typeof input.command === 'string' ? shortCommand(input.command, root) : '';
      return { kind: 'bash', activity: cmd ? `Running ${clip(cmd, 42)}` : 'Running a command' };
    }
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
