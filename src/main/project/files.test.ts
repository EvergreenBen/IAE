import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectLanguage, readProjectFile, resolveInside, scanFiles, writeProjectFile } from './files';

let root: string;
let outside: string;

const put = (rel: string, content: string | Buffer = 'x') => {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'iae-files-'));
  outside = mkdtempSync(join(tmpdir(), 'iae-outside-'));
  put('.gitignore', '.env\n.env.*\ngenerated/\n*.log\n');
  put('package.json', '{}');
  put('.env', 'SECRET=1');
  put('apps/api/.env.local', 'A=1');
  put('apps/api/src/index.ts', 'export {}');
  put('apps/api/debug.log', 'noise');
  put('apps/web/.gitignore', 'tmp/\n');
  put('apps/web/tmp/cache.json', '{}');
  put('apps/web/page.tsx', 'x');
  put('generated/big.ts', 'x');
  put('node_modules/pkg/index.js', 'x');
  put('.iae/map.json', '{}');
  put('dist/out.js', 'x');
  put('.DS_Store', 'x');
  put('img.png', Buffer.from([0x89, 0x50, 0x00, 0x01]));
  writeFileSync(join(outside, 'secret.txt'), 'outside');
  symlinkSync(outside, join(root, 'link-out'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('scanFiles', () => {
  it('honours .gitignore (nested too) and hard ignores, but always keeps .env files', async () => {
    const paths = (await scanFiles(root)).map((f) => f.path).sort();
    expect(paths).toEqual(['.env', '.gitignore', 'apps/api/.env.local', 'apps/api/src/index.ts', 'apps/web/.gitignore', 'apps/web/page.tsx', 'img.png', 'package.json']);
  });

  it('caps the scan, shallow files first', async () => {
    const paths = (await scanFiles(root, 3)).map((f) => f.path);
    expect(paths).toHaveLength(3);
    expect(paths.every((p) => !p.includes('/'))).toBe(true);
  });
});

describe('read / write', () => {
  it('detects languages', () => {
    expect(detectLanguage('apps/api/.env')).toBe('env');
    expect(detectLanguage('.env.production')).toBe('env');
    expect(detectLanguage('a/b.tsx')).toBe('typescript');
    expect(detectLanguage('x.mjs')).toBe('javascript');
    expect(detectLanguage('schema.sql')).toBe('sql');
    expect(detectLanguage('ci.yml')).toBe('yaml');
    expect(detectLanguage('README.md')).toBe('markdown');
    expect(detectLanguage('Makefile')).toBe('text');
  });

  it('reads text and marks binaries unreadable', async () => {
    expect(await readProjectFile(root, '.env')).toMatchObject({ path: '.env', content: 'SECRET=1', language: 'env', size: 8 });
    expect(await readProjectFile(root, 'img.png')).toMatchObject({ unreadable: true, content: '' });
  });

  it('rejects paths that escape the project', async () => {
    await expect(resolveInside(root, '../etc/passwd')).rejects.toThrow(/outside the project/);
    await expect(resolveInside(root, '/etc/passwd')).rejects.toThrow(/outside the project/);
    await expect(readProjectFile(root, 'link-out/secret.txt')).rejects.toThrow(/outside the project/);
    await expect(writeProjectFile(root, 'link-out/new.txt', 'x')).rejects.toThrow(/outside the project/);
    await expect(writeProjectFile(root, '.git/config', 'x')).rejects.toThrow(/\.git/);
  });

  it('refuses to write through a link that points nowhere (it would create the target outside)', async () => {
    const target = join(outside, 'not-yet', 'planted.txt');
    symlinkSync(target, join(root, 'dangling.txt'));
    symlinkSync(join(outside, 'missing-dir'), join(root, 'dangling-dir'));
    await expect(writeProjectFile(root, 'dangling.txt', 'x')).rejects.toThrow(/points nowhere/);
    await expect(writeProjectFile(root, 'dangling-dir/new.txt', 'x')).rejects.toThrow(/points nowhere/);
    expect(existsSync(join(outside, 'missing-dir'))).toBe(false);
  });

  it('writes files, creating folders', async () => {
    expect(await writeProjectFile(root, 'apps/new/notes.md', '# hi')).toBe('apps/new/notes.md');
    expect((await readProjectFile(root, 'apps/new/notes.md')).content).toBe('# hi');
  });
});
