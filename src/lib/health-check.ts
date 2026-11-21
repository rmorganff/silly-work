/**
 * The Work Board health check, daily at 09:20 London. Pure checks over a snapshot of the board, then writes of the result.
 * No model is called. It reads Turso only and writes `audit/health-<date>`, `audit/health-latest` and, when a serious fault
 * is found, one inbox card with a push. It never changes any other document.
 *
 * What it flags: digests the Work shift keeps going gone stale; this repo's own scheduled jobs missed or failed; the Monday
 * brief card missing on a Monday morning; answered cards nobody is acting on; tasks queued or running too long; secret-like
 * field names in `meta`.
 */
import type { StoreCtx } from './store';
import { getDoc, listDocs, putDoc, queryAnsweredOpen, writeDoc, isCode, type Doc } from './board';
import { raiseCard, pushCard } from './cards';
import { HOUR, ageMs, classifyAnswered, fmtWhen, isClosed, isoOf, parseTime, type Ctx, type Item, type Now } from './board-health';
import { londonTime, previousWorkday, isWeekday, shortDay } from './london';
import { JOB_DEFS, type JobMeta } from './job-defs';

export const PROMPT_VERSION = 'work-1';
const DAY = 24 * HOUR;
export const DIGESTS = ['live', 'slack', 'monday', 'calendar'] as const;
export const SECRET_NAME = /key|token|secret|password|passwd|endpoint|auth|bearer|webhook|credential|cookie/i;
export const SECRET_IGNORE = ['keep_awake', 'tokens_used', 'token_expires'];

export type Severity = 'high' | 'medium' | 'low';
export type Check = { id: string; pass: boolean | null; value: any; severity: Severity; note: string };
export type Snapshot = {
  inbox: Item[]; answeredOpen: Item[]; tasks: Item[]; rows: Item[]; meta: Item[]; digest: Item[]; triggers: Item[]; runs: Item[];
  watch: any; latest: any;
};
export type HealthDeps = { ctx: StoreCtx; now: () => Date; fetchImpl: typeof fetch; env: Record<string, string | undefined> };

const ck = (id: string, severity: Severity, pass: boolean | null, value: any, note = ''): Check => ({ id, pass, value, severity, note });
const ids = (xs: Item[]) => xs.map((x) => x.id);
const list = (xs: string[]) => xs.slice(0, 10).join(', ') + (xs.length > 10 ? ` and ${xs.length - 10} more` : '');
const none = (id: string, sev: Severity, bad: Item[], what: string) => ck(id, sev, bad.length === 0, bad.length, bad.length ? `${what}: ${list(ids(bad))}` : '');
const older = (v: unknown, ms: number, now: Now) => ageMs(v, now) > ms;

/** Field names (never values) anywhere in a doc that look like a secret, as `doc.field` or `doc.a.b`. */
export function secretNames(docId: string, data: any): string[] {
  const out: string[] = [];
  const walk = (v: any, path: string) => {
    if (Array.isArray(v)) { for (const x of v) walk(x, path); return; }
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      const p = path ? `${path}.${k}` : k;
      if (SECRET_NAME.test(k) && !SECRET_IGNORE.includes(k)) out.push(`${docId}.${p}`);
      walk(x, p);
    }
  };
  walk(data, '');
  return out;
}

/** When a digest was last written: its own `updated` field, else the row's write time. The newer of the two copies wins. */
const writtenAt = (d: Item | undefined): number => {
  if (!d) return NaN;
  const own = parseTime(d.data?.updated);
  return Number.isNaN(own) ? parseTime((d as Doc).updated_at) : own;
};

export function runChecks(s: Snapshot, now: Date, jobs: JobMeta[] = JOB_DEFS): Check[] {
  const d = (x: Item) => x.data;
  const lt = londonTime(now);
  const out: Check[] = [];

  // Digests: on a working day each must have been written since the start of the previous working day (London).
  for (const name of DIGESTS) {
    const a = s.digest.find((x) => x.id === name), b = s.meta.find((x) => x.id === `digest/${name}`);
    const t = Math.max(...[writtenAt(a), writtenAt(b)].filter((x) => !Number.isNaN(x)), -Infinity);
    const id = `DIGEST-${name.toUpperCase()}`;
    if (!Number.isFinite(t)) { out.push(ck(id, 'medium', null, null, `digest/${name} not found`)); continue; }
    if (!isWeekday(lt.date)) { out.push(ck(id, 'medium', null, isoOf(t), `digest/${name} not checked at weekends`)); continue; }
    const need = previousWorkday(lt.date);
    const fresh = londonTime(new Date(t)).date >= need;
    out.push(ck(id, 'medium', fresh, isoOf(t), `digest/${name} last written ${fmtWhen(t)}; wanted on or after ${shortDay(need)}`));
  }

  // This repo's own scheduled jobs: missed (no run for three intervals) and failed in the last 7 days.
  const runOf = new Map(s.runs.map((r) => [r.id, r.data]));
  const trigOf = new Map(s.triggers.map((t) => [t.id, t.data]));
  const missed: string[] = []; let neverRun = 0;
  for (const j of jobs) {
    if (j.id === 'trig_healthcheck') continue; // a check cannot find itself missing
    if ((trigOf.get(j.id)?.enabled ?? j.default_enabled) === false) continue;
    const r = runOf.get(j.id);
    if (!r?.fired_at) { neverRun++; continue; }
    if (ageMs(r.fired_at, now) > 3 * j.every_ms) missed.push(j.name);
  }
  out.push(ck('RUN-MISSED', 'high', missed.length === 0, missed.length, missed.length ? `no recent run: ${list(missed)}` : neverRun ? `${neverRun} job(s) have not run yet` : ''));
  out.push(none('RUN-FAILED', 'high', s.runs.filter((r) => d(r).status === 'failed' && !older(d(r).fired_at, 7 * DAY, now)), 'failed in the last 7 days'));

  // The Monday brief: from 09:00 London on a Monday its card must be on the inbox.
  if (lt.weekday === 1 && lt.hour >= 9) {
    const made = s.inbox.some((c) => c.id === `work-brief-${lt.date}` || (/^Work week brief/.test(String(d(c).title ?? '')) && londonTime(new Date(parseTime(d(c).created))).date === lt.date));
    out.push(ck('BRIEF-MON', 'high', made, made, made ? '' : `no Work week brief card for ${shortDay(lt.date)}`));
  }

  // Answered cards. Anything answered before the watcher's baseline is counted, never failed.
  const since = parseTime(s.watch?.since);
  const cardMap = new Map<string, any>([...s.inbox, ...s.answeredOpen].map((c) => [c.id, c.data]));
  const ctx: Ctx = { tasks: new Map(s.tasks.map((t) => [t.id, t.data])), cards: cardMap };
  if (Number.isNaN(since)) out.push(ck('ANS-2H-P', 'high', null, null, 'answer watcher has not set its baseline yet'));
  else {
    const fresh = s.answeredOpen.filter((c) => parseTime(d(c).answered) >= since);
    out.push(none('ANS-2H-P', 'high', fresh.filter((c) => classifyAnswered(d(c), ctx, now) === 'overdue'), 'answered and nobody on it'));
    out.push(ck('ANS-LEGACY', 'low', null, s.answeredOpen.length - fresh.length, 'answered before the watcher started; left to the Work shift'));
  }

  const queued = s.tasks.filter((t) => d(t).status === 'queued');
  out.push(none('TASK-Q24', 'medium', queued.filter((t) => d(t).needs_laptop !== true && older(d(t).created, DAY, now)), 'queued over a day'));
  const lap = queued.filter((t) => d(t).needs_laptop === true);
  out.push(ck('TASK-LAPTOP-WAIT', 'low', null, lap.length, 'tasks waiting for the laptop'));
  out.push(none('TASK-RUN90', 'medium', s.tasks.filter((t) => d(t).status === 'running' && older(d(t).updated, 90 * 60_000, now)), 'running but silent'));
  out.push(none('ROWS-RUN-STALE', 'low', s.rows.filter((r) => d(r).status === 'running' && older(d(r).updated, DAY, now)), 'running with no update for a day'));

  const secrets = s.meta.flatMap((m) => secretNames(m.id, d(m)));
  out.push(ck('META-SECRET', 'high', secrets.length === 0, secrets.length, secrets.length ? `secret-like field names: ${list(secrets)}` : ''));

  const week = s.inbox.filter((c) => !older(d(c).created, 7 * DAY, now));
  const byN = new Map<any, number>();
  for (const c of week) if (d(c).n != null) byN.set(d(c).n, (byN.get(d(c).n) ?? 0) + 1);
  const dups = [...byN].filter(([, k]) => k > 1).map(([n]) => String(n));
  out.push(ck('DUP-N-P', 'medium', dups.length === 0, dups.length, dups.length ? `card numbers used twice: ${list(dups)}` : ''));

  const on = s.triggers.filter((t) => d(t).enabled !== false).length;
  out.push(ck('JOB-COUNT', 'low', null, { enabled: on, disabled: s.triggers.length - on }, 'scheduled jobs on this site'));
  return out;
}

const SHORT: Record<string, string> = {
  'RUN-MISSED': 'job missed', 'RUN-FAILED': 'job failed', 'BRIEF-MON': 'Monday brief missing', 'ANS-2H-P': 'stale answers', 'META-SECRET': 'secret in meta',
};
const day = (now: Now) => { const t = new Date(typeof now === 'number' ? now : now.getTime()); return `${t.getUTCDate()} ${fmtWhen(t).split(' ')[1]}`; };

export function summarize(checks: Check[], previous: any, now: Now) {
  const f = (sev: Severity) => checks.filter((c) => c.pass === false && c.severity === sev);
  const counts = {
    pass: checks.filter((c) => c.pass === true).length, fail: checks.filter((c) => c.pass === false).length, not_measured: checks.filter((c) => c.pass === null).length,
    fail_high: f('high').length, fail_medium: f('medium').length, fail_low: f('low').length, total: checks.length,
  };
  const prev = new Map<string, boolean | null>((Array.isArray(previous?.checks) ? previous.checks : []).map((c: any) => [c.id, c.pass]));
  const since_last = previous ? {
    regressions: checks.filter((c) => prev.get(c.id) === true && c.pass === false).map((c) => c.id),
    fixed: checks.filter((c) => prev.get(c.id) === false && c.pass === true).map((c) => c.id),
  } : null;
  const serious = f('high').map((c) => SHORT[c.id] ?? c.id.toLowerCase());
  let line = counts.fail === 0 ? `Health ${day(now)}: all ${counts.pass} checks pass.` : `Health ${day(now)}: ${counts.pass} of ${counts.total} pass${counts.fail_high ? `, ${counts.fail_high} serious: ${serious.slice(0, 3).join(', ')}` : ''}.`;
  if (line.length > 120) line = line.slice(0, 117).replace(/[ ,:;]+$/, '') + '...';
  return { counts, since_last, status_line: line };
}

export async function loadSnapshot(ctx: StoreCtx): Promise<Snapshot> {
  const all = async (c: string, limit = 2000): Promise<Item[]> => (await listDocs(ctx, c, limit)).map((x) => ({ id: x.id, data: x.data, updated_at: x.updated_at } as Item));
  return {
    inbox: await all('inbox'), answeredOpen: (await queryAnsweredOpen(ctx)).map((x) => ({ id: x.id, data: x.data })),
    tasks: await all('tasks'), rows: await all('rows'), meta: await all('meta'), digest: await all('digest'),
    triggers: await all('_triggers', 200), runs: await all('_trigger_runs', 500),
    watch: (await getDoc(ctx, 'meta', 'answer-watch'))?.data ?? null, latest: (await getDoc(ctx, 'audit', 'health-latest'))?.data ?? null,
  };
}

export async function runHealthCheck(deps: HealthDeps) {
  const { ctx } = deps, now = deps.now();
  const snap = await loadSnapshot(ctx);
  const checks = runChecks(snap, now);
  const sum = summarize(checks, snap.latest, now);
  const date = londonTime(now).date;
  const report = { date, at: isoOf(now), checks, ...sum, prompt_version: PROMPT_VERSION, complete: true };
  await putDoc(ctx, 'audit', `health-${date}`, report);
  await putDoc(ctx, 'audit', 'health-latest', report);

  let card: { id: string; created: boolean } | null = null;
  const high = checks.filter((c) => c.pass === false && c.severity === 'high');
  if (high.length) {
    const id = `health-check-${date}`;
    const title = `Daily check: ${high.length} serious ${high.length === 1 ? 'fault' : 'faults'}`;
    const lines = high.slice(0, 8).map((c) => `${c.id}: ${c.note || c.value}`.slice(0, 110));
    const text = `${sum.status_line}\n${lines.join('\n')}`.slice(0, 1500);
    const r = await raiseCard(ctx, { id, title, text, options: ['ok, noted', 'look into it'], source: 'health-check', details: [{ h: 'Faults', numbered: true, lines }] }, now);
    if (r.existed) {
      const cur = await getDoc(ctx, 'inbox', id);
      if (cur && !isClosed(cur.data)) await writeDoc(ctx, { op: 'update', collection: 'inbox', id, ifVersion: cur.version, data: { text, details: [{ h: 'Faults', numbered: true, lines }] } }).catch((e) => { if (!isCode(e, 'version_conflict', 'scrub_rejected')) throw e; });
    } else await pushCard({ id, n: r.n ?? undefined, title: r.title, text, options: r.options, details: [{ h: 'Faults', lines }], kind: 'errors' }, deps.env, deps.fetchImpl);
    card = { id, created: !r.existed };
  }
  return { report, card };
}
