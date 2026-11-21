import { getClient } from './db';
import { parseKeys } from './approval';
import { ensureMigrated } from './runtime';
import { runJob, gate, type JobDeps, type JobOutcome } from './jobs';
import { jobMeta } from './job-defs';
import { startBackground, sameSecret } from './background';
import { writeDoc, getDoc } from './board';
import { isoOf } from './board-health';

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
    const deps = await liveDeps(), def = jobMeta(id);
    if (def?.background) {
      // a long job: check it may run now, then only start its background function
      const blocked = await gate(deps, id, 'schedule');
      if (blocked) return blocked;
      const s = await startBackground(def, deps.env, deps.fetchImpl, 'schedule');
      if (!s.started) {
        console.error('[silly-work]', id, 'not started', s.reason);
        const ctx = { ...deps.ctx, actor: def.actor }, cur = await getDoc(ctx, '_trigger_runs', id).catch(() => null);
        const rec = { fired_at: isoOf(deps.now()), finished_at: isoOf(deps.now()), by: 'schedule', status: 'failed', error: s.reason };
        await writeDoc(ctx, cur ? { op: 'set', collection: '_trigger_runs', id, data: rec } : { op: 'add', collection: '_trigger_runs', id, data: rec }).catch(() => undefined);
        return { status: 'failed', id, error: s.reason };
      }
      return { status: 'started', id };
    }
    const out = await runJob(deps, id, 'schedule');
    if (out.status === 'ok' || out.status === 'failed') console.log('[silly-work]', id, out.status);
    return out;
  } catch (e: any) {
    console.error('[silly-work]', id, String(e?.code || e?.name || 'error'));
    return { status: 'failed', id, error: 'setup_failed' };
  }
}

/** The body of every `<job>-background` function: check the secret, then run the job (the slot was checked before it was started). */
export async function handleBackground(req: Request, id: string): Promise<Response> {
  const reply = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (req.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);
  const secret = process.env.SILLY_WORK_TRIGGER_SECRET;
  if (!secret) return reply({ error: 'background_not_configured' }, 503);
  if (!sameSecret(req.headers.get('x-silly-trigger-secret') || '', secret)) return reply({ error: 'unauthorized' }, 401);
  const out = await runJob(await liveDeps(), id, 'background');
  return reply({ ok: out.status === 'ok', status: out.status }, 202);
}
