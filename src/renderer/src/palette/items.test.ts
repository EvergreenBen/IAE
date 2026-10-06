import { describe, expect, it } from 'vitest';
import { namesCommand, parseSlash, rank, type PaletteItem } from './items';

const noop = () => undefined;
const items: PaletteItem[] = [
  { id: 'cmd:meaning', section: 'commands', title: 'Meaning mode', keywords: 'explain notes', run: noop },
  { id: 'cmd:settings', section: 'commands', title: 'Settings', keywords: 'autonomy models', run: noop },
  { id: 'node:api', section: 'nodes', title: 'API', run: noop },
  { id: 'node:api-auth', section: 'nodes', title: 'Auth', hint: 'API', quiet: true, run: noop },
  { id: 'file:session', section: 'files', title: 'session.ts', hint: 'apps/api/src/auth/', path: 'apps/api/src/auth/session.ts', run: noop },
  { id: 'file:env', section: 'files', title: '.env', hint: 'apps/api/', path: 'apps/api/.env', run: noop },
  { id: 'claude:review', section: 'claude', title: '/review', keywords: 'Review the current changes', run: noop },
];

describe('rank', () => {
  it('shows a short, fixed menu for an empty query (no files, nothing quiet)', () => {
    const groups = rank(items, '');
    expect(groups.map((g) => g.section)).toEqual(['commands', 'nodes', 'claude']);
    expect(groups.find((g) => g.section === 'nodes')!.rows.map((r) => r.item.id)).toEqual(['node:api']);
  });

  it('puts the section with the best match first', () => {
    const groups = rank(items, 'auth');
    expect(groups[0].section).toBe('nodes');
    expect(groups[0].rows[0].item.id).toBe('node:api-auth');
  });

  it('finds files by name and highlights inside the name', () => {
    const groups = rank(items, 'sess');
    const files = groups.find((g) => g.section === 'files')!;
    expect(files.rows[0].item.id).toBe('file:session');
    expect(files.rows[0].titleHits).toEqual([0, 1, 2, 3]);
  });

  it('finds .env', () => {
    expect(rank(items, 'env')[0].rows[0].item.id).toBe('file:env');
  });

  it('matches keywords with a penalty and no highlight', () => {
    const groups = rank(items, 'autonomy');
    expect(groups[0].rows[0].item.id).toBe('cmd:settings');
    expect(groups[0].rows[0].titleHits).toEqual([]);
  });

  it('returns nothing for nonsense', () => {
    expect(rank(items, 'zzqx')).toEqual([]);
  });
});

// Claude Code's commands and skills as the real app lists them: some with long, wordy descriptions.
const CLAUDE: [string, string][] = [
  ['review', 'Review a pull request'],
  ['code-review', 'Review the current diff, or a PR number/branch/path target, for correctness bugs at the given effort level'],
  ['security-review', 'Complete a security review of the pending changes on the current branch'],
  ['init', 'Initialize a new CLAUDE.md file with codebase documentation'],
  ['simplify', 'Review the changed code for reuse, simplification, efficiency, and altitude cleanups, then apply the fixes'],
  ['update-config', 'Use this skill to configure the Claude Code harness via settings.json. Automated behaviors ("from now on when X", "each time X", "whenever X", "before/after X") require hooks configured in settings.json - the harness executes these, not Claude, so memory/preferences cannot fulfill them. Also use for: permissions ("allow X", "add permission", "move permission to"), env vars ("set X=Y"), hook troubleshooting, or any changes to settings.json/settings.local.json files.'],
  ['fewer-permission-prompts', 'Scan your transcripts for common read-only Bash and MCP tool calls, then add a prioritized allowlist to project settings'],
  ['keybindings-help', 'Use when the user wants to customize keyboard shortcuts, rebind keys, add chord bindings'],
  ['loop', 'Run a prompt or slash command on a recurring interval (e.g. /loop 5m /foo). Omit the interval to let the model self-pace. - When the user wants to set up a recurring task, poll for status, or run something repeatedly on an interval (e.g. "check the deploy every 5 minutes", "keep running /babysit-prs"). Do NOT invoke for one-off tasks.'],
  ['schedule', 'Create, update, list, or run scheduled cloud agents (routines) that execute on a cron schedule'],
  ['claude-api', 'Reference for the Claude API / Anthropic SDK — model ids, pricing, params, streaming, tool use, MCP, agents, caching, token counting, model migration. TRIGGER — read BEFORE opening the target file; whenever: the prompt names Claude/Anthropic in any form; the user asks about an LLM (pricing/model choice/limits/caching) — never answer from memory; OR the task is LLM-shaped with provider unstated (agent/MCP/tool-definition/multi-agent/RAG/LLM-judge/computer-use; generate/summarize/extract/classify/rewrite/converse over NL; debugging refusals/cutoffs/streaming/tool-calls/tokens).'],
  ['dataviz', 'Use this skill whenever you are about to create ANY chart, graph, plot, dashboard, or data visualization, in ANY output medium — an HTML or React artifact, inline SVG, plotting code in any library (matplotlib, plotly, d3, Recharts, …), an image/PNG you will render and upload, or a chart shared into Slack. Read it BEFORE writing the first line of chart code, choosing chart colors, building a stat tile / meter / KPI row, or laying out a dashboard.'],
  ['compact', 'Clear conversation history but keep a summary in context'],
  ['pr-comments', 'Get comments from a GitHub pull request'],
  ['statusline', 'Set up the status line UI'],
];
const withClaude: PaletteItem[] = [
  { id: 'node:postgres', section: 'nodes', title: 'Postgres', hint: 'Data', keywords: 'Trips, members data', run: noop },
  { id: 'node:sync', section: 'nodes', title: 'Sync', hint: 'Trips API', keywords: 'Realtime sync endpoints module', run: noop },
  { id: 'file:sync', section: 'files', title: 'sync.ts', hint: 'apps/api/src/', path: 'apps/api/src/sync.ts', run: noop },
  ...CLAUDE.map(([name, description]): PaletteItem => ({ id: `claude:${name}`, section: 'claude', title: `/${name}`, hint: description, keywords: description, run: noop })),
];
const claudeRows = (q: string, loose = false) => rank(withClaude, q, loose).find((g) => g.section === 'claude')?.rows.map((r) => r.item.title) ?? [];

describe('Claude Code commands in search', () => {
  it('stay out of searches for the map ("postgres", "sync endp")', () => {
    expect(claudeRows('postgres')).toEqual([]);
    expect(claudeRows('sync endp')).toEqual([]);
    expect(claudeRows('trips')).toEqual([]); // used to find dataviz, update-config, claude-api and loop by stray initials
    expect(claudeRows('auth')).toEqual([]);
    const groups = rank(withClaude, 'sync endp');
    expect(groups.map((g) => g.section)).toEqual(['nodes']);
  });

  it('show for a query that names them, by prefix, word start or initials', () => {
    // Names first; a description that says the word comes after ("simplify: Review the changed code…").
    expect(claudeRows('review')).toEqual(['/review', '/code-review', '/security-review', '/simplify']);
    expect(claudeRows('sec')).toEqual(['/security-review']);
    expect(claudeRows('cr')).toContain('/code-review');
    expect(claudeRows('schedul')).toEqual(['/schedule']);
  });

  it('come after nodes and files', () => {
    const items: PaletteItem[] = [...withClaude, { id: 'node:loops', section: 'nodes', title: 'Loop Detector', run: noop }];
    expect(rank(items, 'loop').map((g) => g.section)).toEqual(['nodes', 'claude']);
  });

  it('browsing with "/" stays forgiving', () => {
    expect(claudeRows('eview')).toEqual([]);
    expect(claudeRows('eview', true)).toContain('/review');
  });

  it('namesCommand reads names and descriptions by word starts', () => {
    expect(namesCommand('stat', '/statusline')).toBe('name');
    expect(namesCommand('pull req', '/review', 'Review a pull request')).toBe('description');
    expect(namesCommand('postgres', '/update-config', 'configure hooks, permissions and env vars')).toBeNull();
  });
});

describe('parseSlash', () => {
  it('splits a command from its arguments', () => {
    expect(parseSlash('/review 142')).toEqual({ name: 'review', args: '142' });
    expect(parseSlash('/rev')).toEqual({ name: 'rev', args: '' });
    expect(parseSlash('/')).toEqual({ name: '', args: '' });
    expect(parseSlash('review')).toBeNull();
  });
});
