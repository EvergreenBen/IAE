// Where the Codex CLI is: the copy @openai/codex ships for this platform (in a
// packaged app, unpacked next to the asar archive so it can run), or
// ARXITECT_CODEX_PATH.

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const TRIPLES: Record<string, string> = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
};

export interface CodexBinary {
  path: string;
  /** Put first on PATH (Codex's own ripgrep). */
  pathDirs: string[];
}

let cached: CodexBinary | null | undefined;

export function codexBinary(): CodexBinary | null {
  if (cached !== undefined) return cached;
  const override = process.env.ARXITECT_CODEX_PATH;
  if (override) return (cached = { path: override, pathDirs: [] });
  cached = bundled();
  return cached;
}

function bundled(): CodexBinary | null {
  const key = `${process.platform}-${process.arch}`;
  const triple = TRIPLES[key];
  if (!triple) return null;
  for (const pkgDir of [resolved(key), unpacked(key)]) {
    if (!pkgDir) continue;
    const root = join(pkgDir, 'vendor', triple).replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
    const path = join(root, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
    if (!existsSync(path)) continue;
    const rg = join(root, 'codex-path');
    return { path, pathDirs: existsSync(rg) ? [rg] : [] };
  }
  return null;
}

/** Where npm installed it (development, and the Mac app). */
function resolved(key: string): string | null {
  try {
    const codexPkg = createRequire(import.meta.url).resolve('@openai/codex/package.json');
    return dirname(createRequire(codexPkg).resolve(`@openai/codex-${key}/package.json`));
  } catch {
    return null;
  }
}

/** Copied in only unpacked (the Windows app is built on a Mac: see scripts/fetch-win-agents.mjs). */
function unpacked(key: string): string | null {
  const resources = (process as { resourcesPath?: string }).resourcesPath;
  return resources ? join(resources, 'app.asar.unpacked', 'node_modules', '@openai', `codex-${key}`) : null;
}

/** The environment for a Codex process: ours, with its own tools first on PATH. */
export function codexEnv(bin: CodexBinary, extra?: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...extra })) if (v !== undefined) env[k] = v;
  if (bin.pathDirs.length) {
    const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
    const sep = process.platform === 'win32' ? ';' : ':';
    env[key] = [...bin.pathDirs, env[key] ?? ''].filter(Boolean).join(sep);
  }
  return env;
}
