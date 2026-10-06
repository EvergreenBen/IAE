// Where to look for a locally downloaded speech model (npm run voice:setup
// puts them in <repo>/resources/models/<org>/<name>/).
//
//  - Dev server (browser or electron-vite dev): Vite serves files outside the
//    renderer root under /@fs/…, and the glob below tells us whether the model
//    is there and at which URL.
//  - Packaged / built app (file://…/out/renderer/index.html): resources/ sits
//    two levels up.
//  - Otherwise undefined → the hub (and the browser cache after first use).

const configs = import.meta.glob('../../../../resources/models/*/*/config.json', { query: '?url', import: 'default', eager: true }) as Record<string, string>;

const runtimes = import.meta.glob('../../../../resources/models/ort/*.mjs.txt', { query: '?url', import: 'default', eager: true }) as Record<string, string>;

/** Folder holding a local copy of ONNX Runtime's wasm (see fetch-voice-models). */
export function localRuntimeBase(): string | undefined {
  if (import.meta.env.DEV) {
    const url = Object.values(runtimes)[0];
    return url ? new URL(url.slice(0, url.lastIndexOf('/') + 1), location.href).pathname : undefined;
  }
  if (location.protocol === 'file:') return new URL('../../resources/models/ort/', location.href).href;
  return undefined;
}

export function localModelBase(model: string): string | undefined {
  if (import.meta.env.DEV) {
    const suffix = `${model}/config.json`;
    for (const [path, url] of Object.entries(configs)) {
      // A scheme-less path on purpose: transformers.js treats http(s) bases as
      // remote and would still ask the hub for file metadata.
      if (path.endsWith(`/models/${suffix}`) && url.endsWith(suffix)) return new URL(url.slice(0, -suffix.length), location.href).pathname;
    }
    return undefined;
  }
  if (location.protocol === 'file:') return new URL('../../resources/models/', location.href).href;
  return undefined;
}
