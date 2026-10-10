// A Vite plugin for the desktop app's dev server: a full page reload (a
// builder edited a module that can't hot-swap) waits for a quiet moment
// instead of landing mid-sentence. The server sends "arxitect:reload" rather
// than reloading; the window reloads once nobody is talking (see
// src/renderer/src/devReload.ts). Hot-swappable edits (components, CSS) still
// apply at once.
import type { Plugin } from 'vite';

export function quietReload(): Plugin {
  return {
    name: 'arxitect:quiet-reload',
    apply: 'serve',
    configureServer(server) {
      const ws = server.ws;
      const send = ws.send.bind(ws) as (...args: unknown[]) => void;
      ws.send = ((...args: unknown[]) => {
        const p = args[0] as { type?: string; path?: string } | undefined;
        if (p && typeof p === 'object' && p.type === 'full-reload') return send({ type: 'custom', event: 'arxitect:reload', data: { path: p.path ?? '*' } });
        return send(...args);
      }) as typeof ws.send;
    },
  };
}
