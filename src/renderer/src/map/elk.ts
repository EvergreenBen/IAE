// ELK off the main thread. Big scopes take seconds to lay out; in a worker the
// map keeps panning at 60fps while it thinks. Falls back to the bundled
// (main-thread) build if the worker can't start.
import ElkApi from 'elkjs/lib/elk-api.js';
import type { ELK, ElkNode } from 'elkjs/lib/elk-api';
import elkWorkerUrl from 'elkjs/lib/elk-worker.min.js?url';

let worker: ELK | null = null;
let workerBroken = false;
let bundled: Promise<ELK> | null = null;

const fallback = () => (bundled ??= import('elkjs/lib/elk.bundled.js').then((m) => new m.default()));

function timeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('elk-timeout')), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

export async function runElk(graph: ElkNode): Promise<ElkNode> {
  if (!workerBroken) {
    try {
      worker ??= new ElkApi({ workerUrl: elkWorkerUrl });
      return await timeout(worker.layout(graph), 30_000);
    } catch (e) {
      // A layout error (bad options) is ELK talking — let the caller retry. Anything else: the worker is unwell.
      if (!(e instanceof Error) || e.message === 'elk-timeout' || !worker) {
        workerBroken = true;
        worker?.terminateWorker();
        worker = null;
      } else throw e;
    }
  }
  return (await fallback()).layout(graph);
}
