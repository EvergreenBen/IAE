import { describe, expect, it } from 'vitest';
import { AskedQuestions, asksWhatsOpen, questionSentences, RepeatGuard, repeatsCard, similarity, unpromptedCap, withoutDropped } from './repeat';

const card = { id: 'q1', prompt: 'Should members sign in with their gym membership number or a separate app account?', createdAt: 1_000 };
const spoken = [{ text: 'Should members sign in with their membership number, or a separate account?', at: 2_000 }];

const stream = (guard: RepeatGuard, chunks: string[]) => chunks.map((c) => guard.push(c)).join('') + guard.flush();

describe('repeatsCard', () => {
  it('spots a near-verbatim repeat of the card or of how it was asked out loud', () => {
    expect(repeatsCard('Members sign in with their membership number or a separate account?', [card], spoken)).toBe(true);
    expect(repeatsCard('Still need your call: membership number or a separate account?', [card], spoken)).toBe(true);
  });

  it('lets other questions through', () => {
    expect(repeatsCard('Do setters post routes from their phone or the front desk?', [card], spoken)).toBe(false);
    expect(repeatsCard('Membership number or separate account.', [card], spoken)).toBe(false);
    // What it said before the card existed doesn't count as having asked it.
    expect(repeatsCard('Still need your call: membership number or a separate account?', [{ ...card, createdAt: 5_000 }], spoken)).toBe(false);
  });

  it("lets a card through the first time the lead says it (a builder's question), however close to the card", () => {
    expect(repeatsCard('Should members sign in with their gym membership number or a separate app account?', [card], [])).toBe(false);
  });

  it('knows how the lead asked a card in the turn that added it, even in other words', () => {
    const asked = [{ text: 'Do members check in with an existing system today, or is this new?', at: 2_000, cards: ['q2'] }];
    const desk = { id: 'q2', prompt: 'Does the front desk already use check-in software Crag Night must connect to?', createdAt: 1_500 };
    expect(repeatsCard('So, do members check in with an existing system today, or is this new?', [desk], asked)).toBe(true);
    expect(repeatsCard('So, do members check in with an existing system today, or is this new?', [desk], [{ ...asked[0], cards: [] }])).toBe(false);
  });

  it('scores overlap on content words', () => {
    expect(similarity('Tokens or cookies?', 'Cookies or tokens?')).toBe(1);
    expect(similarity('Tokens or cookies?', 'Which region?')).toBe(0);
  });
});

describe('RepeatGuard', () => {
  const guard = () => new RepeatGuard((s) => repeatsCard(s, [card], spoken));

  it('trims a trailing repeat and the default riding on it, keeping the rest', () => {
    const g = guard();
    const out = stream(g, ["I've added Route", ' Board under the app.', ' Still need your call: membership number', ' or a separate account? ', "I'd go membership number."]);
    expect(out).toBe("I've added Route Board under the app. ");
    expect(g.dropped.map((d) => d.trim())).toEqual(['Still need your call: membership number or a separate account?', "I'd go membership number."]);
  });

  it('streams the opening live and leaves a reply without repeats untouched', () => {
    const g = guard();
    expect(g.push('Route Board ')).toBe('Route Board ');
    expect(g.push('is sketched.')).toBe('is sketched.');
    expect(g.push(' Do setters post')).toBe(' ');
    expect(g.push(' from their phone? ')).toBe('Do setters post from their phone? ');
    expect(g.flush()).toBe('');
    expect(g.dropped).toEqual([]);
  });

  it('never trims the opening sentence of a reply to the person', () => {
    const g = guard();
    expect(stream(g, ['Membership number or a separate account? ', "I'll sketch both."])).toBe("Membership number or a separate account? I'll sketch both.");
  });

  it('checks the opening too when nobody is waiting for it (a nudge)', () => {
    const g = new RepeatGuard((s) => repeatsCard(s, [card], spoken), true);
    expect(stream(g, ['Still need your call: membership number', ' or a separate account? ', "I'd go membership number."])).toBe('');
  });

  it('removes what it trimmed from the final text', () => {
    expect(withoutDropped("Route Board's in.  Still need: membership number or account? I'd go number.", [' Still need: membership number or account? ', "I'd go number."])).toBe("Route Board's in.");
  });
});

describe('unprompted turns', () => {
  const run = (text: string) => {
    const g = new RepeatGuard(unpromptedCap(), true);
    return (g.push(text) + g.flush()).trim();
  };

  it('say one sentence, and leave the tour of the map to the map', () => {
    expect(
      run('The map is finished now. It shows the website, the back end and the worker. The biggest gap is that failed jobs never retry. Next I would add retries. '),
    ).toBe('The map is finished now.');
  });

  it('keep a question, or the default riding on one, and nothing after a dropped sentence', () => {
    expect(run("Ada finished the health route. Want the jobs queue next? ")).toBe('Ada finished the health route. Want the jobs queue next?');
    expect(run("Ada needs one answer before she migrates sessions: tokens or cookies? I'd go tokens. ")).toBe(
      "Ada needs one answer before she migrates sessions: tokens or cookies? I'd go tokens.",
    );
    expect(run('Typecheck passes now. One call is yours: nothing is committed. I would leave it. Okay? ')).toBe('Typecheck passes now.');
  });

  it('applies to events and nudges, never to a reply to the person', () => {
    const asked = new AskedQuestions();
    expect(asked.guard('user', 'how does it work', [])).toBeNull();
    const g = asked.guard('events', '', [])!;
    expect((g.push('Kit is done. The search limit is 50 now. Tests pass. ') + g.flush()).trim()).toBe('Kit is done.');
  });
});

describe('helpers', () => {
  it('finds question sentences', () => {
    expect(questionSentences("Ada's on it. Tokens or cookies? I'd go tokens.")).toEqual(['Tokens or cookies?']);
  });

  it('knows when the person asks what is still open', () => {
    expect(asksWhatsOpen("What's left to decide?")).toBe(true);
    expect(asksWhatsOpen('Remind me what you asked')).toBe(true);
    expect(asksWhatsOpen('Sorry, what was the question?')).toBe(true);
    expect(asksWhatsOpen('Add a leaderboard for setters')).toBe(false);
  });
});
