// Exposes the typed IAE bridge on window.iae. Every method is a thin
// ipcRenderer.invoke; events arrive on a single channel.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { BRIDGE_METHODS, IPC_EVENT, IPC_INVOKE, type IaeBridge } from '../shared/bridge';
import type { EngineEvent } from '../shared/events';

const api: Record<string, unknown> = {};
for (const method of BRIDGE_METHODS) {
  api[method] = (...args: unknown[]) => ipcRenderer.invoke(IPC_INVOKE, method, args);
}
api.onEvent = (cb: (e: EngineEvent) => void) => {
  const listener = (_: IpcRendererEvent, e: EngineEvent) => cb(e);
  ipcRenderer.on(IPC_EVENT, listener);
  return () => ipcRenderer.removeListener(IPC_EVENT, listener);
};
api.runtime = 'electron';

contextBridge.exposeInMainWorld('iae', api as unknown as IaeBridge);
