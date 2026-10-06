// A simulated engine for browser-only development (`npm run web`) and design
// audits. It is deliberately alive: agents move, files get touched, the lead
// answers and asks. It does NOT call Claude. Keep it in sync with IaeApi.

import type { HomeInfo, IaeBridge, SayMeta } from '@shared/bridge';
import type { EngineEvent } from '@shared/events';
import { applyOps, assignFiles, emptyMap, slug } from '@shared/map';
import { SAMPLE_EXPLAIN, SAMPLE_FILE_TEXT } from './mockFiles';
import {
  DEFAULT_SETTINGS,
  type AgendaItem,
  type AgentInfo,
  type ArchMap,
  type FileEntry,
  type GhostProposal,
  type MapOp,
  type NodeKind,
  type ProjectSnapshot,
  type Settings,
} from '@shared/model';

const ROOT = '/Users/you/Projects/recipe-box';
const now = () => Date.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let seq = 0;
const id = (p: string) => `${p}-${++seq}`;

// ── Sample project: "Recipe Box" ─────────────────────────────────────────────

const N = (
  id: string,
  parentId: string | null,
  label: string,
  kind: NodeKind,
  extra: Partial<{ summary: string; tech: string[]; paths: string[]; status: 'planned' | 'building' | 'built' | 'broken'; order: number }> = {},
): MapOp => ({ op: 'upsertNode', node: { id, parentId, label, kind, status: extra.status ?? 'built', ...extra } });
const E = (from: string, to: string, kind: 'calls' | 'reads' | 'writes' | 'events' | 'depends' | 'auth', label?: string): MapOp => ({
  op: 'upsertEdge',
  edge: { from, to, kind, label },
});

export function sampleMap(): ArchMap {
  return applyOps(emptyMap(), [
    N('web', null, 'Web App', 'client', { summary: 'The Next.js site people use to save, cook and share recipes.', tech: ['Next.js', 'React'], paths: ['apps/web/'], order: 0 }),
    N('web-pages', 'web', 'Pages', 'module', { summary: 'Routes: home, recipe, cook mode, profile.', paths: ['apps/web/app/'] }),
    N('web-ui', 'web', 'UI Kit', 'module', { summary: 'Shared components and design tokens.', paths: ['apps/web/components/'] }),
    N('web-state', 'web', 'Client State', 'module', { summary: 'Query cache and optimistic updates.', paths: ['apps/web/lib/'] }),

    N('api', null, 'API', 'service', { summary: 'Hono server — every read and write goes through here.', tech: ['Hono', 'Node'], paths: ['apps/api/'], order: 1 }),
    N('api-auth', 'api', 'Auth', 'module', { summary: 'Google sign-in, sessions stored in Postgres.', paths: ['apps/api/src/auth/'] }),
    N('api-recipes', 'api', 'Recipes', 'module', { summary: 'CRUD, ingredient parsing, scaling.', paths: ['apps/api/src/recipes/'] }),
    N('api-search', 'api', 'Search', 'module', { summary: 'Full-text search over titles and ingredients.', paths: ['apps/api/src/search/'] }),
    N('api-config', 'api', 'Config', 'config', { summary: 'Environment, secrets and feature flags.', paths: ['apps/api/.env', 'apps/api/src/config.ts'] }),

    N('data', null, 'Data', 'system', { summary: 'Where everything is kept.', order: 2 }),
    N('postgres', 'data', 'Postgres', 'data', { summary: 'Users, recipes, sessions.', tech: ['Postgres', 'Drizzle'], paths: ['apps/api/db/'] }),
    N('redis', 'data', 'Cache', 'data', { summary: 'Hot recipe pages and rate limits.', tech: ['Redis'], status: 'planned' }),
    N('images', 'data', 'Images', 'data', { summary: 'Recipe photos.', tech: ['S3'] }),

    N('jobs', null, 'Jobs', 'queue', { summary: 'Background work: thumbnails, weekly digest.', paths: ['apps/jobs/'], order: 3 }),
    N('jobs-thumbs', 'jobs', 'Thumbnails', 'module', { paths: ['apps/jobs/thumbs/'] }),
    N('jobs-digest', 'jobs', 'Weekly Digest', 'module', { paths: ['apps/jobs/digest/'], status: 'planned' }),

    N('assistant', null, 'Recipe Assistant', 'ai', { summary: 'Claude suggests substitutions and scales recipes.', tech: ['Claude'], paths: ['apps/api/src/assistant/'], status: 'planned', order: 4 }),
    N('google', null, 'Google OAuth', 'external', { order: 5 }),
    N('resend', null, 'Resend', 'external', { summary: 'Transactional email.', order: 6 }),

    E('web', 'api', 'calls', 'REST'),
    E('web-state', 'api-recipes', 'calls', 'REST'),
    E('web-pages', 'api-auth', 'auth', 'session cookie'),
    E('api-auth', 'google', 'auth', 'OAuth'),
    E('api-auth', 'postgres', 'writes', 'sessions'),
    E('api-recipes', 'postgres', 'reads'),
    E('api-search', 'postgres', 'reads', 'tsvector'),
    E('api-recipes', 'jobs', 'events', 'photo uploaded'),
    E('jobs-thumbs', 'images', 'writes'),
    E('jobs-digest', 'resend', 'calls'),
    E('assistant', 'api-recipes', 'reads'),
    E('api-recipes', 'redis', 'reads', 'cache'),
  ]);
}

const SAMPLE_FILES = [
  'apps/web/app/page.tsx',
  'apps/web/app/recipe/[id]/page.tsx',
  'apps/web/app/cook/[id]/page.tsx',
  'apps/web/app/profile/page.tsx',
  'apps/web/components/RecipeCard.tsx',
  'apps/web/components/IngredientList.tsx',
  'apps/web/components/Button.tsx',
  'apps/web/lib/query.ts',
  'apps/web/lib/optimistic.ts',
  'apps/web/next.config.ts',
  'apps/api/src/index.ts',
  'apps/api/src/auth/google.ts',
  'apps/api/src/auth/session.ts',
  'apps/api/src/auth/middleware.ts',
  'apps/api/src/recipes/routes.ts',
  'apps/api/src/recipes/parse-ingredients.ts',
  'apps/api/src/recipes/scale.ts',
  'apps/api/src/search/index.ts',
  'apps/api/src/config.ts',
  'apps/api/.env',
  'apps/api/db/schema.ts',
  'apps/api/db/migrations/0001_init.sql',
  'apps/api/db/migrations/0002_sessions.sql',
  'apps/jobs/thumbs/worker.ts',
  'apps/jobs/digest/README.md',
  'package.json',
  'README.md',
];

const NOTES: Record<string, string> = {
  'apps/api/.env': 'Secrets: database URL, Google client, S3 keys.',
  'apps/api/src/config.ts': 'Reads .env, validates it, exports typed config.',
  'apps/api/src/auth/session.ts': 'Creates and rotates session rows in Postgres.',
  'apps/api/src/auth/middleware.ts': 'Rejects requests without a valid session cookie.',
  'apps/api/db/schema.ts': 'Drizzle table definitions for users, recipes, sessions.',
  'apps/web/lib/query.ts': 'TanStack Query client and fetch helpers.',
  'apps/api/src/index.ts': 'Starts the server and mounts every route.',
  'apps/api/src/recipes/scale.ts': 'Scales servings and rounds to kitchen fractions.',
  'apps/web/components/RecipeCard.tsx': 'The recipe tile used in every grid.',
  'apps/api/db/migrations/0002_sessions.sql': 'Adds the sessions table and its expiry index.',
};

function sampleFiles(map: ArchMap): FileEntry[] {
  return assignFiles(
    map,
    SAMPLE_FILES.map((path, i) => ({ path, size: 400 + ((i * 937) % 5000), mtime: now() - i * 3_600_000, nodeId: null, note: NOTES[path] })),
  );
}

// Sample contents (and the explanations below) live in ./mockFiles.ts.
const FILE_TEXT: Record<string, string> = { ...SAMPLE_FILE_TEXT };

const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|mp4|mov|sqlite|db)$/i;

// ── The mock bridge ──────────────────────────────────────────────────────────

export function createMockBridge(): IaeBridge {
  const listeners = new Set<(e: EngineEvent) => void>();
  const emit = (e: EngineEvent) => {
    for (const l of listeners) l(e);
  };
  let settings: Settings = { ...DEFAULT_SETTINGS };
  let map = emptyMap();
  let timers: ReturnType<typeof setTimeout>[] = [];
  const later = (ms: number, fn: () => void) => timers.push(setTimeout(fn, ms));

  const agenda: AgendaItem[] = [];
  const pushAgenda = (item: Omit<AgendaItem, 'id' | 'createdAt' | 'status'>) => {
    const full: AgendaItem = { ...item, id: id('q'), createdAt: now(), status: 'open' };
    agenda.push(full);
    emit({ type: 'agenda/upsert', item: full });
    return full;
  };

  async function leadSays(text: string, delay = 650) {
    const turnId = id('turn');
    emit({ type: 'lead/state', state: 'thinking' });
    await sleep(delay);
    const words = text.split(/(\s+)/);
    for (const w of words) {
      emit({ type: 'lead/delta', turnId, text: w });
      await sleep(28);
    }
    emit({ type: 'lead/done', turnId, text });
    emit({ type: 'lead/state', state: 'idle' });
    emit({ type: 'transcript/append', entry: { id: id('t'), at: now(), who: 'lead', text } });
  }

  function runBuilder(agent: Omit<AgentInfo, 'status' | 'startedAt'>, steps: { path: string; activity: string; nodeId: string }[], result: string) {
    let a: AgentInfo = { ...agent, status: 'starting', startedAt: now() };
    emit({ type: 'agent/upsert', agent: a });
    steps.forEach((st, i) => {
      later(1200 + i * 2600, () => {
        a = { ...a, status: 'working', nodeId: st.nodeId, activity: st.activity, file: st.path };
        emit({ type: 'agent/upsert', agent: a });
        emit({ type: 'agent/step', agentId: a.id, step: { at: now(), kind: 'edit', text: st.activity, path: st.path } });
        emit({ type: 'files/touched', path: st.path, agentId: a.id, action: 'edit' });
      });
    });
    later(1200 + steps.length * 2600 + 800, () => {
      a = { ...a, status: 'done', activity: undefined, file: undefined, endedAt: now(), result };
      emit({ type: 'agent/upsert', agent: a });
      later(4000, () => emit({ type: 'agent/remove', agentId: a.id }));
    });
  }

  function startSampleSession() {
    // A builder already at work, and a decision waiting where it matters.
    runBuilder(
      { id: 'ada', name: 'Ada', role: 'builder', hue: 0, task: 'Add sliding session expiry', nodeId: 'api-auth' },
      [
        { path: 'apps/api/src/auth/session.ts', activity: 'Editing session.ts', nodeId: 'api-auth' },
        { path: 'apps/api/db/migrations/0002_sessions.sql', activity: 'Writing a migration', nodeId: 'postgres' },
        { path: 'apps/api/src/auth/middleware.ts', activity: 'Wiring the middleware', nodeId: 'api-auth' },
      ],
      'Sessions now slide forward on every request; added an index on expires_at.',
    );
    runBuilder(
      { id: 'kit', name: 'Kit', role: 'builder', hue: 1, task: 'Cook mode: keep screen awake', nodeId: 'web-pages' },
      [
        { path: 'apps/web/app/cook/[id]/page.tsx', activity: 'Editing cook page', nodeId: 'web-pages' },
        { path: 'apps/web/lib/optimistic.ts', activity: 'Reading optimistic.ts', nodeId: 'web-state' },
      ],
      'Cook mode requests a wake lock and releases it on exit.',
    );
    later(2400, () =>
      pushAgenda({
        kind: 'decision',
        prompt: 'Sessions live in Postgres. When the mobile app lands, keep cookie sessions or move to short-lived tokens?',
        why: 'Ada is about to finalise the session schema.',
        options: ['Short-lived tokens + refresh', 'Keep cookie sessions', 'Decide later'],
        nodeId: 'api-auth',
        blocking: ['ada'],
        priority: 0.9,
      }),
    );
    later(900, () => void leadSays("Ada is reworking session expiry in Auth and Kit is on cook mode. One thing I need from you while they work — it's pinned on Auth."));
  }

  function snapshot(root: string, name: string, isNew: boolean): ProjectSnapshot {
    map = isNew ? emptyMap() : sampleMap();
    return {
      project: { root, name, isNew, lastOpenedAt: now(), summary: isNew ? undefined : 'Save, cook and share recipes.' },
      map,
      files: isNew ? [] : sampleFiles(map),
      agenda: [],
      agents: [],
      decisions: [],
      transcript: [],
    };
  }

  // Tiny "sketch model": keyword → node. The real one is Claude (engine/sketcher).
  const SKETCH: [RegExp, string, NodeKind][] = [
    [/\b(meal ?plan|planner|weekly plan)/i, 'Meal Planner', 'module'],
    [/\b(shopping|grocery|groceries)/i, 'Shopping List', 'module'],
    [/\b(mobile|ios|android|app store)/i, 'Mobile App', 'client'],
    [/\b(payments?|stripe|subscription|billing)/i, 'Billing', 'module'],
    [/\b(notifications?|push)/i, 'Notifications', 'service'],
    [/\b(analytics|metrics|tracking)/i, 'Analytics', 'external'],
    [/\b(nutrition|calories|macros)/i, 'Nutrition', 'module'],
  ];

  const bridge: IaeBridge = {
    runtime: 'mock',
    onEvent(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    async getHome(): Promise<HomeInfo> {
      return {
        recent: [
          { root: ROOT, name: 'Recipe Box', isNew: false, lastOpenedAt: now() - 3_600_000, summary: 'Save, cook and share recipes.' },
          { root: '/Users/you/Projects/trailhead', name: 'Trailhead', isNew: false, lastOpenedAt: now() - 86_400_000 * 3, summary: 'Hiking trip planner for small groups.' },
        ],
        defaultParent: '/Users/you/IAE Projects',
        claude: 'ready',
      };
    },
    async pickFolder() {
      return ROOT;
    },
    async openProject(root) {
      timers.forEach(clearTimeout);
      timers = [];
      const name = root === ROOT ? 'Recipe Box' : root.split('/').pop() || 'Project';
      const snap = snapshot(root, name, false);
      emit({ type: 'project/opened', snapshot: snap });
      startSampleSession();
      return snap;
    },
    async createProject(name) {
      timers.forEach(clearTimeout);
      timers = [];
      const snap = snapshot(`/Users/you/IAE Projects/${slug(name)}`, name, true);
      emit({ type: 'project/opened', snapshot: snap });
      later(500, () => void leadSays(`A blank page for ${name}. Tell me who it's for and the one thing they should be able to do on day one.`));
      return snap;
    },
    async closeProject() {
      timers.forEach(clearTimeout);
      timers = [];
      emit({ type: 'project/closed' });
    },
    async say(text: string, meta?: SayMeta) {
      emit({ type: 'transcript/append', entry: { id: id('t'), at: now(), who: 'user', text } });
      if (meta?.agendaId) return bridge.answer(meta.agendaId, text);
      const hits = SKETCH.filter(([re]) => re.test(text));
      if (hits.length) {
        const ops: MapOp[] = hits.map(([, label, kind]) => ({
          op: 'upsertNode',
          node: { id: slug(label), parentId: kind === 'client' || kind === 'external' ? null : 'api', label, kind, status: 'planned', summary: `Planned from: “${text.slice(0, 60)}”` },
        }));
        ops.push(...hits.map(([, label]) => ({ op: 'upsertEdge' as const, edge: { from: slug(label), to: 'api-recipes', kind: 'calls' as const } })));
        map = applyOps(map, ops);
        emit({ type: 'map/ops', ops, source: 'lead' });
        emit({ type: 'focus', nodeId: slug(hits[0][1]), mode: 'show' });
        await leadSays(`I've sketched ${hits.map((h) => h[1]).join(' and ')} next to Recipes. Should it share the recipe data model, or keep its own copy so it can work offline?`);
        pushAgenda({
          kind: 'decision',
          prompt: `Should ${hits[0][1]} reuse the recipe model directly, or snapshot recipes so edits don't change past plans?`,
          options: ['Snapshot (stable history)', 'Reuse live recipes'],
          nodeId: slug(hits[0][1]),
          priority: 0.7,
        });
      } else {
        await leadSays('Got it. I would start with the data shape — what is the one thing a user must never lose?');
      }
    },
    async draft(draftId, text) {
      const proposals: GhostProposal[] = SKETCH.filter(([re]) => re.test(text)).map(([, label, kind]) => ({
        key: slug(label),
        label,
        kind,
        nearNodeId: kind === 'client' || kind === 'external' ? null : 'api',
        connectsTo: ['api-recipes'],
        confidence: 0.7,
        source: 'sketch',
      }));
      await sleep(250);
      emit({ type: 'ghost/proposals', draftId, proposals });
    },
    async interrupt() {
      emit({ type: 'lead/state', state: 'idle' });
    },
    async answer(agendaId, answer) {
      const item = agenda.find((a) => a.id === agendaId);
      if (!item) return;
      item.status = 'answered';
      item.answer = answer;
      emit({ type: 'agenda/remove', id: agendaId });
      emit({ type: 'decision/add', decision: { id: id('d'), title: answer, rationale: item.prompt, nodeId: item.nodeId, at: now() } });
      await leadSays(`${answer} — noted on ${item.nodeId ? (map.nodes[item.nodeId]?.label ?? 'the map') : 'the map'}. I'll brief Ada so the schema matches.`, 400);
    },
    async dismiss(agendaId) {
      emit({ type: 'agenda/remove', id: agendaId });
    },
    async setView() {},
    async setPresence() {},
    async applyOps(ops) {
      map = applyOps(map, ops);
      emit({ type: 'map/ops', ops, source: 'user' });
    },
    async readFile(path) {
      if (BINARY.test(path)) return { path, content: '', unreadable: true, size: 48_213, language: 'binary' };
      const content =
        FILE_TEXT[path] ??
        `// ${path}\n// (mock content — run the desktop app to see real files)\n\nexport function example() {\n  return 'Recipe Box';\n}\n`;
      const ext = path.split('.').pop() ?? '';
      const language = path.endsWith('.env')
        ? 'env'
        : ({ ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', sql: 'sql', md: 'markdown', json: 'json', py: 'python', css: 'css', html: 'html' } as Record<string, string>)[ext] ??
          'text';
      return { path, content, size: content.length, language };
    },
    async writeFile(path, content) {
      FILE_TEXT[path] = content;
    },
    async explainFile(path) {
      await sleep(SAMPLE_EXPLAIN[path] ? 1100 : 400);
      return SAMPLE_EXPLAIN[path] ?? NOTES[path] ?? `Part of ${path.split('/').slice(0, -1).join('/')}.`;
    },
    async revealFile() {},
    async stopAgent(agentId) {
      emit({ type: 'agent/remove', agentId });
    },
    async resolvePermission(pid) {
      emit({ type: 'permission/resolved', id: pid });
    },
    async listCommands() {
      return [
        { name: 'review', description: 'Review the current changes' },
        {
          name: 'code-review',
          description: 'Review the current diff, or a PR number/branch/path target, for correctness bugs',
          argumentHint: '[low|medium|high|xhigh|max|ultra] [--comment] [--fix] [--max-findings <n>] [target]',
        },
        { name: 'security-review', description: 'Security review of pending changes' },
        { name: 'init', description: 'Write a CLAUDE.md for this codebase' },
        { name: 'simplify', description: 'Simplify recently changed code' },
      ];
    },
    async runCommand(command) {
      runBuilder(
        { id: id('agent'), name: 'Rho', role: 'builder', hue: 2, task: command, nodeId: null },
        [{ path: 'apps/api/src/index.ts', activity: `Running ${command}`, nodeId: 'api' }],
        `${command} finished.`,
      );
    },
    async getSettings() {
      return settings;
    },
    async setSettings(patch) {
      settings = { ...settings, ...patch, voice: { ...settings.voice, ...(patch.voice ?? {}) } };
      emit({ type: 'settings/changed', settings });
      return settings;
    },
  };
  return bridge;
}
