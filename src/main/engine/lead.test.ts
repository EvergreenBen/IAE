import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineEvent } from '../../shared/events';
import { emptyMap } from '../../shared/map';
import { DEFAULT_SETTINGS, type AgendaItem } from '../../shared/model';

// A scripted Claude session: each user message is answered with the next reply
// (streamed as text deltas, optionally followed by a tool call). `blocks`
// scripts a longer reply: text blocks, tool calls (by name) and checks run at
// that point of the stream.
type Block = { text: string[] } | { tool: string } | { check: () => void };
const replies: { text?: string[]; tool?: boolean; before?: () => void; blocks?: Block[] }[] = [];
/** What the session was sent, in order. */
const prompts: string[] = [];
vi.mock('@anthropic-ai/claude-agent-sdk', async (orig) => ({
  ...(await orig<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query: ({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    let n = 0;
    async function* run() {
      yield { type: 'system', subtype: 'init', session_id: 's1', model: 'm' };
      for await (const m of prompt) {
        prompts.push(JSON.stringify(m));
        const r = replies.shift() ?? { text: ['<silence/>'] };
        r.before?.();
        const id = `msg-${++n}`;
        const ev = (event: unknown) => ({ type: 'stream_event', parent_tool_use_id: null, event });
        yield ev({ type: 'message_start', message: { id } });
        const blocks: Block[] = r.blocks ?? [{ text: r.text ?? [] }, ...(r.tool ? [{ tool: 'mcp__iae__sketch_map' }] : [])];
        for (const b of blocks) {
          if ('check' in b) b.check();
          else if ('tool' in b) yield ev({ type: 'content_block_start', content_block: { type: 'tool_use', name: b.tool } });
          else {
            yield ev({ type: 'content_block_start', content_block: { type: 'text' } });
            for (const text of b.text) yield ev({ type: 'content_block_delta', delta: { type: 'text_delta', text } });
          }
        }
        yield { type: 'assistant', parent_tool_use_id: null, message: { id, content: [] } };
        yield { type: 'result', subtype: 'success', session_id: 's1' };
      }
    }
    return Object.assign(run(), { interrupt: async () => {}, close: () => {} });
  },
}));

const { HOLD_FOR_ANSWER, Lead } = await import('./lead');

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
  /** Sends one message and waits for `turns` replies to finish (a retry is a second one). */
  const turn = async (body: string, kind: 'user' | 'pulse' = 'user', turns = 1) => {
    const from = events.length;
    lead.send(kind, body);
    await vi.waitFor(() => expect(events.slice(from).filter((e) => e.type === 'lead/done').length).toBe(turns));
    const mine = events.slice(from);
    const spoken = mine.map((e) => (e.type === 'lead/delta' ? e.text : '')).join('');
    const done = mine.filter((e) => e.type === 'lead/done').at(-1);
    return { spoken, text: done?.type === 'lead/done' ? done.text : '' };
  };
  return { lead, turn, events };
}

afterEach(() => {
  replies.length = 0;
  prompts.length = 0;
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
    const { lead, turn, events } = setup(open);
    // Turn 1 asks it out loud and puts the card on the map (ask runs during the turn).
    const ask = () => open.push({ ...card, createdAt: Date.now() });
    replies.push({ text: ["I've sketched the front desk. ", 'Should members sign in with their membership number,', ' or a separate account?'], tool: true, before: ask });
    const first = await turn('Members check in at the front desk.');
    expect(first.text).toBe("I've sketched the front desk. Should members sign in with their membership number, or a separate account?");

    replies.push({ text: ['Routes live in Postgres', ' under the Gym API.', ' Still need your call: membership number', ' or a separate account?', " I'd go membership number."], tool: true });
    const from = events.length;
    const second = await turn('Show me where the routes live.');
    // The first sentence streams as it comes (the voice starts at its first break), guard or not.
    expect(events.slice(from).find((e) => e.type === 'lead/delta')).toMatchObject({ text: 'Routes live in Postgres' });
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

describe('Lead: what gets heard', () => {
  it('speaks what a quick look at the code finds, however long the opening was', async () => {
    const { lead, turn } = setup([]);
    const opening = 'Let me look at the jobs worker and the recipe routes.';
    replies.push({
      blocks: [
        { text: [opening] },
        { tool: 'Grep' },
        // The look is still out: tool results must not tell the lead it already spoke.
        { check: () => expect(lead.hasSpoken).toBe(false) },
        { tool: 'mcp__iae__focus' },
        { text: ['Nothing ever queues a thumbnail job,', ' so the worker never runs.'] },
        { check: () => expect(lead.hasSpoken).toBe(true) },
        { tool: 'mcp__iae__focus' },
        { text: ['<silence/>'] },
      ],
    });
    const r = await turn('Walk me through how a photo becomes a thumbnail.');
    expect(r.text).toBe(`${opening} Nothing ever queues a thumbnail job, so the worker never runs.`);
    expect(r.spoken).toBe(`${opening} Nothing ever queues a thumbnail job, so the worker never runs.`);
    lead.close();
  });

  it('an empty text block between the look and its answer does not mute the answer', async () => {
    const { lead, turn } = setup([]);
    replies.push({
      blocks: [
        { text: ['Let me check where the thumbnail job gets queued.'] },
        { tool: 'Grep' },
        { tool: 'Grep' },
        { text: ['\n\n'] },
        { tool: 'mcp__iae__focus' },
        { tool: 'mcp__iae__focus' },
        { text: ['The photo goes up fine,', ' but nothing ever adds a thumbnail job.'] },
      ],
    });
    const r = await turn('Walk me through how a photo becomes a thumbnail.');
    expect(r.text).toBe('Let me check where the thumbnail job gets queued. The photo goes up fine, but nothing ever adds a thumbnail job.');
    lead.close();
  });

  it('finishes the opener before the tools run (a trailing line break is not held back)', async () => {
    const { lead, turn, events } = setup([]);
    const said = () => events.map((e) => (e.type === 'lead/delta' ? e.text : '')).join('');
    replies.push({
      blocks: [
        { text: ['Let me check how jobs get queued.\n'] },
        { tool: 'Grep' },
        { check: () => expect(said()).toBe('Let me check how jobs get queued. ') },
        { text: ['Nothing ever adds a job.'] },
      ],
    });
    const r = await turn('What does the jobs worker do?');
    expect(r.text).toBe('Let me check how jobs get queued. Nothing ever adds a job.');
    expect(r.spoken).toBe('Let me check how jobs get queued. Nothing ever adds a job.');
    lead.close();
  });

  it('still mutes a restatement after action tools', async () => {
    const { lead, turn } = setup([]);
    replies.push({
      blocks: [
        { text: ["I'm putting a route board under the Gym API."] },
        { tool: 'mcp__iae__sketch_map' },
        { check: () => expect(lead.hasSpoken).toBe(true) },
        { text: ["I've added the route board under the Gym API."] },
      ],
    });
    const r = await turn('Members should see which routes are up.');
    expect(r.text).toBe("I'm putting a route board under the Gym API.");
    lead.close();
  });

  it('asks once more when a reply to the person has no words in it', async () => {
    const { lead, turn } = setup([]);
    // Straight to tools, then silence: the person would hear nothing.
    replies.push({ blocks: [{ tool: 'Read' }, { tool: 'mcp__iae__focus' }, { text: ['<silence/>'] }] });
    replies.push({ text: ['Recipes save through the recipes routes into Postgres, in one insert per table.'] });
    const r = await turn('Walk me through how a recipe gets saved.', 'user', 2);
    expect(r.text).toBe('Recipes save through the recipes routes into Postgres, in one insert per table.');
    expect(prompts.at(-1)).toContain('<unheard>');
    expect(prompts.at(-1)).not.toContain('<user_said>');
    lead.close();
  });

  it('asks for what a look found when it ended in silence after the opening', async () => {
    const { lead, turn } = setup([]);
    // The real failure: "Let me check…" → Grep → focus calls → <silence/>. Only the opening was heard.
    replies.push({
      blocks: [
        { text: ['Let me check where the thumbnail job gets queued.'] },
        { tool: 'Grep' },
        { tool: 'mcp__iae__focus' },
        { tool: 'mcp__iae__focus' },
        { text: ['<silence/>'] },
      ],
    });
    replies.push({ text: ['Nothing ever queues a thumbnail job, so the worker never makes one.'] });
    const r = await turn('Walk me through how a photo becomes a thumbnail.', 'user', 2);
    expect(r.text).toBe('Nothing ever queues a thumbnail job, so the worker never makes one.');
    expect(prompts.at(-1)).toContain('never said what you found');
    lead.close();
  });

  it('holds camera moves back until what the look found is said, then plays them with the words', async () => {
    const { lead, turn, events } = setup([]);
    const hold = (tool: string, input?: unknown) => (lead as unknown as { holdForAnswer: (t: string, i?: unknown) => string | null }).holdForAnswer(tool, input);
    replies.push({
      blocks: [
        { text: ['Let me look at the jobs worker.'] },
        { check: () => expect(hold('mcp__iae__focus')).toBeNull() },
        { tool: 'Grep' },
        { check: () => expect(hold('mcp__iae__focus', { node_id: null })).toBe(HOLD_FOR_ANSWER) },
        { check: () => expect(events.some((e) => e.type === 'focus')).toBe(false) },
        { check: () => expect(hold('Read')).toBeNull() },
        // The work itself is never held.
        { check: () => expect(hold('mcp__iae__delegate')).toBeNull() },
        { text: ['It polls the jobs table every two seconds.'] },
        // The held move plays as the answer starts.
        { check: () => expect(events.filter((e) => e.type === 'focus')).toEqual([{ type: 'focus', nodeId: null, mode: 'show' }]) },
        { check: () => expect(hold('mcp__iae__focus')).toBeNull() },
      ],
    });
    expect((await turn('What does the jobs worker do?')).text).toBe('Let me look at the jobs worker. It polls the jobs table every two seconds.');
    // Unprompted turns are never held.
    replies.push({ blocks: [{ tool: 'Grep' }, { check: () => expect(hold('mcp__iae__focus')).toBeNull() }, { text: ['<silence/>'] }] });
    await turn('the person has been quiet for 25s', 'pulse');
    lead.close();
  });

  it('says a few words at once when a reply goes straight to the code', async () => {
    const { lead, turn, events } = setup([]);
    replies.push({ blocks: [{ tool: 'Grep' }, { check: () => expect(lead.hasSpoken).toBe(false) }, { text: ['The worker polls the jobs table every two seconds.'] }] });
    const r = await turn('What does the jobs worker do?');
    expect(events.find((e) => e.type === 'lead/delta')).toMatchObject({ text: 'Let me check the code. ' });
    expect(r.text).toBe('Let me check the code. The worker polls the jobs table every two seconds.');
    expect(prompts.some((p) => p.includes('<unheard>'))).toBe(false);
    lead.close();
  });

  it('counts silence chosen up front as having said its piece', async () => {
    const { lead, turn } = setup([]);
    replies.push({ blocks: [{ text: ['<silence/>'] }, { check: () => expect(lead.hasSpoken).toBe(true) }, { tool: 'mcp__iae__sketch_map' }] });
    expect((await turn('the person has been quiet for 25s', 'pulse')).text).toBe('');
    lead.close();
  });

  it('asks only once, and not after an unprompted silence', async () => {
    const { lead, turn, events } = setup([]);
    replies.push({ text: ['<silence/>'] }, { text: ['<silence/>'] });
    await turn('Shh, give me a minute.', 'user', 2);
    await new Promise((r) => setTimeout(r, 30));
    expect(events.filter((e) => e.type === 'lead/done').length).toBe(2);
    replies.push({ text: ['<silence/>'] });
    await turn('the person has been quiet for 25s', 'pulse');
    await new Promise((r) => setTimeout(r, 30));
    expect(events.filter((e) => e.type === 'lead/done').length).toBe(3);
    expect(prompts.filter((p) => p.includes('<unheard>')).length).toBe(1);
    lead.close();
  });

  it('keeps words said before a silence tag', async () => {
    const { lead, turn } = setup([]);
    replies.push({ text: ['Ada is on the thumbnails.', '<silence/>'] });
    expect((await turn('How are we doing?')).text).toBe('Ada is on the thumbnails.');
    expect(prompts.some((p) => p.includes('<unheard>'))).toBe(false);
    lead.close();
  });
});
