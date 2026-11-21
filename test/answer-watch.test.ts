import { describe, it, expect } from 'vitest';
import { runAnswerWatch, taskIdFor } from '../src/lib/answer-watch';
import { db } from './helpers';
import { world, card, put, get, T0 } from './jobs-helpers';

const MIN = 60_000, HOUR = 3600_000;
const watch = (w: Awaited<ReturnType<typeof world>>) => runAnswerWatch(w.deps);
const answered = (id: string, n: number, at: string, over: Record<string, any> = {}) => card(id, n, { answered: at, answer: 'A: ok', ...over });

describe('answer watch', () => {
  it('its first run only draws a line at now: cards answered before it are counted and never touched', async () => {
    const w = await world();
    await put(w.ctx, 'inbox', 'old-1', answered('old-1', 1, '2026-11-20T08:36:42Z'));
    await put(w.ctx, 'inbox', 'old-2', answered('old-2', 2, '2026-11-18T14:22:45Z'));
    const first = await watch(w);
    expect(first).toMatchObject({ baselined: true, legacy: 2, handled: [] });
    const state = await get(w.ctx, 'meta', 'answer-watch');
    expect(state.data.since).toBe('2026-11-23T09:30:00Z');
    w.advance(15 * MIN);
    const second = await watch(w);
    expect(second).toMatchObject({ baselined: false, legacy: 2, handled: [] });
    expect((await get(w.ctx, 'tasks', taskIdFor('old-1'))).exists).toBe(false);
    expect((await get(w.ctx, 'inbox', 'old-1')).data.hold).toBeUndefined();
    expect((await get(w.ctx, 'inbox', 'old-1')).version).toBe(1); // not written to
  });

  it('a card answered after the baseline gets one task and a hold; a second pass does nothing more', async () => {
    const w = await world();
    await watch(w); // baseline at T0
    w.advance(10 * MIN);
    await put(w.ctx, 'inbox', 'c-1', answered('c-1', 7, '2026-11-23T09:35:00Z', { title: 'Retail 5 open', row: 'work' }));
    const r = await watch(w);
    expect(r.handled).toEqual([{ id: 'c-1', did: 'queued task t-answer-c-1' }]);
    const task = (await get(w.ctx, 'tasks', 't-answer-c-1')).data;
    expect(task).toMatchObject({ status: 'queued', source: 'answer-watch', card: 'c-1', row: 'work', result: null });
    expect(task.detail).not.toContain('A: ok'); // the answer's words are not copied
    const c = (await get(w.ctx, 'inbox', 'c-1')).data;
    expect(c.hold).toEqual({ task: 't-answer-c-1' });
    expect(c).toMatchObject({ answered: '2026-11-23T09:35:00Z', answer: 'A: ok', actioned: null, options: ['A: ok', 'B: later'] }); // the answer is untouched
    w.advance(15 * MIN);
    const again = await watch(w);
    expect(again.handled).toEqual([]);
    expect(again.skipped).toContain('c-1');
  });

  it('leaves alone a card a chat was woken on, and a card marked as being worked on now', async () => {
    const w = await world();
    await watch(w);
    w.advance(10 * MIN);
    await put(w.ctx, 'inbox', 'chat', answered('chat', 8, '2026-11-23T09:35:00Z', { link: 'https://claude.ai/code/session_abc' }));
    await put(w.ctx, 'inbox', 'busy', answered('busy', 9, '2026-11-23T09:35:00Z', { state: 'doing', state_at: '2026-11-23T09:38:00Z' }));
    const r = await watch(w);
    expect(r.handled).toEqual([]);
    expect(r.skipped.sort()).toEqual(['busy', 'chat']);
  });

  it('a task that finished while its card is still open is reported as overdue, with one attention card and one push', async () => {
    const w = await world();
    await watch(w);
    w.advance(10 * MIN);
    await put(w.ctx, 'inbox', 'c-2', answered('c-2', 10, '2026-11-23T09:35:00Z'));
    await watch(w); // task queued, card held
    await db(w.ctx, { op: 'update', collection: 'tasks', doc_id: 't-answer-c-2', data: { status: 'done' } });
    w.advance(3 * HOUR);
    const r = await watch(w);
    expect(r.attention).toEqual([expect.objectContaining({ id: 'card/c-2', kind: 'overdue' })]);
    const meta = (await get(w.ctx, 'meta', 'runs-attention')).data;
    const att = (await get(w.ctx, 'inbox', meta.card)).data;
    expect(att).toMatchObject({ title: 'Runs needing attention', source: 'answer-watch', row: 'work', answered: null });
    expect(att.n).toBe(11); // the next number after the highest on the inbox (10)
    expect(w.pushes).toHaveLength(1);
    await watch(w); // nothing changed: no second card, no second push
    expect(w.pushes).toHaveLength(1);
    // once the card is dealt with the attention card closes itself
    await db(w.ctx, { op: 'update', collection: 'inbox', doc_id: 'c-2', data: { actioned: '2026-11-23T13:00:00Z' } });
    const clear = await watch(w);
    expect(clear.attention).toEqual([]);
    expect((await get(w.ctx, 'inbox', meta.card)).data.actioned).toBeTruthy();
  });

  it('reports a failed run of a scheduled job from the last day, and a running task nothing has touched for 90 minutes', async () => {
    const w = await world();
    await watch(w);
    await put(w.ctx, 'tasks', 't-run', { title: 'A task', status: 'running', updated: '2026-11-23T07:00:00Z', created: '2026-11-23T06:00:00Z' });
    await put(w.ctx, '_trigger_runs', 'trig_healthcheck', { status: 'failed', fired_at: '2026-11-23T08:30:00Z', error: 'server_error' });
    await put(w.ctx, '_triggers', 'trig_healthcheck', { name: 'Health check', enabled: true });
    w.advance(5 * MIN);
    const r = await watch(w);
    expect(r.attention.map((a) => a.id).sort()).toEqual(['failed/trig_healthcheck', 'task/t-run']);
  });

  it('never writes to rows, and never changes an answered card other than its hold', async () => {
    const w = await world();
    await put(w.ctx, 'rows', 'lms', { name: 'lms', status: 'running', updated: '2026-11-19T08:00:00Z' });
    await watch(w);
    w.advance(10 * MIN);
    await put(w.ctx, 'inbox', 'c-3', answered('c-3', 12, '2026-11-23T09:35:00Z'));
    await watch(w);
    expect((await get(w.ctx, 'rows', 'lms')).version).toBe(1);
    const c = (await get(w.ctx, 'inbox', 'c-3')).data;
    expect(Object.keys(c).sort()).toEqual([...Object.keys(card('c-3', 12)), 'hold', 'watch_seen'].sort());
  });

  it('a card whose title the board will not copy still gets its task, under a plain title', async () => {
    const w = await world();
    await watch(w);
    w.advance(10 * MIN);
    process.env.PII_ALLOW_DOCS = 'inbox/c-4';
    try { await put(w.ctx, 'inbox', 'c-4', answered('c-4', 13, '2026-11-23T09:35:00Z', { title: 'Emma wants a call' })); }
    finally { delete process.env.PII_ALLOW_DOCS; }
    const r = await watch(w);
    expect(r.handled).toHaveLength(1);
    expect((await get(w.ctx, 'tasks', 't-answer-c-4')).data.title).toBe('Act on answered card 13');
  });
});
