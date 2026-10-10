#!/usr/bin/env node
// `npm run dev`: electron-vite dev, started again whenever the app asks for a
// restart (it exits with code 75). That's how Arxitect, while building itself,
// loads its own main-process changes: renderer code hot-reloads, main code
// needs a fresh process. The project reopens and builders resume on their own.
//
//   npm run dev              arguments after `--` go to electron-vite dev

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RESTART_CODE = 75;
// The package's exports map hides its bin from require.resolve.
const cli = fileURLToPath(new URL('../node_modules/electron-vite/bin/electron-vite.js', import.meta.url));
const args = ['dev', ...process.argv.slice(2)];

let child = null;
let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopping = true;
    child?.kill(sig);
  });
}

function run() {
  child = spawn(process.execPath, [cli, ...args], { stdio: 'inherit', env: { ...process.env, ARXITECT_SUPERVISOR: '1' } });
  child.on('exit', (code, signal) => {
    if (code === RESTART_CODE && !stopping) {
      console.log('\n[arxitect] restarting to load new code…\n');
      run();
      return;
    }
    process.exit(code ?? (signal ? 1 : 0));
  });
}

run();
