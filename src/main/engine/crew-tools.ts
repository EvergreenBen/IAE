// The small "iae" MCP server each builder, scout and the cartographer gets.
// One instance per session (an instance binds to a single transport).

import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { AgendaItem, NodeStatus, OpSource } from '../../shared/model';
import { projectPath } from './activity';
import { anchorNode } from './agenda';
import { describeResult, normalizeOps, opInput, type OpName } from './mapops';
import type { ProgressReport } from './progress';
import { fail, guard, ok } from './tools';
import type { Workspace } from './workspace';

export const ANSWER_TIMEOUT_MS = 15 * 60_000;

export interface CrewToolHost {
  ws: Workspace;
  agentId: string;
  source: OpSource;
  allowedOps: readonly OpName[];
  /** Ends blocking waits when the job is stopped. */
  signal: AbortSignal;
  /** Expose ask_architect (builders and scouts). */
  canAsk: boolean;
  /** Expose file_notes (the cartographer). */
  canNote: boolean;
  /** Expose progress (builders): their plan, shown as a bar with a time-left estimate. */
  canProgress?: boolean;
  onAsked?(item: AgendaItem, blocking: boolean): void;
  onWaiting?(waiting: boolean): void;
  onProgress?(report: ProgressReport): void;
}

export const crewToolNames = (h: Pick<CrewToolHost, 'canAsk' | 'canNote' | 'canProgress'>): string[] => [
  'mcp__iae__map_update',
  ...(h.canAsk ? ['mcp__iae__ask_architect'] : []),
  ...(h.canNote ? ['mcp__iae__file_notes'] : []),
  ...(h.canProgress ? ['mcp__iae__progress'] : []),
];

export function createCrewTools(h: CrewToolHost): McpSdkServerConfigWithInstance {
  const { ws } = h;
  const restricted = h.allowedOps.length < 5;
  const defaultStatus = ({ paths }: { paths?: string[] }): NodeStatus => (paths?.length ? 'built' : 'planned');

  const tools: SdkMcpToolDefinition<any>[] = [
    tool(
      'map_update',
      `Keep the architecture map truthful. Ops apply in order: {op:"upsertNode", node:{id, parentId?, label?, techLabel?, kind?, status?, summary?, tech?, paths?}}, {op:"upsertEdge", edge:{from, to, kind?, label?}}${
        restricted ? '' : ', {op:"removeNode", id}, {op:"moveNode", id, parentId}, {op:"removeEdge", id:"from->to"}'
      }. kind: system|client|service|module|data|queue|external|config|infra|ai. paths: project-relative directory prefixes ending in "/" or exact files. label: the plain-English role ("Saves your recipes"); techLabel: the developer's name ("Recipe DB"). Reuse existing node ids where they fit.`,
      { ops: z.array(opInput) },
      (args) =>
        guard('map_update', () => {
          if (!args.ops?.length) return fail('No ops given.');
          const r = normalizeOps(args.ops, ws.map, { allowed: h.allowedOps, root: ws.root, defaultStatus });
          ws.applyMapOps(r.ops, h.source);
          return r.ops.length ? ok(describeResult(r)) : fail(describeResult(r));
        }),
    ),
  ];

  if (h.canAsk) {
    tools.push(
      tool(
        'ask_architect',
        'Ask the human architect a question (through the lead). Only for choices that are genuinely theirs: taste, business rules, or irreversible changes. With blocking:true you wait for the answer (up to 15 minutes); otherwise continue on your best default.',
        {
          prompt: z.string().describe('The question, ≤ 25 words, naming the real parts involved.'),
          why: z.string().optional().describe('One line: why it matters now.'),
          options: z.array(z.string()).optional().describe('2–4 short answers, your recommendation first.'),
          node_id: z.string().optional(),
          blocking: z.boolean().optional().describe('Wait for the answer. Only when continuing would waste real work.'),
        },
        (args) =>
          guard('ask_architect', async () => {
            if (!args.prompt?.trim()) return fail('prompt is required.');
            const blocking = !!args.blocking;
            const nodeId = anchorNode(ws.map, args.node_id, ws.view.scopeId);
            const item = ws.agenda.ask({
              prompt: args.prompt,
              kind: 'decision',
              why: args.why,
              options: args.options,
              nodeId,
              priority: blocking ? 0.95 : 0.6,
              blocking: blocking ? [h.agentId] : [],
            });
            h.onAsked?.(item, blocking);
            if (!blocking) {
              return ok(`Asked [${item.id}]. Continue on your best default and note the assumption; if the answer changes things you'll get a message.`);
            }
            h.onWaiting?.(true);
            const answer = await ws.agenda.waitFor(item.id, ANSWER_TIMEOUT_MS, h.signal);
            h.onWaiting?.(false);
            if (answer === null) {
              // Going on with a default: the card no longer holds this builder up.
              ws.agenda.removeBlocker(item.id, h.agentId);
              return ok('No answer. Use your best default, note the assumption in your final summary, and continue.');
            }
            return ok(`The architect answered: ${answer}`);
          }),
      ),
    );
  }

  if (h.canNote) {
    tools.push(
      tool(
        'file_notes',
        'Record one-line meanings for important files ("what this file is for"). Plain words, ≤ 15 words each.',
        { notes: z.array(z.object({ path: z.string(), note: z.string() })) },
        (args) =>
          guard('file_notes', () => {
            const known: { path: string; note: string }[] = [];
            const unknown: string[] = [];
            for (const n of args.notes ?? []) {
              const path = projectPath(ws.root, n.path);
              if (path && ws.hasFile(path)) known.push({ path, note: n.note });
              else unknown.push(n.path);
            }
            const saved = ws.addNotes(known);
            return ok(`Saved ${saved} note${saved === 1 ? '' : 's'}.${unknown.length ? ` Unknown paths skipped: ${unknown.slice(0, 5).join(', ')}.` : ''}`);
          }),
      ),
    );
  }

  if (h.canProgress) {
    tools.push(
      tool(
        'progress',
        'Show the person how far along you are. They see your current step on the map, where you\'re working, and a progress bar with a time-left estimate beside your name. Send steps as soon as you know your plan, before your first edit: 3–6 steps in order, each one what the person would notice or what changes in their system, in everyday words under 8 words, never file names or code ("Failed jobs try again", "Wait longer between tries", "The weekly email lists retries", "Check it all works"). Each time you finish one, send done: how many are finished, in the same message as your next tool call so it costs no time. Send steps again if the plan changes.',
        {
          steps: z.array(z.string()).optional().describe('The whole plan, in order.'),
          done: z.number().int().min(0).optional().describe('How many steps are finished.'),
        },
        (args) =>
          guard('progress', () => {
            if (!args.steps?.length && args.done === undefined) return fail('Send steps, done, or both.');
            h.onProgress?.(args);
            return ok('Shown.');
          }),
      ),
    );
  }

  // alwaysLoad: never hide these behind tool search (builders may carry many MCP tools).
  return createSdkMcpServer({ name: 'iae', version: '0.1.0', tools, alwaysLoad: true, timeout: ANSWER_TIMEOUT_MS + 60_000 });
}
