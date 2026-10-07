// Arxitect's own gate in front of a builder's shell (and, in "ask" mode, its file
// writes). Claude Code consults canUseTool only when no allow rule matches,
// and many people allow Bash(*) in ~/.claude/settings.json, which would turn
// "ask before running commands" into "never ask". A PreToolUse hook runs
// before those rules, so the person's ✓/✕ on the map stays in charge.
// Plainly read-only commands (ls, git status, the project's tests…) pass.

import type { HookCallbackMatcher, HookJSONOutput, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { Autonomy } from '../../shared/model';
import { splitShell, stripCd } from './activity';

const READ_ONLY = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'pwd', 'echo', 'printf', 'grep', 'egrep', 'rg', 'which', 'type', 'file', 'stat', 'du', 'df',
  'tree', 'sort', 'uniq', 'cut', 'diff', 'cmp', 'true', 'date', 'basename', 'dirname', 'realpath', 'cd', 'test', '[', '[[', 'jq', 'tr',
  'column', 'nl', 'read', 'shasum', 'md5', 'tsc', 'vitest', 'jest', 'pytest',
]);
/** Shell structure around commands: loops and conditionals are fine if what they run is. */
const LEAD_KEYWORDS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{', '(']);
const SAFE_SEGMENTS = new Set(['done', 'fi', 'esac', '}', ')', 'else']);
const GIT_READ = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame', 'grep', 'describe', 'shortlog']);
const PKG = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const PKG_SCRIPTS = /^(test|typecheck|type-check|check|lint|build|tsc|vitest)(:[\w-]+)?$/;
const NPX_OK = new Set(['tsc', 'vitest', 'jest', 'eslint']);
const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

/** Strips harmless redirections; anything else that writes or substitutes makes it unsafe. */
function cleanRedirects(cmd: string): string | null {
  if (/[`]|\$\(|<\(|>\(/.test(cmd)) return null;
  const s = cmd.replace(/\s*(?:\d?>&\d|&?\d?>\s*\/dev\/null)/g, ' ');
  return /[<>]/.test(s) ? null : s;
}

function segmentSafe(seg: string): boolean {
  const words = seg.trim().split(/\s+/).filter(Boolean);
  while (words.length && (LEAD_KEYWORDS.has(words[0]) || /^[A-Za-z_][A-Za-z0-9_]*=\S*$/.test(words[0]))) words.shift();
  if (!words.length || SAFE_SEGMENTS.has(words[0])) return true;
  // A loop header only names what to iterate over ("for f in a.ts b.ts").
  if (words[0] === 'for' || words[0] === 'select') return true;
  const prog = words[0].replace(/^.*\//, '');
  const args = words.slice(1);
  if (prog === 'find') return !args.some((a) => /^-(exec|execdir|ok|okdir|delete|fprint|fprintf|fls)$/.test(a));
  if (prog === 'sed') return args[0] === '-n' && !args.some((a) => /^-i/.test(a));
  if (prog === 'git') return GIT_READ.has(args.find((a) => !a.startsWith('-')) ?? '') && !args.includes('--output');
  if (prog === 'node') return args.length === 1 && /^(-v|--version)$/.test(args[0]);
  if (PKG.has(prog)) {
    const [a, b] = args;
    if (a === '-v' || a === '--version' || a === 'ls' || a === 'list' || a === 'view' || a === 'info' || a === 'outdated') return true;
    if (a === 'test' || a === 't') return true;
    return a === 'run' && !!b && PKG_SCRIPTS.test(b);
  }
  if (prog === 'npx') {
    const tool = args.find((a) => !a.startsWith('-'));
    return !!tool && NPX_OK.has(tool) && !args.includes('--fix') && !args.some((a) => a === '-y' || a === '--yes');
  }
  if (prog === 'eslint') return !args.includes('--fix');
  if (prog === 'prettier') return args.includes('--check') && !args.includes('--write');
  if (prog === 'cargo') return ['check', 'test', 'build', 'clippy'].includes(args[0] ?? '');
  if (prog === 'go') return ['test', 'vet', 'build'].includes(args[0] ?? '');
  return READ_ONLY.has(prog);
}

/** True when a shell command only reads, or runs the project's own checks. */
export function isReadOnlyCommand(command: string): boolean {
  const cmd = cleanRedirects(command.trim());
  if (cmd === null || !cmd.trim()) return false;
  if (/(^|[^&])&($|[^&>])/.test(cmd)) return false; // backgrounding
  return cmd.split(/&&|\|\||;|\||\n/).every(segmentSafe);
}

/**
 * "npm install", "pnpm add": what an "always allow" on a command covers for the
 * rest of the job. A leading `cd <project> &&` doesn't count (it would make one
 * "always" cover every command behind the same cd), and a chain only ever
 * covers itself.
 */
export function commandKey(command: string): string {
  const rest = stripCd(command);
  if (splitShell(rest).length > 1) return rest;
  const words = rest.split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  return words.slice(0, 2).join(' ');
}

export type AskPermission = (toolName: string, input: Record<string, unknown>, signal: AbortSignal) => Promise<PermissionResult>;

const decide = (permissionDecision: 'allow' | 'deny', reason?: string): HookJSONOutput => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, ...(reason ? { permissionDecisionReason: reason } : {}) },
});

/**
 * PreToolUse hooks for a builder: in "edits" every non-read-only shell command
 * goes to the person; in "ask" file writes do too. "full" has none.
 */
export function gateHooks(autonomy: Autonomy, ask: AskPermission): HookCallbackMatcher[] {
  if (autonomy === 'full') return [];
  const always = new Set<string>();
  const matcher = autonomy === 'ask' ? ['Bash', ...WRITE_TOOLS].join('|') : 'Bash';
  return [
    {
      matcher,
      // The person may take a while to answer; a hook that times out must not let the command through.
      timeout: 24 * 60 * 60,
      hooks: [
        async (input, _id, { signal }) => {
          if (input.hook_event_name !== 'PreToolUse') return {};
          const toolInput = (input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {}) as Record<string, unknown>;
          const isBash = input.tool_name === 'Bash';
          const command = isBash ? String(toolInput.command ?? '') : '';
          const key = isBash ? `Bash:${commandKey(command)}` : input.tool_name;
          if ((isBash && isReadOnlyCommand(command)) || always.has(key)) return decide('allow');
          const r = await ask(input.tool_name, toolInput, signal);
          if (r.behavior !== 'allow') return decide('deny', r.message || 'The person declined this.');
          if (r.updatedPermissions?.length) always.add(key);
          return decide('allow');
        },
      ],
    },
  ];
}
