import { describe, expect, it } from 'vitest';
import { addChange, ChangeTracker, countLines, inputCount, patchCount, resultCount, textLines } from './changes';

describe('counting changed lines', () => {
  it('splits text into lines without the piece after a final newline', () => {
    expect(textLines('')).toEqual([]);
    expect(textLines('a')).toEqual(['a']);
    expect(textLines('a\nb\n')).toEqual(['a', 'b']);
    expect(textLines('a\r\nb')).toEqual(['a', 'b']);
  });

  it('counts only the lines that differ, not the context around them', () => {
    expect(countLines('a\nb\nc', 'a\nB\nc')).toEqual({ added: 1, removed: 1 });
    expect(countLines('a\nc', 'a\nb\nc')).toEqual({ added: 1, removed: 0 });
    expect(countLines('a\nb\nc', 'a\nc')).toEqual({ added: 0, removed: 1 });
    expect(countLines('same', 'same')).toEqual({ added: 0, removed: 0 });
    expect(countLines('', 'x\ny\n')).toEqual({ added: 2, removed: 0 });
  });

  it('finds common lines in the middle of a change (a minimal diff)', () => {
    const before = ['import a', 'one', 'keep 1', 'two', 'keep 2', 'three', 'end'].join('\n');
    const after = ['import a', 'ONE', 'keep 1', 'keep 2', 'THREE', 'new', 'end'].join('\n');
    // one→ONE, two removed, three→THREE, new added
    expect(countLines(before, after)).toEqual({ added: 3, removed: 3 });
  });

  it('counts a wholesale rewrite as everything removed and added', () => {
    const before = Array.from({ length: 2000 }, (_, i) => `old ${i}`).join('\n');
    const after = Array.from({ length: 1800 }, (_, i) => `new ${i}`).join('\n');
    expect(countLines(before, after)).toEqual({ added: 1800, removed: 2000 });
  });
});

describe('counts from the call itself', () => {
  it('Edit: old_string → new_string, times the occurrences with replace_all', () => {
    expect(inputCount('Edit', { old_string: 'const a = 1;\nconst b = 2;', new_string: 'const a = 1;\nconst b = 3;\nconst c = 4;' })).toEqual({ added: 2, removed: 1 });
    expect(inputCount('Edit', { old_string: 'foo()', new_string: 'bar()', replace_all: true }, 'foo()\nx\nfoo()\nfoo()')).toEqual({ added: 3, removed: 3 });
  });

  it('MultiEdit: the sum of its edits', () => {
    const edits = [
      { old_string: 'a', new_string: 'a\nb' },
      { old_string: 'x\ny', new_string: 'z' },
    ];
    expect(inputCount('MultiEdit', { edits })).toEqual({ added: 2, removed: 2 });
    expect(inputCount('MultiEdit', {})).toBeNull();
  });

  it('Write: a new file is all added; an existing one is compared with what was there', () => {
    expect(inputCount('Write', { content: 'a\nb\nc\n' }, null)).toEqual({ added: 3, removed: 0 });
    expect(inputCount('Write', { content: 'a\nB\nc\n' }, 'a\nb\nc\n')).toEqual({ added: 1, removed: 1 });
    expect(inputCount('Write', { content: 'a' })).toBeNull();
  });

  it('NotebookEdit: only an inserted cell is knowable', () => {
    expect(inputCount('NotebookEdit', { edit_mode: 'insert', new_source: 'x = 1\ny = 2' })).toEqual({ added: 2, removed: 0 });
    expect(inputCount('NotebookEdit', { edit_mode: 'replace', new_source: 'x' })).toBeNull();
  });
});

describe("counts from Claude Code's tool results", () => {
  const patch = [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, lines: [' a', '-b', '+B', '+C', ' d'] }];

  it("reads Edit's structured patch", () => {
    expect(patchCount(patch)).toEqual({ added: 2, removed: 1 });
    expect(resultCount('Edit', { structuredPatch: patch })).toEqual({ count: { added: 2, removed: 1 } });
    expect(resultCount('Edit', { oldString: 'x' })).toBeNull();
    expect(patchCount([{ nope: true }])).toBeNull();
  });

  it('reads Write: create is all added, update uses the patch or the original', () => {
    expect(resultCount('Write', { type: 'create', content: 'a\nb\n', structuredPatch: [] })).toEqual({ count: { added: 2, removed: 0 }, created: true });
    expect(resultCount('Write', { type: 'update', content: 'a\nB\n', structuredPatch: patch })).toEqual({ count: { added: 2, removed: 1 }, created: false });
    expect(resultCount('Write', { type: 'update', content: 'a\nB\n', structuredPatch: [], originalFile: 'a\nb\n' })).toEqual({ count: { added: 1, removed: 1 }, created: false });
    // Too large for Claude Code to diff: fall back to the call.
    expect(resultCount('Write', { type: 'update', content: 'a', structuredPatch: [], originalFile: null })).toBeNull();
  });

  it('reads NotebookEdit cells, and counts nothing for an edit held for review', () => {
    expect(resultCount('NotebookEdit', { edit_mode: 'replace', old_source: 'a\nb', new_source: 'a\nc\nd' })).toEqual({ count: { added: 2, removed: 1 } });
    expect(resultCount('NotebookEdit', { edit_mode: 'delete', old_source: 'a\nb', new_source: '' })).toEqual({ count: { added: 0, removed: 2 } });
    expect(resultCount('Edit', { staged: true, structuredPatch: patch })).toEqual({ count: { added: 0, removed: 0 } });
  });
});

describe('the per-file list', () => {
  it('sums edits per file, newest first, and remembers a file was created', () => {
    let list = addChange([], 'a.ts', { added: 3, removed: 1 }, false, 1);
    list = addChange(list, 'b.ts', { added: 10, removed: 0 }, true, 2);
    list = addChange(list, 'a.ts', { added: 1, removed: 2 }, false, 3);
    expect(list).toEqual([
      { path: 'a.ts', added: 4, removed: 3, at: 3 },
      { path: 'b.ts', added: 10, removed: 0, created: true, at: 2 },
    ]);
    list = addChange(list, 'b.ts', { added: 1, removed: 1 }, false, 4);
    expect(list[0]).toEqual({ path: 'b.ts', added: 11, removed: 1, created: true, at: 4 });
  });

  it('keeps at most the newest files', () => {
    let list: ReturnType<typeof addChange> = [];
    for (let i = 0; i < 5; i++) list = addChange(list, `f${i}`, { added: 1, removed: 0 }, false, i, 3);
    expect(list.map((f) => f.path)).toEqual(['f4', 'f3', 'f2']);
  });
});

describe('a builder edit from call to result', () => {
  const files: Record<string, string> = { '/p/old.ts': 'a\nb\nc\n', '/p/many.ts': 'x\nfoo\nfoo\n' };
  const read = async (abs: string) => files[abs] ?? null;

  it('counts an edit only once its result comes back without an error', async () => {
    const t = new ChangeTracker('/p', read);
    t.begin('t1', 'Edit', 'old.ts', { old_string: 'b', new_string: 'B' }, false);
    t.begin('t2', 'Edit', 'old.ts', { old_string: 'zzz', new_string: 'y' }, false);
    expect(await t.finish('t2', true, undefined, 5)).toBeNull();
    expect(await t.finish('t1', false, undefined, 6)).toEqual([{ path: 'old.ts', added: 1, removed: 1, at: 6 }]);
    // Each call counts once.
    expect(await t.finish('t1', false, undefined, 7)).toBeNull();
  });

  it("prefers the result's patch over the call", async () => {
    const t = new ChangeTracker('/p', read);
    t.begin('t1', 'Edit', 'old.ts', { old_string: 'b', new_string: 'B' }, false);
    const list = await t.finish('t1', false, { structuredPatch: [{ lines: ['-b', '+B', '+C'] }] }, 1);
    expect(list).toEqual([{ path: 'old.ts', added: 2, removed: 1, at: 1 }]);
  });

  it('compares a Write with the file as it was when the call arrived', async () => {
    const t = new ChangeTracker('/p', read);
    t.begin('w1', 'Write', 'old.ts', { content: 'a\nB\nc\nd\n' }, false);
    files['/p/old.ts'] = 'a\nB\nc\nd\n'; // the write lands before the result
    expect(await t.finish('w1', false, undefined, 2)).toEqual([{ path: 'old.ts', added: 2, removed: 1, at: 2 }]);
    t.begin('w2', 'Write', 'new.ts', { content: 'one\ntwo\n' }, true);
    expect((await t.finish('w2', false, undefined, 3))?.[0]).toEqual({ path: 'new.ts', added: 2, removed: 0, created: true, at: 3 });
  });

  it('multiplies a replace_all edit by the places it changed', async () => {
    const t = new ChangeTracker('/p', read);
    t.begin('r1', 'Edit', 'many.ts', { old_string: 'foo', new_string: 'bar', replace_all: true }, false);
    expect((await t.finish('r1', false, undefined, 1))?.[0]).toMatchObject({ added: 2, removed: 2 });
  });

  it('ignores tools that do not edit, and edits that changed nothing', async () => {
    const t = new ChangeTracker('/p', read);
    t.begin('x', 'Read', 'old.ts', {}, false);
    expect(await t.finish('x', false, undefined, 1)).toBeNull();
    t.begin('s', 'Edit', 'old.ts', { old_string: 'a', new_string: 'b' }, false);
    expect(await t.finish('s', false, { staged: true }, 1)).toBeNull();
    expect(t.changes).toEqual([]);
  });
});
