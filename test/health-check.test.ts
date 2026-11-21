import { describe, it, expect } from 'vitest';
import { runChecks, runHealthCheck, summarize, secretNames, type Snapshot } from '../src/lib/health-check';
import { JOB_DEFS } from '../src/lib/job-defs';
import { world, card, put, get, T0 } from './jobs-helpers';

const empty = (over: Partial<Snapshot> = {}): Snapshot => ({ inbox: [], answeredOpen: [], tasks: [], rows: [], meta: [], digest: [], triggers: [], runs: [], watch: null, latest: null, ...over });
const check = (cs: ReturnType<typeof runChecks>, id: string) => cs.find((c) => c.id === id)!;
const dig = (name: string, updated: string) => ({ id: name, data: { updated, items: [] } });

describe('health check: the pure checks', () => {
  it('a digest must have been written since the start of the previous working day; weekends are not checked', () => {
    const mon = new Date('2026-11-23T09:20:00Z');
    const fresh = runChecks(empty({ digest: [dig('live', '2026-11-20 16:14:13'), dig('slack', '2026-11-19T10:00:00Z')] }), mon);
    expect(check(fresh, 'DIGEST-LIVE').pass).toBe(true);          // Friday is the previous working day of a Monday
    expect(check(fresh, 'DIGEST-SLACK').pass).toBe(false);         // Thursday is too old
    expect(check(fresh, 'DIGEST-MONDAY').pass).toBeNull();         // not found
    const sat = runChecks(empty({ digest: [dig('live', '2026-11-10T00:00:00Z')] }), new Date('2026-11-21T09:20:00Z'));
    expect(check(sat, 'DIGEST-LIVE').pass).toBeNull();
  });

  it('the newer of a digest and its relay-era copy in meta wins', () => {
    const cs = runChecks(empty({ digest: [dig('live', '2026-11-10T10:00:00Z')], meta: [{ id: 'digest/live', data: { updated: '2026-11-23T08:00:00Z' } }] }), new Date('2026-11-24T09:20:00Z'));
    expect(check(cs, 'DIGEST-LIVE').pass).toBe(true);
  });

  it('flags a job that has missed three of its intervals, a failed run, and a dormant job is left alone', () => {
    const runs = [
      { id: 'trig_answerwatch', data: { status: 'ok', fired_at: '2026-11-23T08:00:00Z' } },   // 90 minutes: over three 15-minute intervals
      { id: 'trig_healthcheck', data: { status: 'failed', fired_at: '2026-11-22T09:20:00Z' } },
    ];
    const cs = runChecks(empty({ runs }), new Date('2026-11-23T09:30:00Z'));
    expect(check(cs, 'RUN-MISSED')).toMatchObject({ pass: false, value: 1 });
    expect(check(cs, 'RUN-MISSED').note).toContain('Answer watch');
    expect(check(cs, 'RUN-FAILED')).toMatchObject({ pass: false, value: 1 });
    const none = runChecks(empty(), new Date('2026-11-23T09:30:00Z'));
    expect(check(none, 'RUN-MISSED')).toMatchObject({ pass: true });
    // a job switched off in the registry is left alone
    const off = runChecks(empty({ runs, triggers: [{ id: 'trig_answerwatch', data: { enabled: false } }] }), new Date('2026-11-23T09:30:00Z'));
    expect(check(off, 'RUN-MISSED').pass).toBe(true);
    expect(JOB_DEFS.length).toBe(6);
  });

  it('on a Monday from 09:00 the brief card must exist; before 09:00 and on other days it is not asked', () => {
    const mon = new Date('2026-11-23T09:30:00Z');
    expect(check(runChecks(empty(), mon), 'BRIEF-MON')).toMatchObject({ pass: false, severity: 'high' });
    const ok = runChecks(empty({ inbox: [{ id: 'work-brief-2026-11-23', data: {} }] }), mon);
    expect(check(ok, 'BRIEF-MON').pass).toBe(true);
    const viaTitle = runChecks(empty({ inbox: [{ id: 'x', data: { title: 'Work week brief w/c Mon 23 Nov', created: '2026-11-23T07:50:00Z' } }] }), mon);
    expect(check(viaTitle, 'BRIEF-MON').pass).toBe(true);
    expect(runChecks(empty(), new Date('2026-11-23T08:30:00Z')).find((c) => c.id === 'BRIEF-MON')).toBeUndefined();
    expect(runChecks(empty(), new Date('2026-11-24T09:30:00Z')).find((c) => c.id === 'BRIEF-MON')).toBeUndefined();
  });

  it('answered cards: before the baseline they are counted, after it an unowned one two hours old fails', () => {
    const answeredOpen = [
      { id: 'legacy', data: card('legacy', 1, { answered: '2026-11-20T08:00:00Z' }) },
      { id: 'late', data: card('late', 2, { answered: '2026-11-23T06:00:00Z' }) },
    ];
    const none = runChecks(empty({ answeredOpen }), new Date('2026-11-23T09:30:00Z'));
    expect(check(none, 'ANS-2H-P').pass).toBeNull();
    const cs = runChecks(empty({ answeredOpen, watch: { since: '2026-11-22T00:00:00Z' } }), new Date('2026-11-23T09:30:00Z'));
    expect(check(cs, 'ANS-2H-P')).toMatchObject({ pass: false, value: 1 });
    expect(check(cs, 'ANS-LEGACY').value).toBe(1);
  });

  it('queued tasks over a day, secret-like field names (never values) and repeated card numbers', () => {
    const cs = runChecks(empty({
      tasks: [{ id: 't1', data: { status: 'queued', created: '2026-11-21T08:00:00Z' } }, { id: 't2', data: { status: 'queued', needs_laptop: true, created: '2026-11-01T08:00:00Z' } }],
      meta: [{ id: 'cfg', data: { slack: { api_token: 'zzz' } } }],
      inbox: [{ id: 'a', data: { n: 5, created: '2026-11-22T08:00:00Z' } }, { id: 'b', data: { n: 5, created: '2026-11-22T09:00:00Z' } }],
    }), new Date('2026-11-23T09:30:00Z'));
    expect(check(cs, 'TASK-Q24')).toMatchObject({ pass: false, value: 1 });
    expect(check(cs, 'META-SECRET')).toMatchObject({ pass: false, severity: 'high' });
    expect(check(cs, 'META-SECRET').note).toContain('cfg.slack.api_token');
    expect(JSON.stringify(cs)).not.toContain('zzz');
    expect(check(cs, 'DUP-N-P')).toMatchObject({ pass: false, value: 1 });
    expect(secretNames('d', { a: { keep_awake: 1, b_secret: 2 } })).toEqual(['d.a.b_secret']);
  });

  it('summary names the serious faults and what changed since last time', () => {
    const cs = runChecks(empty(), new Date('2026-11-23T09:30:00Z')); // BRIEF-MON fails
    const s = summarize(cs, { checks: [{ id: 'BRIEF-MON', pass: true }] }, new Date('2026-11-23T09:30:00Z'));
    expect(s.counts.fail_high).toBe(1);
    expect(s.status_line).toContain('Monday brief missing');
    expect(s.since_last?.regressions).toEqual(['BRIEF-MON']);
  });
});

describe('health check: the run', () => {
  it('a Monday with no brief writes the report, one card and one push; running again the same day adds nothing', async () => {
    const w = await world();
    const r = await runHealthCheck(w.deps);
    expect(r.card).toEqual({ id: 'health-check-2026-11-23', created: true });
    expect((await get(w.ctx, 'audit', 'health-2026-11-23')).data.counts.fail_high).toBeGreaterThanOrEqual(1);
    expect((await get(w.ctx, 'audit', 'health-latest')).exists).toBe(true);
    const c = (await get(w.ctx, 'inbox', 'health-check-2026-11-23')).data;
    expect(c).toMatchObject({ source: 'health-check', row: 'work', answered: null, n: 1 });
    expect(c.text).toContain('Monday brief missing');
    expect(w.pushes).toHaveLength(1);
    const again = await runHealthCheck(w.deps);
    expect(again.card).toEqual({ id: 'health-check-2026-11-23', created: false });
    expect(w.pushes).toHaveLength(1);
  });

  it('with the brief card in place and nothing else wrong there is no card and no push', async () => {
    const w = await world();
    await put(w.ctx, 'inbox', 'work-brief-2026-11-23', card('work-brief-2026-11-23', 1, { title: 'Work week brief w/c Mon 23 Nov', created: '2026-11-23T07:50:00Z' }));
    const r = await runHealthCheck(w.deps);
    expect(r.report.counts.fail_high).toBe(0);
    expect(r.card).toBeNull();
    expect(w.pushes).toHaveLength(0);
  });
});
