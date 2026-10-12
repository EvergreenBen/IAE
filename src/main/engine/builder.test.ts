// What a builder's stream shows on the map: thinking only when nothing is in
// flight, and a figure that never vanishes when the map is regrouped.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyOps, emptyMap } from '../../shared/map';
import type { AgentInfo, ArchMap, MapOp } from '../../shared/model';
import { BuilderRun, type RunDeps } from './builder';

function setup() {
  let map: ArchMap = applyOps(emptyMap(), [
    { op: 'upsertNode', node: { id: 'api', label: 'API', kind: 'service', paths: ['api/'] } },
    { op: 'upsertNode', node: { id: 'auth', label: 'Auth', kind: 'module', parentId: 'api', paths: ['api/auth/'] } },
  ] as MapOp[]);
  const ws = {
    root: '/p',
    get map() {
      return map;
    },
  };
  const deps = { ws, emit: () => {}, settings: {}, onUpdate: () => {}, askPermission: async () => ({ behavior: 'allow' }), onAsked: () => {}, onFinished: () => {} } as unknown as RunDeps;
  const agent: AgentInfo = { id: 'ada', name: 'Ada', role: 'builder', hue: 0, status: 'working', task: 't', nodeId: 'auth', startedAt: 0 };
  const run = new BuilderRun({ kind: 'build', title: 't', brief: 'b', nodeId: 'auth' }, agent, deps);
  // onMessage is the stream's entry point; the tests feed it messages directly.
  const feed = (m: unknown) => (run as unknown as { onMessage(m: unknown): void }).onMessage(m);
  const regroup = (ops: MapOp[]) => {
    map = applyOps(map, ops);
    run.rehome();
  };
  return { run, feed, regroup };
}

const call = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id: string) => ({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: id }] } });
const stream = (event: unknown) => ({ type: 'stream_event', parent_tool_use_id: null, event });

describe('thinking', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reads as thinking once results are back and nothing new has started', () => {
    const { run, feed } = setup();
    feed(call('r1', 'Read', { file_path: '/p/api/auth/a.ts' }));
    feed(result('r1'));
    vi.advanceTimersByTime(6000);
    expect(run.agent).toMatchObject({ status: 'thinking', activity: 'Thinking it through' });
  });

  it('is not thinking while another tool from the same reply still runs', () => {
    const { run, feed } = setup();
    feed(call('e1', 'Edit', { file_path: '/p/api/auth/a.ts', old_string: 'a', new_string: 'b' }));
    feed(call('b1', 'Bash', { command: 'npm test' }));
    feed(result('e1'));
    vi.advanceTimersByTime(60_000);
    expect(run.agent).toMatchObject({ status: 'working', activity: 'Running the tests' });
  });

  it('is not thinking while a write is still streaming in, and moves to its part as soon as it names the file', () => {
    const { run, feed } = setup();
    feed(stream({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'Read' } }));
    feed(call('r1', 'Read', { file_path: '/p/api/a.ts' }));
    feed(stream({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', name: 'Write' } }));
    feed(stream({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/p/api/auth/new.ts","content":"' } }));
    expect(run.agent).toMatchObject({ nodeId: 'auth', file: 'api/auth/new.ts', activity: 'Making changes' });
    feed(result('r1'));
    vi.advanceTimersByTime(6000);
    expect(run.agent.status).toBe('working');
  });
});

describe('when the map is regrouped', () => {
  it('moves to the nearest part of where it stood that is still there', () => {
    const { run, regroup } = setup();
    regroup([{ op: 'removeNode', id: 'auth' }]);
    expect(run.agent.nodeId).toBe('api');
  });

  it('follows the last file it touched, even after commands that touch none', () => {
    const { run, feed, regroup } = setup();
    feed(call('e1', 'Edit', { file_path: '/p/api/auth/a.ts', old_string: 'a', new_string: 'b' }));
    feed(call('b1', 'Bash', { command: 'npm test' }));
    regroup([
      { op: 'removeNode', id: 'auth' },
      { op: 'removeNode', id: 'api' },
      { op: 'upsertNode', node: { id: 'backend', label: 'Backend', kind: 'service', paths: ['api/'] } },
    ] as MapOp[]);
    expect(run.agent.nodeId).toBe('backend');
  });

  it('finds a place again on a later change when it had none', () => {
    const { run, feed, regroup } = setup();
    feed(call('r1', 'Read', { file_path: '/p/web/page.ts' }));
    regroup([{ op: 'removeNode', id: 'auth' }, { op: 'removeNode', id: 'api' }]);
    expect(run.agent.nodeId).toBeNull();
    regroup([{ op: 'upsertNode', node: { id: 'web', label: 'Web', kind: 'client', paths: ['web/'] } }] as MapOp[]);
    expect(run.agent.nodeId).toBe('web');
  });
});

describe('the plan it shows', () => {
  it('keeps its own plain plan over its todo list', () => {
    const { run, feed } = setup();
    // The progress tool's handler reports it (crew-tools → onProgress).
    (run as unknown as { report(r: { steps: string[] }): void }).report({ steps: ['Failed jobs try again', 'Check it all works'] });
    feed(call('t1', 'TodoWrite', { todos: [{ content: 'Edit apps/jobs/src/worker.ts', status: 'in_progress' }] }));
    expect(run.agent.progress?.steps).toEqual(['Failed jobs try again', 'Check it all works']);
  });
});
