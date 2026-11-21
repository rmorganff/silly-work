/**
 * /api/trigger: fire_trigger / list_triggers / update_trigger, shaped like the "Claude Code Remote" connector tools the Work Board
 * and desk-bridge.js call. The triggers here are this site's own scheduled jobs (job-defs.ts); the claude.ai routines are not
 * listed, because this site cannot see them. A refusal answers 200 with {error, code} and fired:false, which the bridge already
 * treats as "the fire was refused".
 *
 * Request: {tool: 'list_triggers' | 'fire_trigger' | 'update_trigger', args: {...}}.
 */
import type { StoreCtx } from './store';
import { getDoc, writeDoc, isCode } from './board';
import { ageMs } from './board-health';
import { JOB_DEFS, jobMeta, type JobMeta } from './job-defs';
import { ensureRegistered, runJob, triggerDoc, type JobDeps } from './jobs';

export interface TriggerOut { status: number; body: Record<string, unknown> }
const refuse = (code: string, extra: Record<string, unknown> = {}): TriggerOut => ({ status: 200, body: { fired: false, error: code, code, ...extra } });

async function shape(ctx: StoreCtx, def: JobMeta) {
  const t = await getDoc(ctx, '_triggers', def.id), r = await getDoc(ctx, '_trigger_runs', def.id);
  const base = t?.data ?? triggerDoc(def);
  return { id: def.id, ...base, last_run: r ? { status: r.data.status, fired_at: r.data.fired_at, finished_at: r.data.finished_at ?? null, error: r.data.error ?? null } : null };
}

export async function listTriggers(ctx: StoreCtx, args: any): Promise<TriggerOut> {
  let rows = await Promise.all(JOB_DEFS.map((d) => shape(ctx, d)));
  if (typeof args?.enabled === 'boolean') rows = rows.filter((t) => (t.enabled !== false) === args.enabled);
  return { status: 200, body: { data: rows, has_more: false } };
}

export async function updateTrigger(ctx: StoreCtx, args: any): Promise<TriggerOut> {
  const def = jobMeta(String(args?.trigger_id ?? ''));
  if (!def) return refuse('no_such_trigger');
  if (typeof args?.enabled !== 'boolean') return { status: 400, body: { error: 'bad_enabled', code: 'bad_enabled' } };
  const reg = await ensureRegistered(ctx, def);
  try { await writeDoc(ctx, { op: 'update', collection: '_triggers', id: def.id, data: { enabled: args.enabled, updated: new Date().toISOString() }, ifVersion: reg.version }); }
  catch (e) { if (isCode(e, 'version_conflict')) return refuse('version_conflict'); throw e; }
  return { status: 200, body: { id: def.id, enabled: args.enabled } };
}

/** Runs the job now, in this request. The jobs read and write Turso only and finish well inside the function limit. */
export async function fireTrigger(deps: JobDeps, args: any): Promise<TriggerOut> {
  const def = jobMeta(String(args?.trigger_id ?? ''));
  if (!def) return refuse('no_such_trigger');
  const reg = await ensureRegistered(deps.ctx, def);
  if (reg.data.enabled === false) return refuse('trigger_disabled');
  const last = await getDoc(deps.ctx, '_trigger_runs', def.id);
  if (last && ageMs(last.data.fired_at, deps.now()) < def.cooldown_ms) return refuse('rate_limited', { retry_after_s: Math.ceil((def.cooldown_ms - ageMs(last.data.fired_at, deps.now())) / 1000) });
  const out = await runJob(deps, def.id, 'fire');
  return { status: 200, body: { fired: out.status === 'ok', trigger_id: def.id, status: out.status, error: out.error ?? null } };
}

export async function handleTrigger(deps: JobDeps, body: any): Promise<TriggerOut> {
  const tool = String(body?.tool ?? ''), args = body?.args ?? {};
  if (tool === 'list_triggers') return listTriggers(deps.ctx, args);
  if (tool === 'update_trigger') return updateTrigger(deps.ctx, args);
  if (tool === 'fire_trigger') return fireTrigger(deps, args);
  return { status: 400, body: { error: 'unknown_tool', code: 'unknown_tool' } };
}
