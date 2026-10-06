import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineEvent } from '../../shared/events';
import { emptyMap } from '../../shared/map';
import { DEFAULT_SETTINGS, type AgendaItem } from '../../shared/model';

// A scripted Claude session: each user message is answered with the next reply
// (streamed as text deltas, optionally followed by a tool call).
const replies: { text: string[]; tool?: boolean; before?: () => void }[] = [];
vi.mock('@anthropic-ai/claude-agent-sdk', async (orig) => ({
  ...(await orig<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query: ({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    let n = 0;
    async function* run() {
      yield { type: 'system', subtype: 'init', session_id: 's1', model: 'm' };
      for await (const _ of prompt) {
        const r = replies.shift() ?? { text: ['<silence/>'] };
        r.before?.();
        const id = `msg-${++n}`;
        const ev = (event: unknown) => ({ type: 'stream_event', parent_tool_use_id: null, event });
        yield ev({ type: 'message_start', message: { id } });
        yield ev({ type: 'content_block_start', content_block: { type: 'text' } });
        for (const text of r.text) yield ev({ type: 'content_block_delta', delta: { type: 'text_delta', text } });
        if (r.tool) yield ev({ type: 'content_block_start', content_block: { type: 'tool_use' } });
        yield { type: 'assistant', parent_tool_use_id: null, message: { id, content: [] } };
        yield { type: 'result', subtype: 'success', session_id: 's1' };
      }
    }
    return Object.assign(run(), { interrupt: async () => {}, close: () => {} });
  },
}));

const { Lead } = await import('./lead');

const card: AgendaItem = {
  id: 'q1',
  kind: 'decision',
  prompt: 'Should members sign in with their gym membership number or a separate app account?',
  options: ['Membership number', 'Separate account'],
  nodeId: null,
  priority: 0.6,
  status: 'open',
  createdAt: 0,
};

function setup(open: AgendaItem[]) {
  const events: EngineEvent[] = [];
  const ws = {
    root: '/tmp/crag',
    map: emptyMap(),
    files: [],
    info: { name: 'Crag Night', isNew: true },
    view: { scopeId: null, selectedNodeId: null, openFile: null },
    mapVersion: 1,
    mapLog: [],
    state: {},
    agenda: { open: () => open, allDecisions: () => [] },
    takeEvents: () => [],
    pushEvent: () => {},
    saveState: () => {},
    appendTranscript: () => ({}),
  };
  const lead = new Lead({
    ws: ws as never,
    emit: (e) => events.push(e),
    settings: () => DEFAULT_SETTINGS,
    makeTools: () => ({}) as never,
    crewLines: () => [],
    agentName: (id) => id,
    onClaudeStatus: () => {},
  });
  const turn = async (body: string, kind: 'user' | 'pulse' = 'user') => {
    const from = events.length;
    lead.send(kind, body);
    await vi.waitFor(() => expect(events.slice(from).some((e) => e.type === 'lead/done')).toBe(true));
    const mine = events.slice(from);
    const spoken = mine.map((e) => (e.type === 'lead/delta' ? e.text : '')).join('');
    const done = mine.find((e) => e.type === 'lead/done');
    return { spoken, text: done?.type === 'lead/done' ? done.text : '' };
  };
  return { lead, turn };
}

afterEach(() => {
  replies.length = 0;
});

describe('Lead and an open card', () => {
  it('lets a nudge bring a card back once while builders work, not again', async () => {
    const open: AgendaItem[] = [];
    const { lead, turn } = setup(open);
    replies.push({ text: ['Front desk is sketched.', ' Should members sign in with their membership number, or a separate account?'], before: () => open.push({ ...card, createdAt: Date.now() }) });
    await turn('Members check in at the front desk.');
    const again = ['Should members sign in with their membership number, or a separate account?', " I'd go membership number."];
    replies.push({ text: ['While Ada builds:', ' should members sign in with their membership number, or a separate account?'] });
    expect((await turn('the person has been quiet for 25s; Ada is building.', 'pulse')).text).toBe(
      'While Ada builds: should members sign in with their membership number, or a separate account?',
    );
    replies.push({ text: again });
    const third = await turn('the person has been quiet for 70s; Kit is building.', 'pulse');
    expect(third).toEqual({ spoken: '', text: '' });
    lead.close();
  });

  it('does not ask the card on screen again at the end of a later reply', async () => {
    const open: AgendaItem[] = [];
    const { lead, turn } = setup(open);
    // Turn 1 asks it out loud and puts the card on the map (ask runs during the turn).
    const ask = () => open.push({ ...card, createdAt: Date.now() });
    replies.push({ text: ["I've sketched the front desk. ", 'Should members sign in with their membership number,', ' or a separate account?'], tool: true, before: ask });
    const first = await turn('Members check in at the front desk.');
    expect(first.text).toBe("I've sketched the front desk. Should members sign in with their membership number, or a separate account?");

    replies.push({ text: ['Routes live in Postgres', ' under the Gym API.', ' Still need your call: membership number', ' or a separate account?', " I'd go membership number."], tool: true });
    const second = await turn('Show me where the routes live.');
    expect(second.spoken).toBe('Routes live in Postgres under the Gym API. ');
    expect(second.text).toBe('Routes live in Postgres under the Gym API.');
    lead.close();
  });

  it('says it again when the person asks what is left, and leaves other questions alone', async () => {
    const { lead, turn } = setup([card]);
    // A card the lead hasn't said out loud yet (a builder's) is said once.
    replies.push({ text: ['Front desk is sketched.', ' Should members sign in with their gym membership number or a separate app account?'] });
    expect((await turn('Members check in at the front desk.')).text).toBe(
      'Front desk is sketched. Should members sign in with their gym membership number or a separate app account?',
    );
    replies.push({ text: ['Route Board is in.', ' Should members sign in with their gym membership number or a separate app account?'] });
    expect((await turn('Add a route board.')).text).toBe('Route Board is in.');
    replies.push({ text: ['One thing is open.', ' Should members sign in with their membership number, or a separate account?'] });
    expect((await turn("What's left to decide?")).text).toBe('One thing is open. Should members sign in with their membership number, or a separate account?');
    replies.push({ text: ['Setter Tools is in.', ' Do setters post routes from their phone at the wall?'] });
    expect((await turn('Setters reset a wall every Tuesday.')).spoken).toBe('Setter Tools is in. Do setters post routes from their phone at the wall?');
    lead.close();
  });
});
