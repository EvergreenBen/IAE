// The compact <context> block wrapped around every lead turn: what the person
// is looking at, the crew, the open agenda, and the map. The whole map goes
// out on a session's first turn (and after big redraws); after that only what
// others changed, because the lead remembers the rest. A small history keeps
// the lead fast.

import { describeMap } from '../../shared/map';
import type { AgendaItem, ArchMap, Decision } from '../../shared/model';
import { describeChanges } from './mapdiff';
import type { LeadEvent, Workspace } from './workspace';

export type TurnKind = 'user' | 'events' | 'pulse';

const label = (map: ArchMap, id: string | null | undefined): string | null =>
  id && map.nodes[id] ? `${map.nodes[id].label} [${id}]` : null;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

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

export function agendaLine(item: AgendaItem, agentName: (id: string) => string, onScreen = false): string {
  const bits = [`[${item.id}] ${item.kind}`];
  if (item.nodeId) bits.push(`on ${item.nodeId}`);
  if (item.blocking?.length) bits.push(`BLOCKING ${item.blocking.map(agentName).join(', ')}`);
  let line = `- ${bits.join(' ')}: "${item.prompt}"`;
  if (item.options?.length) line += ` options: ${item.options.join(' | ')}`;
  if (onScreen) line += ' (the card on screen)';
  return line;
}

export function decisionLine(d: Decision): string {
  return `- ${clip(d.title, 90)}${d.rationale ? ` (${clip(d.rationale, 90)})` : ''}${d.nodeId ? ` [${d.nodeId}]` : ''}`;
}

export interface MapSeen {
  version: number;
  /** Node ids on the map at that version (to tell new nodes from changed ones). */
  ids: ReadonlySet<string>;
}

export interface ContextInput {
  ws: Workspace;
  crew: string[];
  agentName: (id: string) => string;
  /** The map as the lead last saw it; null sends the whole map. */
  seen: MapSeen | null;
  /** Recorded decisions go out on a session's first turn. */
  withDecisions?: boolean;
  /** Set when every builder slot is taken ("all 3 builder slots are busy…"). */
  slots?: string;
  /** One-time notes for this turn ("Your name is now Juniper"). */
  notes?: string[];
  kind?: TurnKind;
}

/** The map part of the context, and whether it was the whole map. */
export function mapSection(ws: Workspace, seen: MapSeen | null): { text: string; full: boolean } {
  const full = () => ({ text: `map:\n${describeMap(ws.map, ws.files)}`, full: true });
  if (!seen) return full();
  if (seen.version === ws.mapVersion) return { text: 'map: unchanged since your last turn', full: false };
  const oldest = ws.mapLog[0]?.version ?? Infinity;
  if (oldest > seen.version + 1) return full();
  const lines = describeChanges(ws.map, ws.mapLog, seen.version, seen.ids);
  if (lines === null) return full();
  if (!lines.length) return { text: 'map: only your own changes since your last turn', full: false };
  return { text: `map changes by others since your last turn:\n${lines.join('\n')}`, full: false };
}

export function buildContext(i: ContextInput): { text: string; fullMap: boolean } {
  const { ws, crew, agentName } = i;
  const lines: string[] = [];
  for (const n of i.notes ?? []) lines.push(`note: ${n}`);
  const fileCount = ws.files.length;
  lines.push(`project: ${ws.info.name} · ${fileCount} file${fileCount === 1 ? '' : 's'}${ws.info.isNew ? ' · started empty in IAE' : ''}`);
  lines.push(viewLine(ws));
  lines.push(crew.length ? `crew:\n${crew.map((c) => `- ${c}`).join('\n')}${i.slots ? `\n${i.slots}` : ''}` : 'crew: nobody working');
  const open = ws.agenda.open();
  lines.push(open.length ? `open agenda (top first):\n${open.map((it, n) => agendaLine(it, agentName, n === 0)).join('\n')}` : 'open agenda: none');
  if (i.withDecisions) {
    const ds = ws.agenda.allDecisions().slice(-12);
    if (ds.length) lines.push(`decided so far (don't re-ask):\n${ds.map(decisionLine).join('\n')}`);
  }
  const map = mapSection(ws, i.seen);
  lines.push(map.text);
  if (i.kind && i.kind !== 'user') {
    const planned = Object.values(ws.map.nodes).filter((n) => n.status === 'planned' || n.status === 'broken');
    if (planned.length) lines.push(`not built yet: ${planned.slice(0, 12).map((n) => `${n.id}${n.status === 'broken' ? ' (broken)' : ''}`).join(', ')}${planned.length > 12 ? ', …' : ''}`);
  }
  return { text: `<context>\n${lines.join('\n')}\n</context>`, fullMap: map.full };
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
