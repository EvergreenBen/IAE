// How the lead's Claude Code session is configured. Lean on purpose: no user
// settings or connectors, a custom system prompt and only Arxitect's own tools (plus
// a quick look at code). With these options it answers in about a second.

import type { McpSdkServerConfigWithInstance, Options } from '@anthropic-ai/claude-agent-sdk';
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

export function leadOptions(root: string, s: Settings, tools: McpSdkServerConfigWithInstance, resume?: string): Options {
  return {
    ...baseOptions(root),
    model: s.leadModel,
    effort: s.leadEffort,
    ...leadThinking(s.leadEffort),
    systemPrompt: leadSystemPrompt(s.leadName, s.maxBuilders),
    tools: ['Read', 'Glob', 'Grep'],
    mcpServers: { iae: tools },
    allowedTools: [...LEAD_TOOL_NAMES.map((n) => `mcp__iae__${n}`), 'Read', 'Glob', 'Grep'],
    permissionMode: 'dontAsk',
    strictMcpConfig: true,
    settingSources: [],
    includePartialMessages: true,
    persistSession: true,
    ...(resume ? { resume } : {}),
  };
}
