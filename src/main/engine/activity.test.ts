import { describe, expect, it } from 'vitest';
import { describeToolUse, humanCommand, projectPath, shortCommand } from './activity';

const ROOT = '/work/recipe-box';
const exists = (abs: string) => abs.endsWith('existing.ts');

describe('describeToolUse', () => {
  it('maps file tools to steps, activities and touches', () => {
    expect(describeToolUse(ROOT, 'Read', { file_path: `${ROOT}/apps/api/db/schema.ts` })).toEqual({
      kind: 'read',
      activity: 'Reading schema.ts',
      path: 'apps/api/db/schema.ts',
      touch: 'read',
    });
    expect(describeToolUse(ROOT, 'Edit', { file_path: `${ROOT}/src/session.ts` })).toMatchObject({ kind: 'edit', activity: 'Editing session.ts', touch: 'edit' });
    expect(describeToolUse(ROOT, 'MultiEdit', { file_path: 'src/a.ts' })).toMatchObject({ path: 'src/a.ts', touch: 'edit' });
  });

  it('tells creating a file from rewriting one', () => {
    expect(describeToolUse(ROOT, 'Write', { file_path: `${ROOT}/src/new.ts` }, exists)).toMatchObject({ activity: 'Creating new.ts', touch: 'create' });
    expect(describeToolUse(ROOT, 'Write', { file_path: `${ROOT}/src/existing.ts` }, exists)).toMatchObject({ activity: 'Writing existing.ts', touch: 'edit' });
  });

  it('does not touch files outside the project', () => {
    const a = describeToolUse(ROOT, 'Read', { file_path: '/etc/hosts' });
    expect(a).toEqual({ kind: 'read', activity: 'Reading hosts' });
  });

  it('describes commands and searches in a few words', () => {
    expect(describeToolUse(ROOT, 'Bash', { command: `cd "${ROOT}" && npm test` }).activity).toBe('Running tests');
    expect(describeToolUse(ROOT, 'Grep', { pattern: 'session' }).activity).toBe("Searching for 'session'");
    expect(describeToolUse(ROOT, 'Glob', { pattern: '**/*.sql' })).toMatchObject({ kind: 'search', activity: 'Looking for **/*.sql' });
    expect(describeToolUse(ROOT, 'mcp__iae__map_update', {}).activity).toBe('Updating the map');
    expect(describeToolUse(ROOT, 'mcp__linear__create_issue', {}).activity).toBe('Using linear create issue');
  });
});

describe('humanCommand', () => {
  it('says what a command is for, naming a chain by its most telling step', () => {
    expect(humanCommand('ls -la && ls -la .iae && node -v && pnpm install')).toBe('Installing packages');
    expect(humanCommand('cd apps/api && npx tsc --noEmit 2>&1 | tail -20')).toBe('Typechecking');
    expect(humanCommand('CI=1 pnpm run test -- --run')).toBe('Running tests');
    expect(humanCommand('npm run build')).toBe('Building');
    expect(humanCommand('git status && git diff --stat')).toBe('Reviewing changes');
    expect(humanCommand('npx prisma migrate dev --name init')).toBe('Running migrations');
    expect(humanCommand('open -a Docker')).toBe('Using Docker');
    expect(humanCommand('ls -la apps')).toBe('Checking the project');
    expect(humanCommand(`node ${ROOT}/scripts/seed-database-with-example-recipes.mjs`, ROOT)).toBe('Running node seed-database-with-example…');
    expect(humanCommand('')).toBe('Running a command');
  });
});

describe('helpers', () => {
  it('shortCommand strips cd prefixes and the project root', () => {
    expect(shortCommand('cd /x && cd y; pnpm build\necho done')).toBe('pnpm build');
    expect(shortCommand(`ls -la "${ROOT}"`, ROOT)).toBe('ls -la .');
  });

  it('projectPath keeps only paths inside the root', () => {
    expect(projectPath(ROOT, `${ROOT}/a/b.ts`)).toBe('a/b.ts');
    expect(projectPath(ROOT, `${ROOT}/../other/b.ts`)).toBeNull();
    expect(projectPath(ROOT, ROOT)).toBeNull();
    expect(projectPath(ROOT, 42)).toBeNull();
  });
});
