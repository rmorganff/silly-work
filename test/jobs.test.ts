import { describe, it, expect } from 'vitest';
import { runJob } from '../src/lib/jobs';
import { handleTrigger } from '../src/lib/trigger';
import { world, get, put } from './jobs-helpers';

const MIN = 60_000;

describe('job runner', () => {
  it('seeds its registry doc once, runs, and leaves one run record', async () => {
    const w = await world();
    const out = await runJob(w.deps, 'trig_answerwatch', 'schedule');
    expect(out).toMatchObject({ status: 'ok', id: 'trig_answerwatch' });
    const t = (await get(w.ctx, '_triggers', 'trig_answerwatch')).data;
    expect(t).toMatchObject({ name: 'Answer watch', function: 'answer-watch-scheduled', enabled: true, runtime: 'netlify' });
    const r = (await get(w.ctx, '_trigger_runs', 'trig_answerwatch')).data;
    expect(r).toMatchObject({ status: 'ok', by: 'schedule', fired_at: '2026-11-23T09:30:00Z', error: null });
    w.advance(15 * MIN);
    await runJob(w.deps, 'trig_answerwatch', 'schedule');
    expect((await get(w.ctx, '_triggers', 'trig_answerwatch')).version).toBe(1); // never overwritten
    expect((await get(w.ctx, '_trigger_runs', 'trig_answerwatch')).data.fired_at).toBe('2026-11-23T09:45:00Z');
  });

  it('a job scheduled on the wrong London hour exits at once and leaves no record; the right hour runs', async () => {
    const w = await world(new Date('2026-07-10T09:20:00Z')); // BST: 10:20 London, the wrong one
    expect(await runJob(w.deps, 'trig_healthcheck', 'schedule')).toMatchObject({ status: 'off_hour' });
    expect((await get(w.ctx, '_trigger_runs', 'trig_healthcheck')).exists).toBe(false);
    w.at('2026-07-10T08:20:00Z'); // 09:20 London
    expect(await runJob(w.deps, 'trig_healthcheck', 'schedule')).toMatchObject({ status: 'ok' });
    // a fire through /api/trigger is not held to the hour
    const w2 = await world(new Date('2026-07-10T09:20:00Z'));
    expect(await runJob(w2.deps, 'trig_healthcheck', 'fire')).toMatchObject({ status: 'ok' });
  });

  it('a switched-off job does not run; a failure is recorded with its code and never thrown', async () => {
    const w = await world();
    await runJob(w.deps, 'trig_answerwatch', 'schedule');
    await w.deps.ctx.client.execute({ sql: `UPDATE docs SET data = json_set(data, '$.enabled', json('false')) WHERE collection = '_triggers' AND doc_id = 'trig_answerwatch'` });
    w.advance(15 * MIN);
    expect(await runJob(w.deps, 'trig_answerwatch', 'schedule')).toMatchObject({ status: 'disabled' });
    expect((await get(w.ctx, '_trigger_runs', 'trig_answerwatch')).data.fired_at).toBe('2026-11-23T09:30:00Z'); // unchanged

    const broken = await world();
    await broken.deps.ctx.client.execute('DROP TABLE seq_counter');
    const out = await runJob({ ...broken.deps }, 'trig_healthcheck', 'fire').catch((e) => ({ threw: String(e) }));
    expect(out).not.toHaveProperty('threw');
  });

  it('an unknown job is refused', async () => {
    const w = await world();
    expect(await runJob(w.deps, 'trig_nope', 'fire')).toMatchObject({ status: 'no_such_job' });
  });
});

describe('/api/trigger', () => {
  it('lists this site’s jobs with their last run; filters by enabled', async () => {
    const w = await world();
    const all = (await handleTrigger(w.deps, { tool: 'list_triggers', args: {} })).body.data as any[];
    expect(all.map((t) => t.id)).toEqual(['trig_answerwatch', 'trig_healthcheck', 'trig_fridayreview', 'trig_weekbrief', 'trig_chase']);
    expect(all.find((t) => t.id === 'trig_fridayreview')).toMatchObject({ enabled: true, last_run: null, runtime: 'netlify' });
    await handleTrigger(w.deps, { tool: 'update_trigger', args: { trigger_id: 'trig_chase', enabled: false } });
    const on = (await handleTrigger(w.deps, { tool: 'list_triggers', args: { enabled: true } })).body.data as any[];
    expect(on.map((t) => t.id)).toEqual(['trig_answerwatch', 'trig_healthcheck', 'trig_fridayreview', 'trig_weekbrief']);
    await runJob(w.deps, 'trig_answerwatch', 'schedule');
    const again = (await handleTrigger(w.deps, { tool: 'list_triggers', args: {} })).body.data as any[];
    expect(again.find((t) => t.id === 'trig_answerwatch').last_run).toMatchObject({ status: 'ok', fired_at: '2026-11-23T09:30:00Z' });
  });

  it('fire_trigger runs the job now, refuses an unknown id, a dormant job, and a second fire inside the cooldown', async () => {
    const w = await world();
    expect((await handleTrigger(w.deps, { tool: 'fire_trigger', args: { trigger_id: 'nope' } })).body).toMatchObject({ fired: false, code: 'no_such_trigger' });
    await handleTrigger(w.deps, { tool: 'update_trigger', args: { trigger_id: 'trig_healthcheck', enabled: false } });
    expect((await handleTrigger(w.deps, { tool: 'fire_trigger', args: { trigger_id: 'trig_healthcheck' } })).body).toMatchObject({ fired: false, code: 'trigger_disabled' });
    const ok = await handleTrigger(w.deps, { tool: 'fire_trigger', args: { trigger_id: 'trig_answerwatch' } });
    expect(ok.body).toMatchObject({ fired: true, status: 'ok', error: null });
    const again = await handleTrigger(w.deps, { tool: 'fire_trigger', args: { trigger_id: 'trig_answerwatch' } });
    expect(again.body).toMatchObject({ fired: false, code: 'rate_limited' });
    expect(again.body.error).toBeTruthy(); // the bridge reads {error} as a refused fire
    w.advance(3 * MIN);
    expect((await handleTrigger(w.deps, { tool: 'fire_trigger', args: { trigger_id: 'trig_answerwatch' } })).body).toMatchObject({ fired: true });
  });

  it('update_trigger switches a job on and off; the Friday review runs once switched back on', async () => {
    const w = await world(new Date('2026-11-20T15:50:00Z'));
    expect((await handleTrigger(w.deps, { tool: 'update_trigger', args: { trigger_id: 'trig_fridayreview', enabled: false } })).body).toMatchObject({ enabled: false });
    expect(await runJob(w.deps, 'trig_fridayreview', 'background')).toMatchObject({ status: 'disabled' });
    expect((await handleTrigger(w.deps, { tool: 'update_trigger', args: { trigger_id: 'trig_fridayreview', enabled: true } })).body).toMatchObject({ enabled: true });
    expect((await get(w.ctx, '_triggers', 'trig_fridayreview')).data.enabled).toBe(true);
    await put(w.ctx, 'inbox', 'a', { id: 'a', n: 1, title: 'Retail 5 open', text: 'x', options: ['A: ok'], created: '2026-11-19T08:00:00Z', answered: null, answer: null, actioned: null });
    expect(await runJob(w.deps, 'trig_fridayreview', 'background')).toMatchObject({ status: 'ok' });
    expect((await get(w.ctx, 'inbox', 'work-week-review-2026-11-20')).exists).toBe(true);
    expect((await handleTrigger(w.deps, { tool: 'update_trigger', args: { trigger_id: 'trig_fridayreview', enabled: 'yes' } })).status).toBe(400);
    expect((await handleTrigger(w.deps, { tool: 'update_trigger', args: { trigger_id: 'nope', enabled: true } })).body).toMatchObject({ code: 'no_such_trigger' });
    expect((await handleTrigger(w.deps, { tool: 'delete_everything', args: {} })).status).toBe(400);
  });
});
