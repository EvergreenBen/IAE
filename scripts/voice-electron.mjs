#!/usr/bin/env node
// Talk to the REAL desktop app (built output + real engine/Claude) through a
// synthetic microphone, and time each spoken turn. macOS: the person's lines
// are spoken by `say`. Output is muted. Build first: `npm run build`.
//
//   node scripts/voice-electron.mjs                  # turns: ask, wait, ask again
//   node scripts/voice-electron.mjs bargein          # talk over Archie mid-answer
//   node scripts/voice-electron.mjs echo --echo 0.8  # Archie's voice leaks into the mic; nobody interrupts
//   node scripts/voice-electron.mjs --project DIR    # talk about another project (default: a copy of examples/recipe-box)
//
// --echo G feeds Archie's own voice back into the mic at gain G, ~60ms late,
// like speakers into a laptop mic with no echo canceller. Watch for
// "Archie cut off" where nobody talked over him.
//
// Chromium's --use-file-for-fake-audio-capture delivers silence in Electron,
// so the page's getUserMedia is replaced with a MediaStream fed from the WAVs.
// Settings and recent projects live in a scratch userData folder, never yours.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const scenario = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--'))) ?? 'turns';
const ECHO = Number(opt('--echo', '0'));
const work = join(tmpdir(), 'arxitect-voice');
const userData = join(work, 'userData');
let project = opt('--project', null);
if (!project) {
  project = join(work, 'recipe-box');
  if (!existsSync(project)) cpSync(join(repo, 'examples/recipe-box'), project, { recursive: true, filter: (src) => !/node_modules|\.iae$/.test(src) });
}
project = resolve(project);

// The person's lines, spoken by macOS into 16kHz WAVs.
const LINES = [
  'What does the jobs worker do, and how does it get its work?',
  'Walk me through how a recipe gets saved, from the web app to the database.',
  'Wait, actually, hold on. What happens when a photo upload fails?',
];
mkdirSync(join(work, 'lines'), { recursive: true });
const clips = LINES.map((text, i) => {
  const wav = join(work, 'lines', `${i}.wav`);
  if (!existsSync(wav)) {
    execFileSync('say', ['-v', 'Samantha', '-o', `${wav}.aiff`, text]);
    execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', `${wav}.aiff`, wav]);
  }
  return readFileSync(wav).toString('base64');
});

const t0 = Date.now();
const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const app = await electron.launch({ args: [repo, '--mute-audio'], cwd: repo, env: { ...process.env, ARXITECT_USER_DATA: userData } });
const page = await app.firstWindow();
page.on('console', (m) => {
  const t = m.text();
  if (/^\[voice|^\[talk\]/.test(t)) console.log(stamp(), t.slice(0, 240));
});
page.on('pageerror', (e) => console.log(stamp(), '[pageerror]', e.message));
await page.waitForLoadState('domcontentloaded');

await page.evaluate(
  async ({ clips, echo }) => {
    const ctx = new AudioContext({ sampleRate: 48000 });
    const dest = ctx.createMediaStreamDestination();
    const keep = ctx.createConstantSource();
    keep.offset.value = 0;
    keep.connect(dest);
    keep.start();
    const bufs = await Promise.all(clips.map((b64) => ctx.decodeAudioData(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer)));
    window.__say = (i) => {
      const s = ctx.createBufferSource();
      s.buffer = bufs[i];
      s.connect(dest);
      s.start();
      console.log(`[talk] you: line ${i} (${bufs[i].duration.toFixed(1)}s)`);
    };
    navigator.mediaDevices.getUserMedia = async () => dest.stream;
    const start = AudioBufferSourceNode.prototype.start;
    const stop = AudioBufferSourceNode.prototype.stop;
    AudioBufferSourceNode.prototype.start = function (when = 0, ...rest) {
      if (this.context !== ctx && this.buffer && echo > 0) {
        const leak = ctx.createBufferSource();
        leak.buffer = this.buffer;
        const g = ctx.createGain();
        g.gain.value = echo;
        leak.connect(g);
        g.connect(dest);
        start.call(leak, ctx.currentTime + Math.max(0, when ? when - this.context.currentTime : 0) + 0.06);
        this.__leak = leak;
      }
      return start.call(this, when, ...rest);
    };
    AudioBufferSourceNode.prototype.stop = function (...a) {
      if (this.context !== ctx) {
        console.log('[talk] Archie cut off');
        try {
          if (this.__leak) stop.call(this.__leak);
        } catch {
          /* not started */
        }
      }
      return stop.apply(this, a);
    };
  },
  { clips, echo: ECHO },
);

await page.waitForTimeout(1500);
if ((await page.evaluate(() => window.__iae.useIae.getState().screen)) !== 'project') await page.evaluate((p) => window.iae.openProject(p), project);
await page.evaluate(() => {
  window.iae.onEvent((e) => {
    if (e.type === 'lead/done' && e.text) console.log(`[talk] Archie: ${e.text.slice(0, 220)}`);
    if (e.type === 'transcript/append' && e.entry.who === 'user') console.log(`[talk] heard: ${e.entry.text}`);
  });
});
const state = () =>
  page.evaluate(() => {
    const s = window.__iae.useIae.getState();
    return { lead: s.lead.state, speaking: s.voice.speaking, mic: s.voice.mic, mapping: Object.values(s.agents).some((a) => a.role === 'cartographer') };
  });
async function quiet(ms = 2500, max = 180_000) {
  const end = Date.now() + max;
  let since = Date.now();
  while (Date.now() < end) {
    const s = await state();
    if (s.lead !== 'idle' || s.speaking || s.mic === 'hearing' || s.mic === 'transcribing' || s.mapping) since = Date.now();
    if (Date.now() - since >= ms) return;
    await page.waitForTimeout(200);
  }
}
const say = (i) => page.evaluate((i) => window.__say(i), i);

console.log(stamp(), `${project} — waiting for quiet`);
await quiet();
await page.evaluate(async () => {
  const s = await window.iae.getSettings();
  await window.iae.setSettings({ voice: { ...s.voice, handsFree: true, speak: true } });
});
for (let i = 0; i < 100 && (await state()).mic !== 'idle'; i++) await page.waitForTimeout(200);
await page.waitForTimeout(2500); // the VAD learns the room
console.log(stamp(), `hands-free on — ${scenario}${ECHO ? `, echo ${ECHO}` : ''}`);

if (scenario === 'bargein') {
  await say(1);
  for (let i = 0; i < 150 && !(await state()).speaking; i++) await page.waitForTimeout(100);
  await page.waitForTimeout(1800);
  console.log(stamp(), 'talking over Archie');
  await say(2);
  await page.waitForTimeout(6000);
  await quiet(3000);
} else if (scenario === 'echo') {
  await say(1);
  await page.waitForTimeout(5000);
  await quiet(3000);
} else {
  await say(0);
  await page.waitForTimeout(6000);
  await quiet();
  await say(1);
  await page.waitForTimeout(6000);
  await quiet(3000);
}
await page.evaluate(async () => {
  const s = await window.iae.getSettings();
  await window.iae.setSettings({ voice: { ...s.voice, handsFree: false } });
});
await app.close();
