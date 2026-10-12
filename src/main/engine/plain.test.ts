import { describe, expect, it } from 'vitest';
import { describeToolUse } from './activity';
import { plainActivity, streamedPath } from './plain';

const ROOT = '/work/recipe-box';
const plain = (name: string, input: Record<string, unknown>, exists = (_: string) => true) => plainActivity(name, describeToolUse(ROOT, name, input, exists));

describe('plainActivity', () => {
  it('says what kind of work, never the file', () => {
    expect(plain('Read', { file_path: `${ROOT}/apps/jobs/src/index.ts` })).toBe('Reading the code');
    expect(plain('Grep', { pattern: 'jobs|INSERT' })).toBe('Reading the code');
    expect(plain('Edit', { file_path: `${ROOT}/apps/jobs/src/worker.ts` })).toBe('Making changes');
    expect(plain('Write', { file_path: `${ROOT}/apps/jobs/src/retry.ts` }, () => false)).toBe('Adding new code');
  });

  it('names commands by what they are for', () => {
    expect(plain('Bash', { command: `cd "${ROOT}" && npm test` })).toBe('Running the tests');
    expect(plain('Bash', { command: 'npx tsc --noEmit' })).toBe('Checking for mistakes');
    expect(plain('Bash', { command: 'npx drizzle-kit generate' })).toBe('Updating the database');
    expect(plain('Bash', { command: 'ls -la apps' })).toBe('Looking around');
    expect(plain('Bash', { command: 'node scripts/check.mjs' })).toBe('Running a check');
  });

  it('keeps the few tools that already speak plainly', () => {
    expect(plain('mcp__iae__map_update', {})).toBe('Updating the map');
    expect(plain('mcp__iae__ask_architect', {})).toBe('Asking you something');
    expect(plain('WebSearch', { query: 'drizzle migrations' })).toBe('Looking things up');
  });

  it('never shows an internal tool name', () => {
    expect(plain('ToolSearch', { query: 'select:Foo' })).toBe('Working on it');
    expect(plain('BashOutput', {})).toBe('Working on it');
    expect(plain('mcp__linear__create_issue', {})).toBe('Using linear');
  });
});

describe('streamedPath', () => {
  it('reads the file a write names before its input has finished streaming', () => {
    expect(streamedPath('{"file_path": "/work/recipe-box/apps/jobs/src/wor')).toBeNull();
    expect(streamedPath('{"file_path": "/work/recipe-box/apps/jobs/src/worker.ts", "old_str')).toBe('/work/recipe-box/apps/jobs/src/worker.ts');
    expect(streamedPath('{"notebook_path":"a\\\\b.ipynb"')).toBe('a\\b.ipynb');
  });
});
