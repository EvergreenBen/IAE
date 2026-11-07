import { describe, expect, it } from 'vitest';
import { threadIdOf, Translator } from './translate';

const ctx = (files: Record<string, string | null> = {}) => ({
  cwd: '/p',
  model: 'm',
  permissionMode: 'workspace-write',
  before: async (abs: string) => files[abs],
  after: async () => 'a\nb\nc\n',
});

describe('codex translator', () => {
  it('starts the session once, with a marked id', async () => {
    const t = new Translator(ctx());
    const [init] = await t.translate({ type: 'thread.started', thread_id: 'abc' });
    expect(init).toMatchObject({ type: 'system', subtype: 'init', session_id: 'codex:abc' });
    expect(await t.translate({ type: 'thread.started', thread_id: 'abc' })).toEqual([]);
    expect(threadIdOf('codex:abc')).toBe('abc');
    expect(threadIdOf('5f1c-claude-id')).toBeUndefined();
  });

  it('turns a command into Bash and its result', async () => {
    const t = new Translator(ctx());
    const [use] = await t.translate({ type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'ls', aggregated_output: '', status: 'in_progress' } });
    expect(use).toMatchObject({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'ls' } }] } });
    const done = await t.translate({ type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'ls', aggregated_output: 'x', exit_code: 1, status: 'completed' } });
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'c1', is_error: true }] } });
  });

  it('names its own tools like Claude Code does', async () => {
    const t = new Translator(ctx());
    const out = await t.translate({ type: 'item.completed', item: { id: 'm1', type: 'mcp_tool_call', server: 'iae', tool: 'sketch_map', arguments: { ops: [] }, status: 'completed' } });
    expect(out[0]).toMatchObject({ message: { content: [{ name: 'mcp__iae__sketch_map', input: { ops: [] } }] } });
  });

  it('counts a patch against what the file held before', async () => {
    const t = new Translator(ctx({ '/p/a.ts': 'a\n' }));
    const out = await t.translate({ type: 'item.completed', item: { id: 'f1', type: 'file_change', changes: [{ path: 'a.ts', kind: 'update' }], status: 'completed' } });
    expect(out[0]).toMatchObject({ message: { content: [{ name: 'Write', input: { file_path: '/p/a.ts' } }] } });
    expect(out[1]).toMatchObject({ tool_use_result: { type: 'update', originalFile: 'a\n', content: 'a\nb\nc\n' } });
  });

  it('speaks its messages and plans as todos', async () => {
    const t = new Translator(ctx());
    const [say] = await t.translate({ type: 'item.completed', item: { id: 'a1', type: 'agent_message', text: 'Done.' } });
    expect(say).toMatchObject({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } });
    expect(t.lastText).toBe('Done.');
    const [todo] = await t.translate({ type: 'item.updated', item: { id: 't', type: 'todo_list', items: [{ text: 'one', completed: true }] } });
    expect(todo).toMatchObject({ message: { content: [{ name: 'TodoWrite', input: { todos: [{ content: 'one', status: 'completed' }] } }] } });
  });
});
