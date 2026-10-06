import type { IaeBridge } from '../shared/bridge';

declare global {
  interface Window {
    /** Present in the Electron app; absent in browser dev mode (mock is used). */
    iae?: IaeBridge;
  }
}

export {};
