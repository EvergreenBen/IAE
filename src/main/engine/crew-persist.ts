// Crew jobs survive an app restart. Each one is saved to `.iae/crew.json` with
// its Claude Code session id; on open the unfinished ones resume that session,
// or start over from the brief when it never got one.

import type { AgentInfo, AgentStatus } from '../../shared/model';
import type { SavedJob } from '../project/store';
import type { JobSpec } from './builder';

const ENDED: AgentStatus[] = ['done', 'failed', 'stopped'];
const KINDS: SavedJob['kind'][] = ['build', 'investigate', 'command'];

export const RESTARTED = 'The app restarted; continue where you left off.';

/** What gets saved for one job. */
export function savedJob(run: { job: JobSpec; agent: AgentInfo; sessionId?: string }, waitingFor?: string): SavedJob {
  const { job, agent } = run;
  return {
    id: agent.id,
    name: agent.name,
    hue: agent.hue,
    kind: job.kind,
    title: job.title,
    nodeId: job.nodeId,
    brief: job.brief,
    status: agent.status,
    ...(run.sessionId ? { sessionId: run.sessionId } : {}),
    ...(waitingFor ? { waitingFor } : {}),
    startedAt: agent.startedAt,
    ...(agent.progress ? { progress: agent.progress } : {}),
    ...(agent.changes?.length ? { changes: agent.changes } : {}),
  };
}

const str = (v: unknown): v is string => typeof v === 'string';

/** The saved jobs to pick up again: well formed, and not finished, failed or stopped. */
export function resumableJobs(saved: unknown): SavedJob[] {
  if (!Array.isArray(saved)) return [];
  const seen = new Set<string>();
  return saved.filter((j): j is SavedJob => {
    if (!j || typeof j !== 'object') return false;
    const ok = str(j.id) && str(j.name) && str(j.title) && str(j.brief) && KINDS.includes(j.kind) && !ENDED.includes(j.status) && !seen.has(j.id);
    if (ok) seen.add(j.id);
    return ok;
  });
}

/** The job itself, as the crew runs it. */
export function jobSpec(saved: SavedJob): JobSpec {
  return { kind: saved.kind, title: saved.title, brief: saved.brief, nodeId: str(saved.nodeId) ? saved.nodeId : null };
}

/** The first message of a resumed session (one without a session starts over from the brief). */
export function resumeNote(saved: SavedJob): string {
  if (saved.waitingFor) return `${RESTARTED} You were waiting for the person's OK on "${saved.waitingFor}"; try it again if you still need it.`;
  if (saved.status === 'waiting') return `${RESTARTED} If you were waiting for an answer to a question, it is still open: ask again if you still need it.`;
  return RESTARTED;
}
