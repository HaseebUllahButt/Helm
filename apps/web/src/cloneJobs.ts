import type { Client } from './client';
import { rememberFolderMade } from './folderIndex';

/**
 * Clones from GitHub that are still coming down.
 *
 * Picking a repo closes the new chat box at once and opens the folder it is
 * going into; the bar there follows the clone from here. Kept outside React
 * so leaving that screen and coming back finds the same clone, still going.
 */

export interface CloneJob {
  envId: string;
  repo: string;
  /** Where it lands, as the machine names it ("~/dev/app"). */
  path: string;
  state: 'cloning' | 'done' | 'failed';
  percent: number;
  error?: string;
}

interface Answer { job?: string; state: CloneJob['state']; percent: number; path: string; error?: string }

const jobs = new Map<string, CloneJob>();
const listeners = new Set<() => void>();
const keyOf = (envId: string, path: string) => `${envId}\n${path}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function update(job: CloneJob, change: Partial<CloneJob>) {
  Object.assign(job, change);
  for (const l of [...listeners]) l();
}

export function cloneJob(envId: string, path: string): CloneJob | undefined {
  return jobs.get(keyOf(envId, path));
}

export function onCloneJobs(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Asks the machine to clone and answers as soon as it has started, with the
 * folder it goes into; a repo already there answers done. A refusal (bad
 * name, another folder in the way) throws, so the box can say why.
 */
export async function startClone(client: Client, envId: string, params: { repo: string; parent: string; login?: string }): Promise<CloneJob> {
  const first = await client.rpc<Answer>(envId, 'github.clone', params, 60_000);
  const job: CloneJob = { envId, repo: params.repo, path: first.path, state: first.state, percent: first.percent, error: first.error };
  jobs.set(keyOf(envId, job.path), job);
  if (job.state === 'done') rememberFolderMade(envId, { name: job.path.split('/').pop() || job.path, path: job.path, repo: true });
  if (job.state === 'cloning' && first.job) void follow(client, job, first.job);
  for (const l of [...listeners]) l();
  return job;
}

async function follow(client: Client, job: CloneJob, id: string) {
  let misses = 0;
  while (job.state === 'cloning') {
    await sleep(700);
    try {
      const r = await client.rpc<Answer>(job.envId, 'github.clone', { job: id }, 20_000);
      misses = 0;
      update(job, { state: r.state, percent: r.percent, error: r.error });
    } catch (e: any) {
      // A slow link drops an answer now and then; a machine that keeps not
      // answering is said so rather than left as a bar that never moves.
      if (++misses >= 10) update(job, { state: 'failed', error: e?.message || 'Lost touch with the machine.' });
    }
  }
  if (job.state === 'done') rememberFolderMade(job.envId, { name: job.path.split('/').pop() || job.path, path: job.path, repo: true });
}
