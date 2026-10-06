// The compact <context> block wrapped around every lead turn: what the person
// is looking at, the crew, the open agenda, and the map (only when it moved).

import { describeMap } from '../../shared/map';
import type { AgendaItem, ArchMap } from '../../shared/model';
import type { LeadEvent, Workspace } from './workspace';

export type TurnKind = 'user' | 'events' | 'pulse';

const label = (map: ArchMap, id: string | null | undefined): string | null =>
  id && map.nodes[id] ? `${map.nodes[id].label} [${id}]` : null;

function viewLine(ws: Workspace): string {
  const { scopeId, selectedNodeId, openFile } = ws.view;
  const bits: string[] = [];
  bits.push(label(ws.map, scopeId) ? `inside ${label(ws.map, scopeId)}` : 'the top level');
  const sel = label(ws.map, selectedNodeId);
  if (sel) bits.push(`selected ${sel}`);
  if (openFile) {
    const owner = ws.files.find((f) => f.path === openFile)?.nodeId;
    bits.push(`open file ${openFile}${owner ? ` (in ${owner})` : ''}`);
  }
  return `looking at: ${bits.join(' · ')}`;
}

export function agendaLine(item: AgendaItem, agentName: (id: string) => string): string {
  const bits = [`[${item.id}] ${item.kind}`];
  if (item.nodeId) bits.push(`on ${item.nodeId}`);
  if (item.blocking?.length) bits.push(`BLOCKING ${item.blocking.map(agentName).join(', ')}`);
  let line = `- ${bits.join(' ')}: "${item.prompt}"`;
  if (item.options?.length) line += ` options: ${item.options.join(' | ')}`;
  return line;
}

export interface ContextInput {
  ws: Workspace;
  crew: string[];
  agentName: (id: string) => string;
  includeMap: boolean;
}

export function buildContext({ ws, crew, agentName, includeMap }: ContextInput): string {
  const lines: string[] = [];
  const fileCount = ws.files.length;
  lines.push(`project: ${ws.info.name} · ${fileCount} file${fileCount === 1 ? '' : 's'}${ws.info.isNew ? ' · started empty in IAE' : ''}`);
  lines.push(viewLine(ws));
  lines.push(crew.length ? `crew:\n${crew.map((c) => `- ${c}`).join('\n')}` : 'crew: nobody working');
  const open = ws.agenda.open();
  lines.push(open.length ? `open agenda (top first):\n${open.map((i) => agendaLine(i, agentName)).join('\n')}` : 'open agenda: none');
  lines.push(includeMap ? `map:\n${describeMap(ws.map, ws.files)}` : 'map: unchanged since your last turn');
  return `<context>\n${lines.join('\n')}\n</context>`;
}

export function eventsBlock(events: LeadEvent[]): string {
  if (!events.length) return '';
  return `<events>\n${events.map((e) => `- ${e.text}`).join('\n')}\n</events>`;
}

/**
 * One lead turn: context, then events (if any), then what prompted the turn.
 * For an events turn, `body` is folded into the events block.
 */
export function wrapTurn(context: string, events: LeadEvent[], kind: TurnKind, body: string): string {
  const all = kind === 'events' && body.trim() ? [...events, { text: body.trim(), urgent: false, at: Date.now() }] : events;
  const parts = [context];
  const ev = eventsBlock(all);
  if (ev) parts.push(ev);
  if (kind === 'user') parts.push(`<user_said>${body}</user_said>`);
  else if (kind === 'pulse') parts.push(`<pulse>${body}</pulse>`);
  return parts.join('\n');
}
