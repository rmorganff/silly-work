import { describe, it, expect } from 'vitest';
import { actOnProposals, weekItems, runFridayReview } from '../src/lib/friday-review';
import { runJob } from '../src/lib/jobs';
import { world, card, put, get } from './jobs-helpers';

const FRI = '2026-11-20T15:50:00Z';
const proposal = (id: string, n: number, title: string, answer: string | null, over: Record<string, any> = {}) =>
  card(id, n, { title, text: 'Do this?', details: [{ h: 'Source', text: 'Friday review 2026-11-13' }, { h: 'Proposal', text: 'The proposal in full.' }], answered: answer ? '2026-11-19T10:00:00Z' : null, answer, ...over });
const ideas = (...items: any[]) => ({ value: items });

describe('Friday review: last week’s proposals', () => {
  it('A on an idea queues one task and marks the idea taken; B drops it; C drops it for later; all are actioned', async () => {
    const w = await world(new Date(FRI));
    await put(w.ctx, 'meta', 'ideas', ideas({ id: 'i1', title: 'Weekly rota check', status: 'new', created: '2026-11-10T09:00:00Z' }, { id: 'i2', title: 'Tidy old rows', status: 'new', created: '2026-11-10T09:00:00Z' }));
    await put(w.ctx, 'inbox', 'p1', proposal('p1', 1, 'Idea: Weekly rota check', 'A: yes, do it'));
    await put(w.ctx, 'inbox', 'p2', proposal('p2', 2, 'Idea: Tidy old rows', 'B: no'));
    await put(w.ctx, 'inbox', 'p3', proposal('p3', 3, 'Proposal: retire a routine', 'C: later'));
    const r = await actOnProposals(w.ctx, w.deps.now());
    expect(r.done.map((d) => [d.id, d.did]).sort()).toEqual([
      ['p1', 'done: queued as a task by the Friday review'], ['p2', 'dropped: idea dropped'], ['p3', 'dropped: later'],
    ]);
    expect((await get(w.ctx, 'tasks', 'idea-p1')).data).toMatchObject({ title: 'Weekly rota check', status: 'queued', source: 'Friday review', result: null });
    const list = (await get(w.ctx, 'meta', 'ideas')).data.value;
    expect(list.find((i: any) => i.id === 'i1')).toMatchObject({ status: 'taken' });
    expect(list.find((i: any) => i.id === 'i2')).toMatchObject({ status: 'dropped' });
    expect((await get(w.ctx, 'inbox', 'p1')).data.actioned).toBeTruthy();
    expect((await get(w.ctx, 'inbox', 'p1')).data.answer).toBe('A: yes, do it'); // the answer is never changed
  });

  it('A on a routine or fix is left for Ronnie, an unanswered proposal is ignored, and a rerun makes no second task', async () => {
    const w = await world(new Date(FRI));
    await put(w.ctx, 'inbox', 'p4', proposal('p4', 4, 'Proposal: change a prompt', 'A: yes, do it'));
    await put(w.ctx, 'inbox', 'p5', proposal('p5', 5, 'Idea: Something', null));
    await put(w.ctx, 'inbox', 'p6', card('p6', 6, { title: 'Idea: Not from the review', answered: '2026-11-19T10:00:00Z', answer: 'A: ok' }));
    const r = await actOnProposals(w.ctx, w.deps.now());
    expect(r).toEqual({ done: [], left: ['p4'] });
    expect((await get(w.ctx, 'inbox', 'p4')).data.actioned).toBeNull();
    expect((await get(w.ctx, 'tasks', 'idea-p6')).exists).toBe(false);
    await put(w.ctx, 'inbox', 'p7', proposal('p7', 7, 'Idea: Once only', 'A: yes, do it'));
    await actOnProposals(w.ctx, w.deps.now());
    await put(w.ctx, 'inbox', 'p7', proposal('p7', 7, 'Idea: Once only', 'A: yes, do it')); // reopened
    await actOnProposals(w.ctx, w.deps.now());
    expect((await get(w.ctx, 'tasks', 'idea-p7')).version).toBe(1);
  });
});

describe('Friday review: the week in numbers', () => {
  it('builds up to 8 short items from the data alone', async () => {
    const w = await world(new Date(FRI));
    await put(w.ctx, 'inbox', 'a', card('a', 1, { created: '2026-11-18T08:00:00Z', answered: '2026-11-18T10:00:00Z' }));
    await put(w.ctx, 'inbox', 'b', card('b', 2, { created: '2026-11-18T08:00:00Z', answered: '2026-11-18T12:00:00Z' }));
    await put(w.ctx, 'inbox', 'c', card('c', 3, { created: '2026-11-15T08:00:00Z' }));
    await put(w.ctx, 'tasks', 't1', { title: 'x', status: 'done', updated: '2026-11-19T08:00:00Z' });
    await put(w.ctx, 'tasks', 't2', { title: 'y', status: 'queued', updated: '2026-11-19T08:00:00Z' });
    await put(w.ctx, 'rows', 'work', { name: 'work', status: 'done', updated: '2026-11-19T08:00:00Z' });
    await put(w.ctx, 'rows', 'ats', { name: 'ats', status: 'running', updated: '2026-11-01T08:00:00Z' });
    const items = weekItems({
      inbox: await (await import('../src/lib/board')).listDocs(w.ctx, 'inbox'), tasks: await (await import('../src/lib/board')).listDocs(w.ctx, 'tasks'),
      rows: await (await import('../src/lib/board')).listDocs(w.ctx, 'rows'), ideas: [{ created: '2026-11-18T08:00:00Z', status: 'new' }], triggers: [], runs: [], sweep: { flags: ['a', 'b'] }, health: { status_line: 'Health 20 Nov: all 12 checks pass.' },
    }, w.deps.now());
    expect(items.length).toBeLessThanOrEqual(8);
    expect(items.every((i) => i.title.length < 70)).toBe(true);
    const text = Object.fromEntries(items.map((i) => [i.title, i.text]));
    expect(text['Cards answered this week']).toBe('2 answered, waiting 3.0 hours on average.');
    expect(text['Cards waiting for Ronnie']).toMatch(/^1 unanswered, the oldest 5 days old/);
    expect(text['Tasks']).toBe('1 done this week, 1 still queued.');
    expect(text['Project rows']).toBe('1 updated in the last 7 days, 1 not.');
    expect(text['Sweep flags still open']).toBe('2 flagged by the last sweep.');
  });

  it('raises one review card with a push, and not a second one the same day (or when the routine already made one)', async () => {
    const w = await world(new Date(FRI));
    await put(w.ctx, 'inbox', 'a', card('a', 1));
    const r = await runFridayReview(w.deps);
    expect(r.card).toEqual({ id: 'work-week-review-2026-11-20', created: true });
    const c = (await get(w.ctx, 'inbox', 'work-week-review-2026-11-20')).data;
    expect(c).toMatchObject({ title: 'Work week review w-e Fri 20 Nov', source: 'friday-review', options: ['A: noted'], n: 2 });
    expect(c.details[0]).toMatchObject({ h: 'The week', numbered: true });
    expect(w.pushes).toHaveLength(1);
    expect((await runFridayReview(w.deps)).card).toBeNull();
    const w2 = await world(new Date(FRI));
    await put(w2.ctx, 'inbox', 'theirs', card('theirs', 1, { title: 'Work week review w-e Fri 20 Nov', created: '2026-11-20T15:41:00Z' }));
    expect((await runFridayReview(w2.deps)).card).toBeNull();
  });

  it('is seeded dormant: scheduled, it does nothing until switched on', async () => {
    const w = await world(new Date(FRI));
    expect(await runJob(w.deps, 'trig_fridayreview', 'schedule')).toMatchObject({ status: 'disabled' });
    expect((await get(w.ctx, 'inbox', 'work-week-review-2026-11-20')).exists).toBe(false);
  });
});
