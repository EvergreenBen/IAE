import { describe, expect, it } from 'vitest';
import { languageFor, wrapsByDefault } from './languages';

describe('lens languages', () => {
  it('highlights YAML, TOML and Dockerfiles', () => {
    expect(languageFor('infra/compose.yaml', 'yaml')).not.toBeNull();
    expect(languageFor('.github/workflows/ci.yml', 'text')).not.toBeNull();
    expect(languageFor('Cargo.toml')).not.toBeNull();
    expect(languageFor('infra/Dockerfile', 'text')).not.toBeNull();
    expect(languageFor('Dockerfile.dev')).not.toBeNull();
  });

  it('wraps prose and keeps code unwrapped', () => {
    expect(wrapsByDefault('README.md', 'markdown')).toBe(true);
    expect(wrapsByDefault('docs/notes.txt', 'text')).toBe(true);
    expect(wrapsByDefault('LICENSE', 'text')).toBe(true);
    expect(wrapsByDefault('src/app.ts', 'typescript')).toBe(false);
    expect(wrapsByDefault('infra/compose.yaml', 'yaml')).toBe(false);
    expect(wrapsByDefault('Makefile', 'text')).toBe(false);
  });
});
