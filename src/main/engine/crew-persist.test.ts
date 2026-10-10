// Builders survive a restart: what is saved, what comes back, and what it is told.
import { describe, expect, it } from 'vitest';
import type { AgentInfo } from '../../shared/model';
import { needsRestart } from '../selfwatch';
import { jobSpec, RESTARTED, resumableJobs, resumeNote, savedJob } from './crew-persist';

const agent = (patch: Partial<AgentInfo> = {}): AgentInfo => ({
  id: 'ada',
  name: 'Ada',
  role: 'builder',
  hue: 0,
  status: 'working',
  task: 'Swap TTS to Kokoro',
  nodeId: 'voice',
  startedAt: 1000,
  ...patch,
});
const job = { kind: 'build' as const, title: 'Swap TTS to Kokoro', brief: 'Replace speechSynthesis with Kokoro.', nodeId: 'voice' };

describe('saving the crew', () => {
  it('keeps the session, the plan and what it was waiting for', () => {
    const progress = { steps: ['Read', 'Build', 'Test'], done: 1, spentMs: 60_000, stepAt: 5000 };
    const saved = savedJob({ job, agent: agent({ progress }), sessionId: 's-1' }, 'Run npm test');
    expect(saved).toMatchObject({ id: 'ada', name: 'Ada', sessionId: 's-1', waitingFor: 'Run npm test', progress, startedAt: 1000, status: 'working' });
    expect(jobSpec(saved)).toEqual(job);
  });

  it('brings back only unfinished, well-formed jobs, once each', () => {
    const base = savedJob({ job, agent: agent() });
    const back = resumableJobs([
      base,
      { ...base, id: 'kit', name: 'Kit', status: 'done' },
      { ...base, id: 'rho', name: 'Rho', status: 'stopped' },
      { ...base, id: 'juno', name: 'Juno', status: 'starting' },
      base,
      { id: 'broken' },
      null,
    ]);
    expect(back.map((j) => j.id)).toEqual(['ada', 'juno']);
    expect(resumableJobs('nonsense')).toEqual([]);
  });

  it('tells a resumed builder what happened', () => {
    const base = savedJob({ job, agent: agent(), sessionId: 's-1' });
    expect(resumeNote(base)).toBe(RESTARTED);
    expect(resumeNote({ ...base, waitingFor: 'Run npm test' })).toContain('"Run npm test"');
    expect(resumeNote({ ...base, status: 'waiting' })).toContain('question');
  });
});

describe('Arxitect building itself', () => {
  it('asks for a restart only for code that loads at launch', () => {
    expect(needsRestart('src/main/engine/crew.ts')).toBe(true);
    expect(needsRestart('src/shared/model.ts')).toBe(true);
    expect(needsRestart('src/preload/index.ts')).toBe(true);
    expect(needsRestart('package.json')).toBe(true);
    expect(needsRestart('src/main/engine/crew.test.ts')).toBe(false);
    expect(needsRestart('src/renderer/src/App.tsx')).toBe(false);
    expect(needsRestart('src/main/README.md')).toBe(false);
    expect(needsRestart('src/main/main')).toBe(false);
    expect(needsRestart('src/main')).toBe(false);
    expect(needsRestart('electron.vite.config.ts')).toBe(true);
  });
});
