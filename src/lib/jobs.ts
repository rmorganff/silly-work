/**
 * Runs the scheduled jobs. Each job is registered as a `_triggers/<id>` doc (seeded on first use, never overwritten, so a switch
 * made with update_trigger sticks) and leaves one `_trigger_runs/<id>` doc: when it last fired and how it ended. A job that is
 * switched off, or that is scheduled on the wrong London hour, exits at once and leaves no record.
 */
import type { StoreCtx } from './store';
import { getDoc, writeDoc, isCode } from './board';
import { inLondonSlot } from './london';
import { isoOf } from './board-health';
import { JOB_DEFS, jobMeta, type JobMeta } from './job-defs';
import { runAnswerWatch } from './answer-watch';
import { runHealthCheck } from './health-check';
import { runFridayReview } from './friday-review';

export interface JobDeps { ctx: StoreCtx; now: () => Date; fetchImpl: typeof fetch; env: Record<string, string | undefined> }
export type JobSource = 'schedule' | 'fire';
export type JobOutcome = { status: 'ok' | 'failed' | 'disabled' | 'off_hour' | 'no_such_job'; id: string; result?: unknown; error?: string };

/** The small result kept on the run record: counts and ids only, never card text. */
const RUNNERS: Record<string, (d: JobDeps) => Promise<Record<string, unknown>>> = {
  trig_answerwatch: async (d) => {
    const r = await runAnswerWatch(d);
    return { baselined: r.baselined, handled: r.handled.length, legacy: r.legacy, attention: r.attention.length };
  },
  trig_healthcheck: async (d) => {
    const r = await runHealthCheck(d);
    return { pass: r.report.counts.pass, fail: r.report.counts.fail, fail_high: r.report.counts.fail_high, card: r.card?.id ?? null };
  },
  trig_fridayreview: async (d) => {
    const r = await runFridayReview(d);
    return { proposals_done: r.acted.done.length, proposals_left: r.acted.left.length, items: r.items.length, card: r.card?.id ?? null };
  },
};

export const triggerDoc = (def: JobMeta) => ({
  name: def.name, function: def.function, cron_expression: def.cron_expression, enabled: def.default_enabled, model: null, runtime: 'netlify', created: new Date().toISOString(),
});

/** Seeds the registry doc if it is missing. Returns the doc as stored. */
export async function ensureRegistered(ctx: StoreCtx, def: JobMeta) {
  const have = await getDoc(ctx, '_triggers', def.id);
  if (have) return have;
  try { await writeDoc(ctx, { op: 'add', collection: '_triggers', id: def.id, data: triggerDoc(def) }); }
  catch (e) { if (!isCode(e, 'exists')) throw e; }
  return (await getDoc(ctx, '_triggers', def.id))!;
}

const errCode = (e: any) => String(e?.code || e?.name || 'error').slice(0, 60);

/** Runs one job. Never throws: a failure is recorded and returned. */
export async function runJob(deps: JobDeps, id: string, source: JobSource): Promise<JobOutcome> {
  const def = jobMeta(id), run = RUNNERS[id];
  if (!def || !run) return { status: 'no_such_job', id };
  const { ctx } = deps, now = deps.now();
  const jobCtx: StoreCtx = { ...ctx, actor: def.actor };
  let reg;
  try { reg = await ensureRegistered(jobCtx, def); }
  catch (e: any) { console.error('[silly-work]', id, 'registry unreadable', errCode(e)); return { status: 'failed', id, error: 'registry_unavailable' }; }
  if (reg.data.enabled === false) return { status: 'disabled', id };
  if (source === 'schedule' && def.slot && !inLondonSlot(now, def.slot)) return { status: 'off_hour', id };

  const fired_at = isoOf(now);
  let rec: Record<string, unknown>, out: JobOutcome;
  try {
    const result = await run({ ...deps, ctx: jobCtx });
    rec = { fired_at, finished_at: isoOf(deps.now()), by: source, status: 'ok', result, error: null };
    out = { status: 'ok', id, result };
  } catch (e: any) {
    console.error('[silly-work]', id, errCode(e)); // never log card text or request bodies
    rec = { fired_at, finished_at: isoOf(deps.now()), by: source, status: 'failed', error: errCode(e) };
    out = { status: 'failed', id, error: errCode(e) };
  }
  try {
    const cur = await getDoc(jobCtx, '_trigger_runs', id);
    await writeDoc(jobCtx, cur ? { op: 'set', collection: '_trigger_runs', id, data: rec } : { op: 'add', collection: '_trigger_runs', id, data: rec });
  } catch (e) { console.error('[silly-work]', id, 'run record not written', errCode(e)); }
  return out;
}

export { JOB_DEFS };
