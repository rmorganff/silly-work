import { getClient } from './db';
import { parseKeys } from './approval';
import { ensureMigrated } from './runtime';
import { runJob, type JobDeps, type JobOutcome } from './jobs';

let depsOverride: JobDeps | null = null;
/** Tests hand the scheduled functions a throwaway database and a fixed clock. */
export function setScheduledDepsForTests(d: JobDeps | null) { depsOverride = d; }

export async function liveDeps(): Promise<JobDeps> {
  if (depsOverride) return depsOverride;
  await ensureMigrated();
  return { ctx: { client: getClient(), keys: parseKeys(process.env.SILLY_APPROVAL_KEYS), actor: 'scheduled' }, now: () => new Date(), fetchImpl: fetch, env: process.env };
}

/** What every scheduled function does: run its job once and log the outcome (ids and counts only). Never throws. */
export async function runScheduled(id: string): Promise<JobOutcome> {
  try {
    const out = await runJob(await liveDeps(), id, 'schedule');
    if (out.status === 'ok' || out.status === 'failed') console.log('[silly-work]', id, out.status);
    return out;
  } catch (e: any) {
    console.error('[silly-work]', id, String(e?.code || e?.name || 'error'));
    return { status: 'failed', id, error: 'setup_failed' };
  }
}
