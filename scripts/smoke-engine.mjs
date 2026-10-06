#!/usr/bin/env node
// Drives the REAL engine (real Claude sessions, via your Claude Code login) in
// plain Node against a temp project, and prints a timeline of engine events.
//
//   node scripts/smoke-engine.mjs                 # new project: lead, sketcher, pulse, a tiny builder
//   node scripts/smoke-engine.mjs --existing DIR  # also open a copy of DIR (heuristic map + cartographer)
//   node scripts/smoke-engine.mjs --skip-build    # skip the builder step (cheaper)
//   node scripts/smoke-engine.mjs --skip-pulse    # skip the ~30s quiet-pulse check
//
// The engine is bundled with esbuild (dependencies stay external) into
// out/smoke/engine.mjs so it runs without Electron.

import { build } from 'esbuild';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const existingIdx = args.indexOf('--existing');
const existingDir = existingIdx !== -1 ? resolve(args[existingIdx + 1]) : null;

const outfile = join(repo, 'out/smoke/engine.mjs');
await build({
  entryPoints: [join(repo, 'src/main/engine/engine.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external',
  outfile,
  logLevel: 'warning',
});
const { Engine } = await import(pathToFileURL(outfile).href);

// ── harness ──────────────────────────────────────────────────────────────────

const t0 = Date.now();
const ms = () => Date.now() - t0;
const timeline = [];
const failures = [];
const listeners = new Set();
const sandbox = mkdtempSync(join(tmpdir(), 'iae-smoke-'));
const check = (ok, what) => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${what}`);
  if (!ok) failures.push(what);
};

let deltaTurn = null;
let engine;
function describe(e) {
  switch (e.type) {
    case 'lead/delta':
      if (deltaTurn === e.turnId) return null;
      deltaTurn = e.turnId;
      return `first delta "${e.text.slice(0, 40)}"`;
    case 'lead/done':
      return e.text ? `"${e.text}"` : '(silence)';
    case 'lead/state':
      return e.state;
    case 'map/ops': {
      const nodes = e.ops.filter((o) => o.op === 'upsertNode').map((o) => `${o.node.id}${o.node.status ? `:${o.node.status}` : ''}`);
      const edges = e.ops.filter((o) => o.op === 'upsertEdge').length;
      return `${e.source}: ${nodes.join(', ')}${edges ? ` +${edges} edges` : ''}`;
    }
    case 'agent/upsert':
      return `${e.agent.name} ${e.agent.status}${e.agent.activity ? ` · ${e.agent.activity}` : ''}${e.agent.nodeId ? ` @${e.agent.nodeId}` : ''}${e.agent.result ? ` → ${e.agent.result.slice(0, 120)}` : ''}`;
    case 'agent/step':
      return null;
    case 'files/touched':
      return `${e.action} ${e.path}`;
    case 'files/replace':
      return `${e.files.length} files`;
    case 'agenda/upsert':
      return `[${e.item.id}] ${e.item.prompt}${e.item.options ? ` (${e.item.options.join(' | ')})` : ''}`;
    case 'decision/add':
      return e.decision.title;
    case 'focus':
      return `${e.nodeId} ${e.mode}`;
    case 'ghost/proposals':
      return e.proposals.map((p) => `${p.label}(${p.kind}${p.nearNodeId ? `→${p.nearNodeId}` : ''})`).join(', ') || '(none)';
    case 'permission/request':
      return `${e.tool}: ${e.summary}`;
    case 'project/opened':
      return `${e.snapshot.project.name} new=${e.snapshot.project.isNew} nodes=${Object.keys(e.snapshot.map.nodes).length} files=${e.snapshot.files.length}`;
    case 'claude/status':
      return `${e.status}${e.detail ? ` (${e.detail})` : ''}`;
    case 'transcript/append':
      return `${e.entry.who}: ${e.entry.text.slice(0, 80)}`;
    case 'notice':
      return `${e.level}: ${e.text}`;
    default:
      return '';
  }
}

function emit(e) {
  const d = describe(e);
  if (d !== null) {
    const line = `${String((ms() / 1000).toFixed(2)).padStart(7)}s  ${e.type.padEnd(18)} ${d}`;
    timeline.push(line);
    console.log(line);
  }
  // Auto-approve builder permission prompts so the run is unattended.
  if (e.type === 'permission/request') setTimeout(() => void engine.resolvePermission(e.id, 'allow'), 50);
  for (const l of listeners) l(e);
}

/** Resolves with the first event matching `pred` within `timeout` ms (or null). */
function waitFor(pred, timeout) {
  return new Promise((res) => {
    const l = (e) => {
      if (!pred(e)) return;
      listeners.delete(l);
      clearTimeout(timer);
      res(e);
    };
    const timer = setTimeout(() => {
      listeners.delete(l);
      res(null);
    }, timeout);
    listeners.add(l);
  });
}
const mark = (label) => {
  const line = `${String((ms() / 1000).toFixed(2)).padStart(7)}s  ── ${label}`;
  timeline.push(line);
  console.log(line);
};

engine = new Engine(emit, {
  pickFolder: async () => null,
  userDataDir: () => join(sandbox, 'userData'),
  homeDir: () => sandbox,
  revealFile: (p) => console.log('reveal', p),
});

// ── run ──────────────────────────────────────────────────────────────────────

try {
  mark('boot');
  await engine.boot();
  const home = await engine.getHome();
  check(home.claude === 'ready', `Claude is ready (${home.claude}${home.claudeDetail ? `: ${home.claudeDetail}` : ''})`);
  if (home.claude !== 'ready') throw new Error('Claude unavailable');

  mark('create project');
  const greeting = waitFor((e) => e.type === 'lead/done', 30_000);
  const snap = await engine.createProject('Recipe Smoke');
  check(snap.project.isNew && Object.keys(snap.map.nodes).length === 0, 'new project opens empty');
  check(existsSync(join(snap.project.root, '.git')) && existsSync(join(snap.project.root, '.iae')), 'git init + .iae created');
  const g = await greeting;
  check(!!g?.text, `lead greets first: ${g?.text ?? '(nothing)'}`);
  await new Promise((r) => setTimeout(r, 300));

  mark('draft → sketcher');
  const ghosts = waitFor((e) => e.type === 'ghost/proposals', 12_000);
  const tDraft = Date.now();
  await engine.draft('d1', 'friends share recipes and plan a weekly meal planner with a shopping');
  const gp = await ghosts;
  check(!!gp && gp.proposals.length > 0, `ghost proposals in ${gp ? Date.now() - tDraft : '∞'}ms: ${gp?.proposals.map((p) => p.label).join(', ')}`);

  mark('say');
  const firstDelta = waitFor((e) => e.type === 'lead/delta', 10_000);
  const done = waitFor((e) => e.type === 'lead/done', 60_000);
  const mapOps = waitFor((e) => e.type === 'map/ops' && e.source === 'lead' && e.ops.some((o) => o.op === 'upsertNode'), 60_000);
  const tSay = Date.now();
  await engine.setPresence('idle');
  await engine.say('I want to build a recipe sharing app with a Next.js frontend and Postgres', { via: 'voice' });
  const fd = await firstDelta;
  const ttft = fd ? Date.now() - tSay : Infinity;
  check(ttft < 5000, `first lead/delta in ${ttft}ms (< 5000)`);
  const reply = await done;
  const words = reply?.text ? reply.text.split(/\s+/).length : 0;
  check(!!reply?.text && words <= 60, `lead/done is short and non-empty (${words} words)`);
  const ops = await mapOps;
  check(!!ops, `map/ops with nodes: ${ops ? describe(ops) : 'none'}`);
  await new Promise((r) => setTimeout(r, 1500));

  if (!flag('--skip-pulse')) {
    // Nothing new since the lead last spoke (its own question is on the map as a
    // card): the pulse must not ask it to repeat itself.
    mark('quiet (pulse)');
    const pulseTurn = waitFor((e) => e.type === 'lead/done', 30_000);
    const p = await pulseTurn;
    check(!p, `pulse stays quiet when nothing is new${p ? ` (but the lead said: "${p.text || '(silence)'}")` : ''}`);
  }

  mark('barge-in');
  {
    const firstDelta = waitFor((e) => e.type === 'lead/delta', 15_000);
    const cut = waitFor((e) => e.type === 'lead/done', 30_000);
    await engine.say('Walk me through, step by step and in detail, every part of a typical recipe app and how each piece talks to the others.');
    const fd = await firstDelta;
    const tInt = Date.now();
    await engine.interrupt();
    const c = await cut;
    check(!!fd && !!c && Date.now() - tInt < 4500, `interrupt ends the turn in ${c ? Date.now() - tInt : '∞'}ms`);
    const next = waitFor((e) => e.type === 'lead/delta', 15_000);
    const tNext = Date.now();
    await engine.say('Never mind. Which node holds the recipes?');
    const n = await next;
    check(!!n, `next turn after interrupt replies in ${n ? Date.now() - tNext : '∞'}ms`);
    await waitFor((e) => e.type === 'lead/done', 30_000);
  }

  if (!flag('--skip-build')) {
    mark('delegate a tiny build');
    const touched = waitFor((e) => e.type === 'files/touched' && /README\.md$/i.test(e.path), 240_000);
    // A card written while the builder works ("Ada is writing…") must not outlive it.
    const started = waitFor((e) => e.type === 'agent/upsert' && e.agent.role === 'builder' && e.agent.status === 'starting', 60_000);
    let staleCard = null;
    void started.then((e) => {
      if (!e) return;
      staleCard = engine.project?.ws.agenda.ask({ prompt: 'Should the README also credit the recipe authors?', why: `${e.agent.name} is writing the README now. Credits are a taste call.`, priority: 0.1 });
      if (staleCard) engine.project.ws.agenda.addBlocker(staleCard.id, e.agent.id);
    });
    const finished = waitFor((e) => e.type === 'agent/upsert' && e.agent.role === 'builder' && ['done', 'failed'].includes(e.agent.status), 300_000);
    // The lead's report on the finished build: the first reply that mentions it after it's done.
    let doneAt = Infinity;
    void finished.then(() => (doneAt = Date.now()));
    const report = waitFor((e) => e.type === 'lead/done' && Date.now() > doneAt, 360_000);
    await engine.say('Have a builder create README.md in the project root containing just the word hello. Nothing else, no other files.');
    const t = await touched;
    check(!!t, `files/touched README.md (${t?.action ?? 'none'})`);
    const f = await finished;
    check(f?.agent.status === 'done', `builder finished: ${f?.agent.status ?? 'timeout'} ${f?.agent.result?.slice(0, 100) ?? ''}`);
    await new Promise((r) => setTimeout(r, 300));
    if (staleCard) {
      const after = engine.project?.ws.agenda.get(staleCard.id);
      const ok = !!after && !after.blocking?.length && after.why === 'Credits are a taste call.';
      check(ok, `finished builder released from its card: blocking=[${after?.blocking ?? ''}] why="${after?.why ?? ''}"`);
      engine.project?.ws.agenda.dismiss(staleCard.id);
    }
    const perms = timeline.filter((l) => l.includes('permission/request'));
    check(perms.every((l) => !/: Run cd\b/.test(l)), `permission cards show the real command (${perms.length} asked${perms.length ? `: ${perms.map((l) => l.split('Bash: ')[1] ?? l).join(' | ').slice(0, 200)}` : ''})`);
    const readme = join(snap.project.root, 'README.md');
    check(existsSync(readme) && /hello/i.test(readFileSync(readme, 'utf8')), 'README.md exists and says hello');
    const r = await report;
    check(!!r, `lead heard about it: ${r ? r.text || '(silence)' : 'no turn'}`);

    mark('explain + commands');
    const tEx = Date.now();
    const explained = await engine.explainFile('README.md');
    check(!!explained, `explainFile in ${Date.now() - tEx}ms: ${explained}`);
  }
  const cmds = await engine.listCommands();
  check(cmds.length > 0, `listCommands: ${cmds.length} (${cmds.slice(0, 6).map((c) => c.name).join(', ')}…)`);

  if (existingDir) {
    mark(`open existing: ${existingDir}`);
    const copy = join(sandbox, 'existing');
    cpSync(existingDir, copy, { recursive: true, filter: (src) => !/node_modules|\.iae$/.test(src) });
    const tOpen = Date.now();
    const s2 = await engine.openProject(copy);
    const n = Object.keys(s2.map.nodes);
    check(n.length > 0, `heuristic map in ${Date.now() - tOpen}ms: ${n.join(', ')}`);
    const env = s2.files.find((f) => f.path.endsWith('.env'));
    check(!env || !!env.nodeId, `.env owned by a node: ${env ? `${env.path} → ${env.nodeId}` : '(no .env)'}`);
    const atlasDone = waitFor((e) => e.type === 'agent/upsert' && e.agent.id === 'atlas' && ['done', 'failed'].includes(e.agent.status), 300_000);
    const a = await atlasDone;
    check(a?.agent.status === 'done', `cartographer finished: ${a?.agent.result ?? 'timeout'}`);
  }

  mark('close');
  await engine.closeProject();
  await engine.shutdown();
} catch (e) {
  failures.push(String(e?.message ?? e));
  console.error(e);
}

console.log(`\n${failures.length ? `FAILED (${failures.length})` : 'OK'} in ${(ms() / 1000).toFixed(1)}s`);
for (const f of failures) console.log(`  - ${f}`);
rmSync(sandbox, { recursive: true, force: true });
process.exit(failures.length ? 1 : 0);
