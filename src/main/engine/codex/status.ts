// Is Codex signed in, and signing in: `codex login` opens the browser to sign
// in with ChatGPT and returns once it's done.

import { execFile, spawn } from 'node:child_process';
import type { ClaudeCheck } from '../passthrough';
import { errorText, log } from '../sdk';
import { codexBinary, codexEnv } from './binary';
import { CODEX_MISSING } from './query';

const NOT_SIGNED_IN = 'Codex is not signed in.';
const SIGN_IN_TIMEOUT = 10 * 60_000;

export async function checkCodex(): Promise<ClaudeCheck> {
  const bin = codexBinary();
  if (!bin) return { ok: false, detail: CODEX_MISSING };
  if (process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY) return { ok: true };
  return new Promise((resolve) => {
    execFile(bin.path, ['login', 'status'], { env: codexEnv(bin), timeout: 15_000, windowsHide: true }, (err, stdout, stderr) => {
      if (!err) return resolve({ ok: true });
      const said = `${stdout}${stderr}`.trim();
      resolve({ ok: false, detail: /not logged in/i.test(said) || !said ? NOT_SIGNED_IN : said });
    });
  });
}

let signingIn: Promise<ClaudeCheck> | null = null;

/** Opens the browser to sign in to Codex; resolves with the status once it's done (or abandoned). */
export function signInCodex(): Promise<ClaudeCheck> {
  signingIn ??= run().finally(() => (signingIn = null));
  return signingIn;
}

async function run(): Promise<ClaudeCheck> {
  const bin = codexBinary();
  if (!bin) return { ok: false, detail: CODEX_MISSING };
  await new Promise<void>((resolve) => {
    const child = spawn(bin.path, ['login'], { env: codexEnv(bin), stdio: 'ignore', windowsHide: true, timeout: SIGN_IN_TIMEOUT });
    child.once('error', (e) => {
      log('codex', 'sign-in failed', errorText(e));
      resolve();
    });
    child.once('close', () => resolve());
  });
  return checkCodex();
}
