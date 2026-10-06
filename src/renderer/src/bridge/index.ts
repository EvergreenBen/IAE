// The one way the renderer talks to the engine. In Electron this is the
// preload bridge; in a plain browser (`npm run web`) it's the mock, which
// simulates a lively session so UI work and design audits need no Claude.

import type { IaeBridge } from '@shared/bridge';
import { createMockBridge } from './mock';
import { applyEvent } from '../state/store';

export const bridge: IaeBridge = window.iae ?? createMockBridge();

let wired = false;
/** Subscribe the store to engine events. Idempotent. */
export function wireBridge(): void {
  if (wired) return;
  wired = true;
  bridge.onEvent(applyEvent);
}
