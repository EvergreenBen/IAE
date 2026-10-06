// Generic IPC plumbing: renderer calls → Engine methods; engine events → renderer.
import { ipcMain, type BrowserWindow } from 'electron';
import { BRIDGE_METHODS, IPC_EVENT, IPC_INVOKE, type IaeApi } from '../shared/bridge';
import type { EngineEvent } from '../shared/events';

const allowed = new Set<string>(BRIDGE_METHODS);

export function registerIpc(api: IaeApi): void {
  ipcMain.handle(IPC_INVOKE, async (_event, method: string, args: unknown[]) => {
    if (!allowed.has(method)) throw new Error(`Unknown IAE method: ${method}`);
    const fn = (api as unknown as Record<string, (...a: unknown[]) => unknown>)[method];
    if (typeof fn !== 'function') throw new Error(`IAE method not implemented: ${method}`);
    return await fn.apply(api, args ?? []);
  });
}

/** Returns an emitter that forwards engine events to the window (dropped if it's gone). */
export function windowEmitter(getWindow: () => BrowserWindow | null): (e: EngineEvent) => void {
  return (e) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(IPC_EVENT, e);
  };
}
