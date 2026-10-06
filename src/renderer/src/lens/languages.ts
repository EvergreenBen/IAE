// Pick a CodeMirror language for a file. Grammar packages for the common web
// languages; tiny stream modes for .env and SQL so they still read well, and
// CodeMirror's legacy modes for config formats (YAML, TOML, Dockerfile).
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { StreamLanguage, type StreamParser } from '@codemirror/language';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { yaml } from '@codemirror/legacy-modes/mode/yaml';
import type { Extension } from '@codemirror/state';
import { tags } from '@lezer/highlight';

const envParser: StreamParser<{ afterEq: boolean }> = {
  name: 'env',
  startState: () => ({ afterEq: false }),
  token(stream, state) {
    if (stream.sol()) state.afterEq = false;
    if (stream.eatSpace()) return null;
    if (stream.match('#')) {
      stream.skipToEnd();
      return 'comment';
    }
    if (!state.afterEq) {
      if (stream.match(/^export\b/)) return 'keyword';
      if (stream.match(/^[A-Za-z_][\w.-]*/)) return 'propertyName';
      if (stream.eat('=')) {
        state.afterEq = true;
        return 'operator';
      }
      stream.next();
      return null;
    }
    if (stream.match(/^\s+#.*/)) return 'comment';
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/) || stream.match(/^'[^']*'?/)) return 'string';
    if (stream.match(/^-?\d+(\.\d+)?(?=\s|$)/)) return 'number';
    if (stream.match(/^(true|false)(?=\s|$)/)) return 'bool';
    stream.match(/^[^\s#]+/) || stream.next();
    return 'string';
  },
  languageData: { commentTokens: { line: '#' } },
};

const SQL_KEYWORDS =
  /^(select|from|where|and|or|not|insert|into|values|update|set|delete|create|table|index|unique|on|primary|key|references|foreign|alter|add|drop|column|if|exists|default|null|constraint|join|left|right|inner|outer|group|by|order|limit|offset|as|returning|begin|commit|cascade|using|with|timestamp|timestamptz|text|integer|bigint|serial|uuid|boolean|varchar|jsonb|now)\b/i;

const sqlParser: StreamParser<null> = {
  name: 'sql',
  startState: () => null,
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.match('--')) {
      stream.skipToEnd();
      return 'comment';
    }
    if (stream.match(/^'(?:[^']|'')*'?/)) return 'string';
    if (stream.match(/^\d+(\.\d+)?/)) return 'number';
    if (stream.match(/^(true|false)\b/i)) return 'bool';
    if (stream.match(SQL_KEYWORDS)) return 'keyword';
    if (stream.match(/^"[^"]*"?/) || stream.match(/^[A-Za-z_]\w*/)) return 'variableName';
    stream.next();
    return 'punctuation';
  },
  languageData: { commentTokens: { line: '--' } },
};

const shellParser: StreamParser<null> = {
  name: 'shell',
  startState: () => null,
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.match('#')) {
      stream.skipToEnd();
      return 'comment';
    }
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/) || stream.match(/^'[^']*'?/)) return 'string';
    if (stream.match(/^\$\{?[\w]+\}?/)) return 'variableName';
    if (stream.match(/^(if|then|else|fi|for|in|do|done|case|esac|while|export|function|return|local)\b/)) return 'keyword';
    stream.match(/^[^\s#"'$]+/) || stream.next();
    return null;
  },
};

const envLanguage = StreamLanguage.define(envParser);
const sqlLanguage = StreamLanguage.define(sqlParser);
const shellLanguage = StreamLanguage.define(shellParser);
// The YAML mode calls keys "atom" and true/yes/on "keyword"; read them as
// property names and booleans, like the .env mode does.
const yamlLanguage = StreamLanguage.define({ ...yaml, tokenTable: { atom: tags.propertyName, keyword: tags.bool } });
const tomlLanguage = StreamLanguage.define(toml);
const dockerLanguage = StreamLanguage.define(dockerFile);

const ext = (path: string) => {
  const base = path.split('/').pop() ?? '';
  if (base === '.env' || base.startsWith('.env.') || base.endsWith('.env')) return 'env';
  if (/^(dockerfile|containerfile)(\..+)?$/i.test(base) || /\.dockerfile$/i.test(base)) return 'dockerfile';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : base.toLowerCase();
};

export function isEnvFile(path: string, language?: string): boolean {
  return language === 'env' || ext(path) === 'env';
}

export function languageFor(path: string, language?: string): Extension | null {
  const key = (language && language !== 'text' ? language : ext(path)).toLowerCase();
  switch (key) {
    case 'ts':
    case 'mts':
    case 'cts':
    case 'typescript':
      return javascript({ typescript: true });
    case 'tsx':
      return javascript({ typescript: true, jsx: true });
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'javascript':
      return javascript();
    case 'jsx':
      return javascript({ jsx: true });
    case 'json':
    case 'jsonc':
      return json();
    case 'md':
    case 'mdx':
    case 'markdown':
      return markdown();
    case 'py':
    case 'python':
      return python();
    case 'css':
    case 'scss':
      return css();
    case 'html':
    case 'htm':
    case 'svg':
    case 'xml':
      return html();
    case 'sql':
      return sqlLanguage;
    case 'env':
      return envLanguage;
    case 'sh':
    case 'bash':
    case 'zsh':
    case 'shell':
      return shellLanguage;
    case 'yml':
    case 'yaml':
      return yamlLanguage;
    case 'toml':
      return tomlLanguage;
    case 'dockerfile':
      return dockerLanguage;
    default:
      return null;
  }
}

const PROSE = new Set(['md', 'mdx', 'markdown', 'txt', 'text', 'rst', 'adoc', 'asciidoc', 'org', 'log']);
const PROSE_NAMES = /^(readme|license|licence|changelog|changes|authors|contributing|notice|copying|todo|history)(\..*)?$/i;

/** Prose and long-line files read best wrapped; code keeps its lines. */
export function wrapsByDefault(path: string, language?: string): boolean {
  const base = path.split('/').pop() ?? '';
  if (PROSE_NAMES.test(base) && !/\.(js|ts|py|json|ya?ml|toml|html?)$/i.test(base)) return true;
  if (language === 'markdown') return true;
  return PROSE.has(ext(path));
}

/** Prefer JSX-aware parsing for .tsx/.jsx even when the engine says 'typescript'. */
export function languageForFile(path: string, language?: string): Extension | null {
  const e = ext(path);
  if (e === 'tsx' || e === 'jsx') return languageFor(path, e);
  return languageFor(path, language);
}
