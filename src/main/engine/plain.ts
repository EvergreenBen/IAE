// What a builder is doing, in the person's words. Its figure already stands on
// the part of the system it's working in, so the line says what kind of work,
// never which file or command: "Reading the code", "Making changes", "Running
// the tests". The file-level detail stays in the step log, for whoever opens it.

import type { ToolActivity } from './activity';

/** humanCommand's phrases, said the way the person would. */
const COMMANDS: Record<string, string> = {
  'Installing packages': 'Installing packages',
  'Running migrations': 'Updating the database',
  'Running tests': 'Running the tests',
  Typechecking: 'Checking for mistakes',
  Building: 'Building it',
  'Checking code style': 'Tidying the code',
  'Checking the running server': 'Trying it out',
  'Starting the dev server': 'Trying it out',
  'Calling a web address': 'Trying it out',
  'Committing changes': 'Saving its work',
  'Reviewing changes': 'Reviewing its changes',
  'Reading git history': 'Reading the history',
  'Using Docker': 'Using Docker',
  'Creating folders': 'Setting things up',
  'Removing files': 'Tidying up',
  'Moving files': 'Moving files',
  'Stopping a process': 'Tidying up',
  'Checking the project': 'Looking around',
};

/** Between steps with nothing to show: the model is working out what to do next. */
export const THINKING = 'Thinking it through';

export function plainActivity(toolName: string, act: ToolActivity): string {
  switch (toolName) {
    case 'WebFetch':
    case 'WebSearch':
      return 'Looking things up';
    case 'Task':
    case 'Agent':
      return 'Handing off a part of it';
    case 'TodoWrite':
      return 'Planning';
    case 'mcp__iae__ask_architect':
      return 'Asking you something';
    case 'Skill':
      return act.activity;
  }
  switch (act.kind) {
    case 'read':
    case 'search':
      return 'Reading the code';
    case 'edit':
    case 'write':
      return act.touch === 'create' ? 'Adding new code' : 'Making changes';
    case 'bash':
      return COMMANDS[act.activity] ?? (act.activity.startsWith('Running ') ? 'Running a check' : act.activity);
    default:
      return act.activity;
  }
}

/** Tools whose input names the file they are about to write. */
export const WRITERS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/** The file a writing tool names, read from its input while it is still streaming in. */
export function streamedPath(partialJson: string): string | null {
  const m = /"(?:file_path|notebook_path)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(partialJson);
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return null;
  }
}
