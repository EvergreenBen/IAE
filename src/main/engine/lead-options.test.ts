import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../shared/model';
import { AFTER_LOOK, leadHooks, leadOptions } from './lead-options';

describe('leadOptions', () => {
  const opts = leadOptions('/tmp/p', DEFAULT_SETTINGS, {} as never);

  it('stays lean: no user settings, only its own tools plus a quick look at code, thinking off at low effort', () => {
    expect(opts.strictMcpConfig).toBe(true);
    expect(opts.settingSources).toEqual([]);
    expect(opts.tools).toEqual(['Read', 'Glob', 'Grep']);
    expect(opts.thinking).toEqual({ type: 'disabled' });
  });

  it('reminds the lead after a look that its answer is spoken', async () => {
    const [m] = opts.hooks?.PostToolUse ?? [];
    expect(m.matcher).toBe('Read|Grep|Glob');
    const out = await m.hooks[0]({} as never, 't1', { signal: new AbortController().signal });
    expect(out).toEqual({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: AFTER_LOOK } });
  });

  it('holds a tool back when asked to, with the reason', async () => {
    const hooks = leadHooks((tool) => (tool === 'mcp__iae__focus' ? 'Say it first.' : null));
    const [m] = hooks.PreToolUse ?? [];
    const signal = new AbortController().signal;
    const pre = (tool_name: string) => m.hooks[0]({ hook_event_name: 'PreToolUse', tool_name } as never, 't', { signal });
    expect(await pre('mcp__iae__focus')).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Say it first.' } });
    expect(await pre('Grep')).toEqual({});
  });
});
