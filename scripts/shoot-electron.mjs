#!/usr/bin/env node
// Drive the REAL desktop app (built output + real engine/Claude) and take
// screenshots. Build first: `npm run build`.
//
//   node scripts/shoot-electron.mjs --out .audit/app/home.png
//   node scripts/shoot-electron.mjs --create "Trail Mix" --wait 8000 --out .audit/app/new.png
//   node scripts/shoot-electron.mjs --open ~/Projects/foo --wait 15000 --out .audit/app/open.png
//   node scripts/shoot-electron.mjs --create "Trail Mix" --say "a hiking trip planner for friends" --wait 12000 --out a.png
//
// Flags: --open <dir> | --create <name> [--parent <dir>], --say <text> (repeatable,
// each followed by --wait), --wait <ms>, --eval <js>, --size 1440x900, --out <png>,
// --shots <n> --every <ms> (take a sequence: out-1.png, out-2.png, …), --events (log engine events)
import { _electron as electron } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

const args = process.argv.slice(2);
const steps = [];
const opt = { out: '.audit/app/shot.png', size: '1440x900', shots: 1, every: 2000 };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const v = () => args[++i];
  if (a === '--open') steps.push({ open: v().replace(/^~/, homedir()) });
  else if (a === '--create') steps.push({ create: v() });
  else if (a === '--parent') opt.parent = v().replace(/^~/, homedir());
  else if (a === '--say') steps.push({ say: v() });
  else if (a === '--wait') steps.push({ wait: Number(v()) });
  else if (a === '--eval') steps.push({ eval: v() });
  else if (a === '--size') opt.size = v();
  else if (a === '--out') opt.out = v();
  else if (a === '--shots') opt.shots = Number(v());
  else if (a === '--every') opt.every = Number(v());
  else if (a === '--events') opt.events = true;
}
const [w, h] = opt.size.split('x').map(Number);

const app = await electron.launch({ args: [resolve('.')], cwd: resolve('.'), env: { ...process.env } });
const page = await app.firstWindow();
await page.setViewportSize({ width: w, height: h }).catch(() => {});
const logs = [];
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning' || opt.events) && logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
app.process().stdout?.on('data', (d) => process.env.ARXITECT_MAIN_LOG && process.stdout.write(`[main] ${d}`));
app.process().stderr?.on('data', (d) => process.env.ARXITECT_MAIN_LOG && process.stderr.write(`[main] ${d}`));
await page.waitForLoadState('domcontentloaded');
await page.waitForTimeout(1200);
if (opt.events) {
  await page.evaluate(() => {
    const t0 = Date.now();
    window.iae.onEvent((e) => {
      const brief = e.type === 'lead/delta' ? e.text : e.type === 'lead/done' ? e.text : e.type === 'map/ops' ? `${e.ops.length} ops (${e.source})` : e.type === 'agent/upsert' ? `${e.agent.name} ${e.agent.status} ${e.agent.activity ?? ''}` : '';
      if (e.type !== 'lead/delta') console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s ${e.type} ${brief}`);
    });
  });
}
for (const s of steps) {
  if (s.open) await page.evaluate((p) => window.iae.openProject(p), s.open);
  if (s.create) await page.evaluate(([n, p]) => window.iae.createProject(n, p), [s.create, opt.parent]);
  if (s.say) await page.evaluate((t) => window.iae.say(t, { via: 'text' }), s.say);
  if (s.eval) await page.evaluate(s.eval);
  if (s.wait) await page.waitForTimeout(s.wait);
}
mkdirSync(dirname(opt.out), { recursive: true });
for (let i = 1; i <= opt.shots; i++) {
  const out = opt.shots > 1 ? opt.out.replace(/\.png$/, `-${i}.png`) : opt.out;
  await page.screenshot({ path: out });
  console.log(`saved ${out}`);
  if (i < opt.shots) await page.waitForTimeout(opt.every);
}
if (logs.length) console.log(logs.slice(-80).join('\n'));
await app.close();
