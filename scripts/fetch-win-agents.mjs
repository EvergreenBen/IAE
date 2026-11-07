#!/usr/bin/env node
// Downloads the Windows binaries of Claude Code and Codex for `npm run dist:win`.
// npm only installs the binaries for the machine you're on, so building the
// Windows installer from a Mac needs the win32-x64 packages fetched by hand.
// They land in vendor/ (gitignored); electron-builder.yml copies them next to
// the SDKs inside the app, where src/main/index.ts and codex/binary.ts look.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const deps = (pkg) => JSON.parse(readFileSync(join(root, 'node_modules', pkg, 'package.json'), 'utf8')).optionalDependencies;

const wanted = [
  // [what, npm spec, vendor folder]
  ['Claude Code', `@anthropic-ai/claude-agent-sdk-win32-x64@${deps('@anthropic-ai/claude-agent-sdk')['@anthropic-ai/claude-agent-sdk-win32-x64']}`, 'claude-win32-x64'],
  ['Codex', deps('@openai/codex')['@openai/codex-win32-x64'].replace(/^npm:/, ''), 'codex-win32-x64'],
];

for (const [what, spec, folder] of wanted) {
  const dest = join(root, 'vendor', folder);
  const stamp = join(dest, '.spec');
  if (existsSync(stamp) && readFileSync(stamp, 'utf8') === spec) {
    console.log(`Windows ${what} (${spec}) already in vendor/`);
    continue;
  }
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const tgz = execFileSync('npm', ['pack', spec, '--silent'], { cwd: dest, encoding: 'utf8' }).trim();
  execFileSync('tar', ['-xzf', tgz, '--strip-components=1'], { cwd: dest });
  rmSync(join(dest, tgz));
  execFileSync('sh', ['-c', `printf %s '${spec}' > .spec`], { cwd: dest });
  console.log(`Fetched Windows ${what} (${spec}) into vendor/`);
}
