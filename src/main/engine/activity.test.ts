import { describe, expect, it } from 'vitest';
import { commandSummary, describeToolUse, humanCommand, projectPath, shortCommand, shortenPaths, splitShell } from './activity';
import { permissionSummary } from './crew';

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

describe('builder commands behind a cd', () => {
  const CRAG = '/Users/ana/Desktop/IAE Projects/Crag Night';
  const cd = `cd "${CRAG}" && `;

  it('classifies by the real command, not the cd', () => {
    expect(humanCommand(`${cd}npm install express`, CRAG)).toBe('Installing packages');
    expect(humanCommand(`cd ${CRAG.replace(/ /g, '\\ ')} && npx tsc --noEmit`, CRAG)).toBe('Typechecking');
    expect(humanCommand(`cd "${CRAG}/server"; node scripts/seed.mjs`, CRAG)).toBe('Running node seed.mjs');
    expect(humanCommand(`cd "${CRAG}"\nnpm test`, CRAG)).toBe('Running tests');
  });

  it('reads a live server check as a server check, not as the cleanup around it', () => {
    const check = `${cd}(PORT=4123 node server/index.js > /tmp/crag.log 2>&1 &) ; sleep 2; curl -s http://localhost:4123/api/health; kill %1; rm -f /tmp/crag.log`;
    expect(humanCommand(check, CRAG)).toBe('Checking the running server');
    expect(humanCommand(`${cd}rm -f data/test.db && nohup node server.js > /dev/null 2>&1 & sleep 1 && curl -sf 127.0.0.1:3000/ | head -5`, CRAG)).toBe('Checking the running server');
    expect(humanCommand(`${cd}lsof -ti:4123 | xargs kill -9; rm -rf .cache`, CRAG)).toBe('Stopping a process');
    expect(humanCommand(`${cd}rm -rf dist && mkdir dist && node build.mjs`, CRAG)).toBe('Running node build.mjs');
    expect(humanCommand(`${cd}rm -rf dist`, CRAG)).toBe('Removing files');
    expect(humanCommand('curl -s https://api.stripe.com/v1/charges')).toBe('Calling a web address');
  });

  it('splits on shell operators outside quotes only', () => {
    expect(splitShell('echo "a && b | c" && grep -c x \'y;z\' | wc -l')).toEqual(['echo "a && b | c"', "grep -c x 'y;z'", 'wc -l']);
    expect(splitShell('node a.js > out.log 2>&1 & curl x &>/dev/null')).toEqual(['node a.js > out.log 2>&1', 'curl x &>/dev/null']);
  });

  it('permission cards show the command that really runs, with long paths shortened', () => {
    expect(permissionSummary('Bash', { command: `${cd}npm install better-sqlite3` }, CRAG)).toBe('Run npm install better-sqlite3');
    expect(permissionSummary('Bash', { command: `${cd}node server/index.js & sleep 2 && curl -s localhost:4123/health` }, CRAG)).toBe(
      'Run node server/index.js & sleep 2 && curl -s localhost:4123/health',
    );
    expect(commandSummary(`${cd}cp /Users/ana/Downloads/exports/2026/october/members.csv data/`, CRAG, '/Users/ana')).toBe('cp ~/…/october/members.csv data/');
    expect(commandSummary(`${cd}ls /opt/homebrew/var/postgresql@16/base/pgsql_tmp/x`, CRAG)).toBe('ls /opt/…/pgsql_tmp/x');
    expect(commandSummary(`${cd}npm run migrate\nnpm test`, CRAG)).toBe('npm run migrate …');
    expect(commandSummary(`cd "${CRAG}"`, CRAG)).toBe('cd .');
    expect(permissionSummary('Write', { file_path: `${CRAG}/server/db.ts` })).toBe('Write db.ts');
  });

  it('leaves short paths and URLs alone', () => {
    expect(shortenPaths('cat /etc/hosts && curl http://localhost:3000/a/b/c/d/e')).toBe('cat /etc/hosts && curl http://localhost:3000/a/b/c/d/e');
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
