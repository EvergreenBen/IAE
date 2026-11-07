// Which agent every session runs on. Sessions call `query` and `toolServer`
// from here, never the Claude Agent SDK directly: with Codex chosen in
// Settings, the same calls run on Codex (see ./codex), which speaks the
// SDK's messages so nothing above this line needs to know.

import { createSdkMcpServer, query as claudeQuery, type McpSdkServerConfigWithInstance, type Options, type Query, type SDKUserMessage, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { Provider } from '../../shared/model';
import { CodexQuery } from './codex/query';
import { CODEX_SESSION } from './codex/translate';

export type { Query };

interface Current {
  provider: Provider;
  /** Codex's model for every role; empty → Codex's default. */
  codexModel: string;
}

let current: Current = { provider: 'claude', codexModel: '' };

export function useProvider(next: Current): void {
  current = { provider: next.provider, codexModel: next.codexModel };
}

export const provider = (): Provider => current.provider;

/** A saved session the current agent can pick up (Codex's ids are marked; see codex/translate.ts). */
export const resumable = (sessionId: string | undefined): sessionId is string => !!sessionId && sessionId.startsWith(CODEX_SESSION) === (current.provider === 'codex');

export function query(args: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Query {
  if (current.provider === 'codex') return new CodexQuery(args.prompt, args.options ?? {}, current.codexModel) as unknown as Query;
  return claudeQuery(args);
}

/** The tools behind each in-process server, so Codex can be given them over a local connection. */
const definitions = new WeakMap<object, SdkMcpToolDefinition<never>[]>();

/** createSdkMcpServer, remembering its tools. */
export function toolServer(opts: Parameters<typeof createSdkMcpServer>[0]): McpSdkServerConfigWithInstance {
  const server = createSdkMcpServer(opts);
  definitions.set(server, (opts.tools ?? []) as unknown as SdkMcpToolDefinition<never>[]);
  return server;
}

export const toolDefinitions = (server: object): SdkMcpToolDefinition<never>[] => definitions.get(server) ?? [];
