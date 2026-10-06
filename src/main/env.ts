// GUI apps on macOS start with a minimal PATH. Claude Code (and the tools its
// sessions run — git, node, package managers) need the user's login PATH.
import { execFileSync } from 'node:child_process';

export function adoptLoginShellPath(): void {
  if (process.platform === 'win32') return;
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const out = execFileSync(shell, ['-ilc', 'printf "__IAE_PATH__%s" "$PATH"'], {
      encoding: 'utf8',
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const path = out.split('__IAE_PATH__').pop()?.trim();
    if (path) process.env.PATH = path;
  } catch {
    // Keep the inherited PATH; add the usual suspects so `claude`/`node` resolve.
    const extra = ['/opt/homebrew/bin', '/usr/local/bin', `${process.env.HOME}/.local/bin`];
    process.env.PATH = [...extra, process.env.PATH ?? ''].join(':');
  }
}
