// An instant first map for an existing repo, from folder names and manifests.
// It is a credible first draft drawn in well under 200ms; the cartographer
// replaces it with a real hierarchy. Pure except for buildHeuristicMap(), which
// reads a handful of manifests.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyOps, emptyMap, slug } from '../../shared/map';
import type { ArchMap, MapOp, NodeKind } from '../../shared/model';

const CONTAINERS = new Set(['apps', 'packages', 'services', 'libs', 'modules', 'crates', 'projects']);

const NAME_KINDS: [RegExp, NodeKind][] = [
  [/^(web|client|frontend|front-end|app|ui|www|site|website|mobile|ios|android|desktop|renderer|extension|dashboard|admin|landing|docs-site)$/, 'client'],
  [/^(api|apis|server|backend|back-end|services?|functions|lambdas?|edge|gateway|main|bff|graphql|rpc)$/, 'service'],
  [/^(db|database|databases|prisma|migrations?|supabase|drizzle|schema|sql|seeds?|storage)$/, 'data'],
  [/^(infra|infrastructure|\.github|\.circleci|\.gitlab|docker|terraform|deploy|deployment|k8s|kubernetes|helm|ops|pulumi|cdk|ci)$/, 'infra'],
  [/^(config|configs|configuration|settings|\.config|env)$/, 'config'],
  [/^(workers?|jobs?|queues?|cron|crons|tasks|scheduler|consumers?)$/, 'queue'],
  [/^(ai|ml|llm|agents?|prompts|models?-ai)$/, 'ai'],
];

const TESTS = /^(tests?|__tests__|e2e|specs?|cypress|playwright)$/;
const DOCS = /^(docs?|documentation)$/;
const SCRIPTS = /^(scripts|bin|tools)$/;
const CHILD_SKIP = /^(public|static|assets|fixtures|__mocks__|\..*)$/;
const ROOT_INFRA_FILE = /^(dockerfile.*|docker-compose.*\.ya?ml|compose\.ya?ml|fly\.toml|vercel\.json|netlify\.toml|render\.ya?ml|procfile|railway\.json|app\.ya?ml|.*\.tf)$/i;
const ACRONYMS = new Set(['api', 'ui', 'db', 'cli', 'sdk', 'ai', 'ml', 'ci', 'cd', 'sql', 'llm', 'bff', 'cdk', 'k8s', 'www', 'rpc']);

const KIND_ORDER: Record<NodeKind, number> = { client: 0, service: 1, ai: 2, queue: 3, data: 4, system: 5, external: 6, module: 7, config: 8, infra: 9 };

const TECH: [RegExp, string, NodeKind?][] = [
  [/^next$/, 'Next.js', 'client'],
  [/^(react-native|expo)$/, 'React Native', 'client'],
  [/^nuxt$/, 'Nuxt', 'client'],
  [/^vue$/, 'Vue', 'client'],
  [/^(svelte|@sveltejs\/kit)$/, 'Svelte', 'client'],
  [/^@angular\/core$/, 'Angular', 'client'],
  [/^electron$/, 'Electron', 'client'],
  [/^react$/, 'React', 'client'],
  [/^hono$/, 'Hono', 'service'],
  [/^express$/, 'Express', 'service'],
  [/^fastify$/, 'Fastify', 'service'],
  [/^@nestjs\/core$/, 'NestJS', 'service'],
  [/^koa$/, 'Koa', 'service'],
  [/^@trpc\/server$/, 'tRPC', 'service'],
  [/^(prisma|@prisma\/client)$/, 'Prisma'],
  [/^drizzle-orm$/, 'Drizzle'],
  [/^(pg|postgres)$/, 'Postgres'],
  [/^(mongoose|mongodb)$/, 'MongoDB'],
  [/^(redis|ioredis)$/, 'Redis'],
  [/^@supabase\/supabase-js$/, 'Supabase'],
  [/^(bullmq|bull)$/, 'BullMQ', 'queue'],
  [/^stripe$/, 'Stripe'],
  [/^@anthropic-ai\/(sdk|claude-agent-sdk)$/, 'Claude'],
  [/^openai$/, 'OpenAI'],
  [/^vite$/, 'Vite'],
  [/^tailwindcss$/, 'Tailwind'],
];
const PY_TECH: [RegExp, string, NodeKind][] = [
  [/\bdjango\b/i, 'Django', 'service'],
  [/\bfastapi\b/i, 'FastAPI', 'service'],
  [/\bflask\b/i, 'Flask', 'service'],
  [/\bcelery\b/i, 'Celery', 'queue'],
];

export const MANIFESTS = ['package.json', 'pyproject.toml', 'requirements.txt', 'go.mod', 'Cargo.toml'];

export function humanize(name: string): string {
  const words = name
    .replace(/^[@.]+/, '')
    .replace(/[-_.]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return name;
  return words
    .slice(0, 3)
    .map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
}

export function kindForName(name: string): NodeKind | null {
  const n = name.toLowerCase();
  for (const [re, kind] of NAME_KINDS) if (re.test(n)) return kind;
  return null;
}

interface ManifestInfo {
  tech: string[];
  kindHint?: NodeKind;
}

/** Tech and a kind hint from the manifests found in one directory. */
export function readManifestInfo(dir: string, manifests: Record<string, string>): ManifestInfo {
  const at = (f: string) => manifests[dir ? `${dir}/${f}` : f];
  const tech: string[] = [];
  let kindHint: NodeKind | undefined;
  const pkg = at('package.json');
  if (pkg) {
    try {
      const j = JSON.parse(pkg) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      const deps = Object.keys({ ...(j.dependencies ?? {}), ...(j.devDependencies ?? {}) });
      for (const [re, label, hint] of TECH) {
        if (!deps.some((d) => re.test(d))) continue;
        if (!tech.includes(label)) tech.push(label);
        if (hint && !kindHint) kindHint = hint;
      }
    } catch {
      // malformed package.json — ignore
    }
  }
  const py = (at('pyproject.toml') ?? '') + '\n' + (at('requirements.txt') ?? '');
  for (const [re, label, hint] of PY_TECH) {
    if (!re.test(py)) continue;
    tech.push(label);
    kindHint ??= hint;
  }
  if (at('go.mod')) tech.push('Go');
  if (at('Cargo.toml')) tech.push('Rust');
  if (tech.length && !pkg && py.trim() && !tech.includes('Python')) tech.push('Python');
  return { tech: tech.slice(0, 3), kindHint };
}

interface Unit {
  dir: string;
  name: string;
  /** Container dir ('apps', 'packages', …) or '' for top-level dirs. */
  group: string;
}

interface DirIndex {
  /** dir → immediate subdirectory names */
  subdirs: Map<string, Set<string>>;
  /** dir → number of files at any depth below it */
  counts: Map<string, number>;
  /** dir → file names directly in it */
  direct: Map<string, string[]>;
}

function indexDirs(paths: string[]): DirIndex {
  const subdirs = new Map<string, Set<string>>();
  const counts = new Map<string, number>();
  const direct = new Map<string, string[]>();
  for (const p of paths) {
    const parts = p.split('/');
    const dirParts = parts.slice(0, -1);
    const dir = dirParts.join('/');
    const list = direct.get(dir) ?? [];
    list.push(parts[parts.length - 1]);
    direct.set(dir, list);
    counts.set('', (counts.get('') ?? 0) + 1);
    for (let i = 0; i < dirParts.length; i++) {
      const parent = dirParts.slice(0, i).join('/');
      const here = dirParts.slice(0, i + 1).join('/');
      counts.set(here, (counts.get(here) ?? 0) + 1);
      const set = subdirs.get(parent) ?? new Set();
      set.add(dirParts[i]);
      subdirs.set(parent, set);
    }
  }
  return { subdirs, counts, direct };
}

const subdirsOf = (ix: DirIndex, dir: string): string[] => [...(ix.subdirs.get(dir) ?? [])].sort();

/**
 * Builds the first-draft map. `paths` are project-relative POSIX file paths;
 * `manifests` maps manifest paths (e.g. "apps/web/package.json") to contents.
 */
export function heuristicMap(paths: string[], manifests: Record<string, string> = {}, now = Date.now()): ArchMap {
  const ix = indexDirs(paths);
  const ops: MapOp[] = [];
  const used = new Set<string>();
  const uniqueId = (wanted: string, fallbackPrefix: string): string => {
    let id = slug(wanted);
    if (used.has(id)) id = slug(`${fallbackPrefix}-${wanted}`);
    for (let i = 2; used.has(id); i++) id = `${slug(wanted)}-${i}`;
    used.add(id);
    return id;
  };
  const node = (n: Parameters<typeof upsert>[0]) => ops.push(upsert(n));

  const units: Unit[] = [];
  const infraDirs: string[] = [];
  const testDirs: string[] = [];
  const docDirs: string[] = [];
  const scriptDirs: string[] = [];
  const configDirs: string[] = [];

  for (const top of subdirsOf(ix, '')) {
    const lower = top.toLowerCase();
    if (CONTAINERS.has(lower)) {
      for (const c of subdirsOf(ix, top)) units.push({ dir: `${top}/${c}`, name: c, group: lower });
    } else if (lower === 'src' && subdirsOf(ix, 'src').length >= 2) {
      for (const c of subdirsOf(ix, 'src')) units.push({ dir: `src/${c}`, name: c, group: 'src' });
      if (ix.direct.get('src')?.length) units.push({ dir: 'src', name: 'src', group: '' });
    } else if (kindForName(lower) === 'infra') infraDirs.push(top);
    else if (kindForName(lower) === 'config') configDirs.push(top);
    else if (TESTS.test(lower)) testDirs.push(top);
    else if (DOCS.test(lower)) docDirs.push(top);
    else if (SCRIPTS.test(lower)) scriptDirs.push(top);
    else if (!lower.startsWith('.')) units.push({ dir: top, name: top, group: '' });
  }

  const rootInfo = readManifestInfo('', manifests);
  const tops: { id: string; kind: NodeKind }[] = [];

  // Biggest units first so they win the short ids.
  units.sort((a, b) => (ix.counts.get(b.dir) ?? 0) - (ix.counts.get(a.dir) ?? 0));
  for (const u of units) {
    const info = readManifestInfo(u.dir, manifests);
    const byName = kindForName(u.name);
    let kind: NodeKind = byName ?? info.kindHint ?? (u.group === 'apps' ? 'service' : 'module');
    if (u.dir === 'src') kind = rootInfo.kindHint ?? 'module';
    const label = u.dir === 'src' ? 'Core' : humanize(u.name);
    const id = uniqueId(u.dir === 'src' ? 'core' : u.name, u.group || 'top');
    node({ id, parentId: null, label, kind, paths: [`${u.dir}/`], tech: info.tech.length ? info.tech : undefined, now });
    tops.push({ id, kind });
    if (u.dir !== 'src') addChildren(u, id, kind);
  }

  function addChildren(u: Unit, parentId: string, parentKind: NodeKind): void {
    const srcDir = `${u.dir}/src`;
    const keep = (c: string) => !CHILD_SKIP.test(c) && !TESTS.test(c.toLowerCase());
    // Modules: src/* when src is structured, plus the unit's other folders (db/, prisma/…).
    const dirs = [
      ...(subdirsOf(ix, srcDir).length >= 2 ? subdirsOf(ix, srcDir).map((c) => `${srcDir}/${c}`) : []),
      ...subdirsOf(ix, u.dir)
        .filter((c) => c !== 'src' || subdirsOf(ix, srcDir).length < 2)
        .map((c) => `${u.dir}/${c}`),
    ]
      .filter((d) => keep(d.split('/').pop()!))
      .sort((a, b) => (ix.counts.get(b) ?? 0) - (ix.counts.get(a) ?? 0))
      .slice(0, 8);
    let configChild: string | null = null;
    if (dirs.length >= 2) {
      for (const dir of dirs) {
        const c = dir.split('/').pop()!;
        const byName = kindForName(c);
        const kind: NodeKind = byName && byName !== 'client' && byName !== 'service' && byName !== 'infra' ? byName : 'module';
        const id = uniqueId(`${parentId}-${c}`, parentId);
        node({ id, parentId, label: humanize(c), kind, paths: [`${dir}/`], now });
        if (kind === 'config') configChild = id;
      }
    }
    // Environment and config at the unit's root get a Config child.
    const envFiles = (ix.direct.get(u.dir) ?? []).filter((f) => f === '.env' || f.startsWith('.env.') || f.endsWith('.env'));
    const configFiles = [...(ix.direct.get(u.dir) ?? []), ...(ix.direct.get(srcDir) ?? [])]
      .filter((f) => /^config\.(ts|js|mjs|cjs|json|ya?ml|py)$/.test(f) || /^settings\.py$/.test(f));
    const configPaths = [
      ...envFiles.map((f) => `${u.dir}/${f}`),
      ...configFiles.map((f) => ((ix.direct.get(u.dir) ?? []).includes(f) ? `${u.dir}/${f}` : `${srcDir}/${f}`)),
    ];
    if (!configPaths.length) return;
    if (configChild) {
      node({ id: configChild, parentId, label: 'Config', kind: 'config', paths: [...configPaths, ...pathsOf(configChild)], now });
    } else if (parentKind !== 'config') {
      const id = uniqueId(`${parentId}-config`, parentId);
      node({ id, parentId, label: 'Config', kind: 'config', summary: 'Environment, secrets and settings.', paths: configPaths, now });
    }
  }

  function pathsOf(id: string): string[] {
    for (let i = ops.length - 1; i >= 0; i--) {
      const o = ops[i];
      if (o.op === 'upsertNode' && o.node.id === id) return o.node.paths ?? [];
    }
    return [];
  }

  // Infra: one node; children when there are several sources.
  const rootFiles = ix.direct.get('') ?? [];
  const infraFiles = rootFiles.filter((f) => ROOT_INFRA_FILE.test(f));
  if (infraDirs.length || infraFiles.length) {
    const id = uniqueId('infra', 'top');
    node({ id, parentId: null, label: 'Infra', kind: 'infra', summary: 'Build, CI and deployment.', paths: [...infraDirs.map((d) => `${d}/`), ...infraFiles], now });
    // Children only for distinct sources; a folder literally named "infra" stays with the parent.
    const distinct = infraDirs.filter((d) => humanize(d) !== 'Infra');
    if (infraDirs.length > 1) {
      for (const d of distinct) {
        node({ id: uniqueId(`${id}-${d}`, id), parentId: id, label: d === '.github' ? 'CI' : humanize(d), kind: 'infra', paths: [`${d}/`], now });
      }
    }
  }
  if (testDirs.length) node({ id: uniqueId('tests', 'top'), parentId: null, label: 'Tests', kind: 'module', paths: testDirs.map((d) => `${d}/`), now });
  if (scriptDirs.length) node({ id: uniqueId('scripts', 'top'), parentId: null, label: 'Scripts', kind: 'infra', paths: scriptDirs.map((d) => `${d}/`), now });
  if (docDirs.length) node({ id: uniqueId('docs', 'top'), parentId: null, label: 'Docs', kind: 'module', paths: [...docDirs.map((d) => `${d}/`), '*.md'], now });
  // Everything else at the root (manifests, .env, tool config) is project config.
  if (rootFiles.length || configDirs.length) {
    node({
      id: uniqueId('config', 'top'),
      parentId: null,
      label: 'Config',
      kind: 'config',
      summary: 'Project manifests, settings and environment.',
      tech: rootInfo.tech.length && !units.length ? rootInfo.tech : undefined,
      paths: ['*', ...configDirs.map((d) => `${d}/`)],
      now,
    });
  }

  // Edges only where the shape makes them near-certain.
  const services = tops.filter((t) => t.kind === 'service');
  if (services.length === 1) {
    const api = services[0].id;
    for (const t of tops) {
      if (t.kind === 'client') ops.push({ op: 'upsertEdge', edge: { from: t.id, to: api, kind: 'calls' } });
      if (t.kind === 'data') ops.push({ op: 'upsertEdge', edge: { from: api, to: t.id, kind: 'reads' } });
      if (t.kind === 'queue') ops.push({ op: 'upsertEdge', edge: { from: api, to: t.id, kind: 'events' } });
    }
  }

  return applyOps(emptyMap(), ops, now);
}

function upsert(n: {
  id: string;
  parentId: string | null;
  label: string;
  kind: NodeKind;
  paths?: string[];
  tech?: string[];
  summary?: string;
  now: number;
}): MapOp {
  return {
    op: 'upsertNode',
    node: {
      id: n.id,
      parentId: n.parentId,
      label: n.label,
      kind: n.kind,
      status: 'built',
      paths: n.paths,
      tech: n.tech,
      summary: n.summary,
      order: n.parentId ? undefined : KIND_ORDER[n.kind],
      createdAt: n.now,
      updatedAt: n.now,
    },
  };
}

/** Reads the manifests the heuristic cares about and builds the map. */
export function buildHeuristicMap(root: string, paths: string[]): ArchMap {
  const manifests: Record<string, string> = {};
  for (const p of paths) {
    const parts = p.split('/');
    if (parts.length > 3 || !MANIFESTS.includes(parts[parts.length - 1])) continue;
    try {
      manifests[p] = readFileSync(join(root, p), 'utf8').slice(0, 200_000);
    } catch {
      // unreadable manifest — skip
    }
  }
  return heuristicMap(paths, manifests);
}
