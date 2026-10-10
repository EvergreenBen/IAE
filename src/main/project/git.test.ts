import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allAdded, diffFile, parseUnifiedDiff, toFileDiff } from './git';

const PATCH = `diff --git a/src/session.ts b/src/session.ts
index 3b18e51..a9c2f0d 100644
--- a/src/session.ts
+++ b/src/session.ts
@@ -10,6 +10,7 @@ export async function createSession(userId: string) {
 const DAY = 86_400_000;
-const TTL = 30;
+const TTL = 14;
+const SLIDE = true;

 export function a() {
   return 1;
 }
@@ -40,3 +41,2 @@ function tail() {
 keep
--- a removed line that looks like a header
 end
`;

describe('parsing a unified diff', () => {
  it('reads hunks, line numbers and counts', () => {
    const p = parseUnifiedDiff(PATCH);
    expect(p.added).toBe(2);
    expect(p.removed).toBe(2);
    expect(p.hunks).toHaveLength(2);
    const [h1, h2] = p.hunks;
    expect(h1).toMatchObject({ oldStart: 10, oldLines: 6, newStart: 10, newLines: 7, section: 'export async function createSession(userId: string) {' });
    expect(h1.lines.slice(0, 4)).toEqual([
      { kind: 'ctx', text: 'const DAY = 86_400_000;', oldNo: 10, newNo: 10 },
      { kind: 'del', text: 'const TTL = 30;', oldNo: 11 },
      { kind: 'add', text: 'const TTL = 14;', newNo: 11 },
      { kind: 'add', text: 'const SLIDE = true;', newNo: 12 },
    ]);
    // An empty context line (git writes a lone space; some tools strip it).
    expect(h1.lines[4]).toEqual({ kind: 'ctx', text: '', oldNo: 12, newNo: 13 });
    expect(h1.lines).toHaveLength(8);
    // A removed line starting with "--" stays a removed line.
    expect(h2.lines.map((l) => l.kind)).toEqual(['ctx', 'del', 'ctx']);
    expect(h2.lines[1].text).toBe('-- a removed line that looks like a header');
    expect(h2.lines[2]).toMatchObject({ oldNo: 42, newNo: 42 });
    expect(toFileDiff('src/session.ts', p).status).toBe('modified');
  });

  it('knows new and deleted files, single-line hunks and the missing-newline marker', () => {
    const created = parseUnifiedDiff('diff --git a/x b/x\nnew file mode 100644\n--- /dev/null\n+++ b/x\n@@ -0,0 +1 @@\n+only\n\\ No newline at end of file\n');
    expect(created).toMatchObject({ created: true, added: 1, removed: 0 });
    expect(created.hunks[0]).toMatchObject({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1 });
    expect(toFileDiff('x', created).status).toBe('added');
    const gone = parseUnifiedDiff('deleted file mode 100644\n@@ -1,2 +0,0 @@\n-a\n-b\n');
    expect(toFileDiff('x', gone)).toMatchObject({ status: 'deleted', removed: 2, added: 0 });
  });

  it('flags binary files', () => {
    const p = parseUnifiedDiff('diff --git a/i.png b/i.png\nindex 1..2 100644\nBinary files a/i.png and b/i.png differ\n');
    expect(toFileDiff('i.png', p)).toMatchObject({ status: 'modified', binary: true, hunks: [] });
  });

  it('stops showing lines past the limit but keeps counting', () => {
    const body = Array.from({ length: 10 }, (_, i) => `+line ${i}`).join('\n');
    const p = parseUnifiedDiff(`@@ -0,0 +1,10 @@\n${body}\n@@ -20,1 +30,1 @@\n-x\n+y\n`, 4);
    expect(p.truncated).toBe(true);
    expect(p.added).toBe(11);
    expect(p.removed).toBe(1);
    expect(p.hunks).toHaveLength(1);
    expect(p.hunks[0].lines).toHaveLength(4);
  });

  it('treats an empty diff as unchanged', () => {
    expect(toFileDiff('a', parseUnifiedDiff(''))).toMatchObject({ status: 'unchanged', hunks: [] });
  });
});

describe('a file git does not know', () => {
  it('is every line added', () => {
    const d = allAdded('n.ts', 'a\r\nb\n');
    expect(d).toMatchObject({ status: 'added', added: 2, removed: 0 });
    expect(d.hunks[0].lines).toEqual([
      { kind: 'add', text: 'a', newNo: 1 },
      { kind: 'add', text: 'b', newNo: 2 },
    ]);
    expect(allAdded('e', '').hunks).toEqual([]);
  });
});

describe('diffFile against a real repository', () => {
  let repo: string;
  let plain: string;
  const run = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  const put = (rel: string, text: string) => {
    mkdirSync(join(repo, rel, '..'), { recursive: true });
    writeFileSync(join(repo, rel), text);
  };

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'iae-git-'));
    plain = mkdtempSync(join(tmpdir(), 'iae-nogit-'));
    run('init', '-q');
    run('config', 'user.email', 'test@example.com');
    run('config', 'user.name', 'Test');
    run('config', 'commit.gpgsign', 'false');
    put('src/a.ts', 'one\ntwo\nthree\n');
    put('same.ts', 'still\n');
    put('gone.ts', 'x\ny\n');
    put(':magic.ts', 'colon\n');
    run('add', '-A');
    run('commit', '-q', '-m', 'init');
    put('src/a.ts', 'one\n2\nthree\nfour\n');
    put('fresh.ts', 'new\nfile\n');
    unlinkSync(join(repo, 'gone.ts'));
    put(':magic.ts', 'colon!\n');
    writeFileSync(join(plain, 'a.ts'), 'x\n');
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(plain, { recursive: true, force: true });
  });

  it('shows a modified file', async () => {
    const d = await diffFile(repo, 'src/a.ts');
    expect(d).toMatchObject({ path: 'src/a.ts', status: 'modified', added: 2, removed: 1 });
    expect(d!.hunks[0].lines.map((l) => `${l.kind}:${l.text}`)).toEqual(['ctx:one', 'del:two', 'add:2', 'ctx:three', 'add:four']);
  });

  it('shows an untracked file as all added, a deleted one as all removed, an untouched one as unchanged', async () => {
    expect(await diffFile(repo, 'fresh.ts')).toMatchObject({ status: 'added', added: 2, removed: 0 });
    expect(await diffFile(repo, 'gone.ts')).toMatchObject({ status: 'deleted', added: 0, removed: 2 });
    expect(await diffFile(repo, 'same.ts')).toMatchObject({ status: 'unchanged', hunks: [] });
  });

  it('takes paths literally (no pathspec magic)', async () => {
    expect(await diffFile(repo, ':magic.ts')).toMatchObject({ status: 'modified', added: 1, removed: 1 });
  });

  it('refuses paths outside the project and folders', async () => {
    await expect(diffFile(repo, '../elsewhere.ts')).rejects.toThrow(/outside the project/);
    await expect(diffFile(repo, 'src')).rejects.toThrow(/folder/);
  });

  it('returns null outside a git repository', async () => {
    expect(await diffFile(plain, 'a.ts')).toBeNull();
  });
});
