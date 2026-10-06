#!/usr/bin/env node
// Screenshot the renderer (browser mode, mock engine) for design review.
//
//   npm run web            # in another terminal
//   node scripts/shoot.mjs --out .audit/home.png
//   node scripts/shoot.mjs --open sample --wait 6000 --out .audit/project.png
//   node scripts/shoot.mjs --open sample --eval "window.__iae.ui.setScope('api')" --wait 1500 --out .audit/api.png
//   node scripts/shoot.mjs --new "Trip Planner" --type "friends plan hiking trips with a shared map" --out .audit/new.png
//
// Flags: --url (default http://localhost:5199) --open <sample> --new <name>
//        --wait <ms> (after setup, default 2500) --eval <js> (repeatable, run in page)
//        --type <text> (types into the intent line, doesn't send) --send (press Enter after --type)
//        --key <Key> (repeatable) --size 1440x900 --out <png>
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const args = process.argv.slice(2);
const opt = { url: 'http://localhost:5199', wait: 2500, out: '.audit/shot.png', size: '1440x900', evals: [], keys: [] };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const v = () => args[++i];
  if (a === '--url') opt.url = v();
  else if (a === '--open') opt.open = v();
  else if (a === '--new') opt.newName = v();
  else if (a === '--wait') opt.wait = Number(v());
  else if (a === '--eval') opt.evals.push(v());
  else if (a === '--type') opt.type = v();
  else if (a === '--send') opt.send = true;
  else if (a === '--key') opt.keys.push(v());
  else if (a === '--size') opt.size = v();
  else if (a === '--out') opt.out = v();
}
const [w, h] = opt.size.split('x').map(Number);
const qs = new URLSearchParams();
if (opt.open) qs.set('open', opt.open);
if (opt.newName) qs.set('new', opt.newName);
const url = opt.url + (qs.toString() ? `/?${qs}` : '');

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
const logs = [];
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
for (const js of opt.evals) {
  await page.evaluate(js);
  await page.waitForTimeout(400);
}
if (opt.type) {
  await page.keyboard.type(opt.type, { delay: 25 });
  if (opt.send) await page.keyboard.press('Enter');
}
for (const k of opt.keys) {
  await page.keyboard.press(k);
  await page.waitForTimeout(300);
}
await page.waitForTimeout(opt.wait);
mkdirSync(dirname(opt.out), { recursive: true });
await page.screenshot({ path: opt.out });
await browser.close();
console.log(`saved ${opt.out}`);
if (logs.length) console.log(logs.join('\n'));
