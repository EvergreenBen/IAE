// How the lead's Claude Code session is configured. Lean on purpose: no user
// settings or connectors, a custom system prompt and only Arxitect's own tools (plus
// a quick look at code). With these options it answers in about a second.

import type { HookCallbackMatcher, McpSdkServerConfigWithInstance, Options } from '@anthropic-ai/claude-agent-sdk';
import type { Settings } from '../../shared/model';
import { leadSystemPrompt } from './prompts';
import { baseOptions } from './sdk';
import { LEAD_TOOL_NAMES } from './tools';

/**
 * Extended thinking runs before the first spoken word, so it is time the
 * person spends waiting: at effort "low" (the default) the lead doesn't think
 * before it speaks. Measured on scripted conversations: time to first word p90
 * 3.1s → 2.2s, turn time −30%, cost −28%, same answers. Higher efforts keep
 * adaptive thinking. IAE_LEAD_THINKING (off | adaptive) overrides.
 */
export function leadThinking(effort: Settings['leadEffort']): Pick<Options, 'thinking'> {
  const env = process.env.IAE_LEAD_THINKING;
  if (env === 'off' || (env !== 'adaptive' && effort === 'low')) return { thinking: { type: 'disabled' } };
  return env === 'adaptive' ? { thinking: { type: 'adaptive' } } : {};
}

/** Said to the lead right after a look at code, where it otherwise drifts into a written report. */
export const AFTER_LOOK =
  'Spoken reply: the person is listening, not reading. Say what you found next, before any other tool (your words are heard until you have): at most four to six short plain sentences (about 100 words), the one thing that matters most last. No lists, headings, bold, backticks or code. If one more look is truly needed, take it first, without comment.';

/**
 * In-process hooks (no wait). After Read, Grep or Glob: remind the lead its
 * answer is spoken. Before any other tool: `hold` may answer with a reason to
 * hold it back for now (the lead looked at code and hasn't said what it found;
 * left alone it moves the camera and then stays silent).
 */
export function leadHooks(hold?: (tool: string, input: unknown) => string | null): Partial<Record<'PostToolUse' | 'PreToolUse', HookCallbackMatcher[]>> {
  return {
    PostToolUse: [
      {
        matcher: 'Read|Grep|Glob',
        hooks: [async () => ({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: AFTER_LOOK } })],
      },
    ],
    ...(hold
      ? {
          PreToolUse: [
            {
              hooks: [
                async (input) => {
                  const reason = input.hook_event_name === 'PreToolUse' ? hold(input.tool_name, input.tool_input) : null;
                  return reason ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } } : {};
                },
              ],
            },
          ],
        }
      : {}),
  };
}

export function leadOptions(root: string, s: Settings, tools: McpSdkServerConfigWithInstance, resume?: string, hold?: (tool: string, input: unknown) => string | null): Options {
  return {
    ...baseOptions(root),
    model: s.leadModel,
    effort: s.leadEffort,
    ...leadThinking(s.leadEffort),
    systemPrompt: leadSystemPrompt(s.leadName, s.maxBuilders),
    tools: ['Read', 'Glob', 'Grep'],
    mcpServers: { iae: tools },
    allowedTools: [...LEAD_TOOL_NAMES.map((n) => `mcp__iae__${n}`), 'Read', 'Glob', 'Grep'],
    hooks: leadHooks(hold),
    permissionMode: 'dontAsk',
    strictMcpConfig: true,
    settingSources: [],
    includePartialMessages: true,
    persistSession: true,
    ...(resume ? { resume } : {}),
  };
}
