// Arxitect's own tools (sketch_map, ask, progress…), served to a Codex session.
// Claude Code runs them in-process; Codex can only reach MCP servers it
// connects to, so each session gets a private one on 127.0.0.1, behind a
// random path. Stateless: Codex starts a process (and connects again) per turn.

import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { debug } from '../sdk';

/** Before a tool runs: a reason to refuse it, or null to let it run (the lead's PreToolUse hold). */
export type ToolGate = (toolName: string, input: unknown) => Promise<string | null>;

export interface ToolHost {
  url: string;
  close(): void;
}

export async function serveTools(name: string, defs: SdkMcpToolDefinition<never>[], gate?: ToolGate): Promise<ToolHost> {
  const secret = randomBytes(16).toString('hex');

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.url !== `/${secret}`) return void res.writeHead(404).end();
    if (req.method !== 'POST') return void res.writeHead(405).end();
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return void res.writeHead(400).end();
    }
    const server = mcpServer(name, defs, gate);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };

  const http = createServer((req, res) => {
    handle(req, res).catch((e) => {
      debug('codex', 'tool server', e);
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  // An ask waits for the person's answer (up to 15 minutes): no timeouts here.
  http.requestTimeout = 0;
  http.headersTimeout = 0;
  http.timeout = 0;
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/${secret}`,
    close: () => {
      http.closeAllConnections();
      http.close();
    },
  };
}

function mcpServer(name: string, defs: SdkMcpToolDefinition<never>[], gate?: ToolGate): McpServer {
  const server = new McpServer({ name, version: '0.1.0' });
  for (const def of defs) {
    server.registerTool(def.name, { description: def.description, inputSchema: def.inputSchema, ...(def.annotations ? { annotations: def.annotations } : {}) }, (async (args: never, extra: unknown) => {
      const refused = await gate?.(`mcp__${name}__${def.name}`, args);
      if (refused) return { content: [{ type: 'text', text: refused }], isError: true } satisfies CallToolResult;
      return def.handler(args, extra);
    }) as never);
  }
  return server;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
