import { describe, it, expect } from 'vitest';
import { runChase, workingHoursBetween, inWorkWindow, THANKS } from '../src/lib/chase';
import { worldB, fakeSlack } from './b-helpers';
import { put, get } from './jobs-helpers';

const item = (over: Record<string, any> = {}) => ({
  id: 'q1', status: 'open', channel: 'C0101QQN8SY', thread_ts: '1794411698.000000', asked_ts: '1794411698.000000', asked_at: '2026-11-20T09:00:00Z',
  to_slack: 'UK1', to_initials: 'NB', question: 'Should an archived vacancy count as live?', chase_text: '<@UK1> a quick yes or no please.', max_chases: 2, chases: [],
  on_answer: 'Set meta/retail_summary.counts_archived to false and say thanks in the thread.', on_no_answer: '', ...over,
});
const put_q = (w: any, items: any[]) => put(w.ctx, 'meta', 'meta/questions', { items, what: 'open questions' });
const reply = (user: string, ts: string, text = 'yes') => ({ ts, user, text });
const MON_10 = '2026-11-23T10:00:00Z'; // Monday 10:00 London

describe('working hours', () => {
  it('counts weekday 08:30 to 17:00 London only', () => {
    expect(inWorkWindow(new Date('2026-11-23T08:29:00Z'))).toBe(false);
    expect(inWorkWindow(new Date('2026-11-23T08:30:00Z'))).toBe(true);
    expect(inWorkWindow(new Date('2026-11-23T17:00:00Z'))).toBe(false);
    expect(inWorkWindow(new Date('2026-11-21T10:00:00Z'))).toBe(false); // Saturday
    expect(inWorkWindow(new Date('2026-07-10T07:30:00Z'))).toBe(true);  // 08:30 BST
    // Friday 16:00 to Monday 10:00 is 1 + 1.5 = 2.5 working hours
    expect(workingHoursBetween(Date.parse('2026-11-20T16:00:00Z'), Date.parse('2026-11-23T10:00:00Z'))).toBeCloseTo(2.5, 1);
  });
});

describe('chase open Slack questions', () => {
  it('chases an unanswered question once, in its own thread, with its own words; never twice in a run; records it', async () => {
    const slack = fakeSlack();
    const w = await worldB({ slack, start: new Date(MON_10), key: false });
    await put_q(w, [item(), item({ id: 'q2', thread_ts: '2.0', asked_ts: '2.0' })]);
    const r = await runChase(w.deps);
    expect(r).toMatchObject({ open: 2, chased: 2 });
    expect(slack.posts).toEqual([
      { channel: 'C0101QQN8SY', thread: '1794411698.000000', text: '<@UK1> a quick yes or no please.' },
      { channel: 'C0101QQN8SY', thread: '2.0', text: '<@UK1> a quick yes or no please.' },
    ]);
    const doc = (await get(w.ctx, 'meta', 'meta/questions')).data;
    expect(doc.items.every((i: any) => i.chases.length === 1 && i.chases[0].by === 'chase task')).toBe(true);
    const again = await runChase(w.deps);               // the same morning: nothing is due
    expect(again.chased).toBe(0);
    expect(slack.posts).toHaveLength(2);
  });

  it('does not chase outside working hours, or before three working hours have passed', async () => {
    const slack = fakeSlack();
    const sat = await worldB({ slack, start: new Date('2026-11-21T10:00:00Z'), key: false });
    await put_q(sat, [item()]);
    expect((await runChase(sat.deps)).chased).toBe(0);
    const early = await worldB({ slack, start: new Date('2026-11-20T10:00:00Z'), key: false }); // asked 09:00 same day: 1 working hour
    await put_q(early, [item()]);
    expect((await runChase(early.deps)).chased).toBe(0);
    expect(slack.posts).toEqual([]);
  });

  it('a reply the model judges an answer is recorded; the plan is followed within limits: a fixed thank-you, one meta field', async () => {
    const slack = fakeSlack({ replies: { 'C0101QQN8SY/1794411698.000000': [reply('UK1', '1794411800.0', 'Yes, count it as live'), reply('USOMEONE', '1794411900.0', 'me too')] } });
    const w = await worldB({ slack, start: new Date(MON_10), handlers: {
      judge: () => ({ answered: true, answer: 'Yes, it counts as live.' }),
      plan: () => ({ thank_you: true, set_field: { path: 'meta/retail_summary', field: 'counts_archived', value: false }, other_action: false }) } });
    await put(w.ctx, 'meta', 'meta/retail_summary', { board_id: 1, counts_archived: true });
    await put_q(w, [item(), item({ id: 'done', status: 'answered', answered_at: '2026-11-22T09:00:00Z' })]);
    const r = await runChase(w.deps);
    expect(r).toMatchObject({ answered: 1, chased: 0 });
    const q = (await get(w.ctx, 'meta', 'meta/questions')).data.items;
    expect(q.find((i: any) => i.id === 'q1')).toMatchObject({ status: 'answered', answer: 'Yes, it counts as live.' });
    expect(q.find((i: any) => i.id === 'done')).toBeTruthy();              // other items are never dropped
    expect(slack.posts).toEqual([{ channel: 'C0101QQN8SY', thread: '1794411698.000000', text: THANKS }]); // the only words the model ever influences
    expect((await get(w.ctx, 'meta', 'meta/retail_summary')).data.counts_archived).toBe(false);
    expect(w.llm.map((l) => `${l.tool}:${l.model}`)).toEqual(['judge:claude-haiku-5-5', 'plan:claude-haiku-5-5']);
  });

  it('a plan naming a path or field outside the allowed shape becomes a queued task, never a write', async () => {
    const slack = fakeSlack({ replies: { 'C0101QQN8SY/1794411698.000000': [reply('UK1', '1794411800.0')] } });
    const w = await worldB({ slack, start: new Date(MON_10), handlers: {
      judge: () => ({ answered: true, answer: 'Yes.' }),
      plan: () => ({ thank_you: false, set_field: { path: 'inbox/some-card', field: 'answered', value: 'x' }, other_action: false }) } });
    await put(w.ctx, 'inbox', 'some-card', { id: 'some-card', n: 1, title: 't', answered: null });
    await put_q(w, [item()]);
    await runChase(w.deps);
    expect((await get(w.ctx, 'inbox', 'some-card')).data.answered).toBeNull();
    expect((await get(w.ctx, 'tasks', 'chase-q1')).data).toMatchObject({ status: 'queued', source: 'Chase open Slack questions' });
  });

  it('a reply it cannot judge (no model) is left alone: no chase and no record', async () => {
    const slack = fakeSlack({ replies: { 'C0101QQN8SY/1794411698.000000': [reply('UK1', '1794411800.0')] } });
    const w = await worldB({ slack, start: new Date(MON_10), key: false });
    await put_q(w, [item()]);
    const r = await runChase(w.deps);
    expect(r).toMatchObject({ skipped: 1, chased: 0, answered: 0 });
    expect(slack.posts).toEqual([]);
  });

  it('a reply that is not an answer leaves the question open and chased as usual', async () => {
    const slack = fakeSlack({ replies: { 'C0101QQN8SY/1794411698.000000': [reply('UK1', '1794411800.0', 'will look later')] } });
    const w = await worldB({ slack, start: new Date(MON_10), handlers: { judge: () => ({ answered: false, answer: '' }) } });
    await put_q(w, [item()]);
    expect((await runChase(w.deps)).chased).toBe(1);
  });

  it('when the chases are used up the item lapses and one card is raised with a push; an item with on_no_answer set still lapses', async () => {
    const slack = fakeSlack();
    const w = await worldB({ slack, start: new Date('2026-11-23T14:00:00Z'), key: false });
    await put_q(w, [item({ chases: [{ at: '2026-11-20T10:00:00Z', by: 'chase task' }, { at: '2026-11-23T09:00:00Z', by: 'chase task' }] })]);
    const r = await runChase(w.deps);
    expect(r).toMatchObject({ lapsed: 1, chased: 0 });
    expect((await get(w.ctx, 'meta', 'meta/questions')).data.items[0]).toMatchObject({ status: 'lapsed' });
    const c = (await get(w.ctx, 'inbox', 'chase-q1')).data;
    expect(c).toMatchObject({ options: ["A: I'll chase", 'B: drop it'], source: 'chase-slack-questions', row: 'work' });
    expect(c.title).toMatch(/^No answer: /);
    expect(w.pushes).toHaveLength(1);
    expect(slack.posts).toEqual([]);
  });

  it('an unreadable questions document fails the run (recorded for the health check); a failed post is noted and the run carries on', async () => {
    const w = await worldB({ slack: fakeSlack(), start: new Date(MON_10), key: false });
    await expect(runChase(w.deps)).rejects.toMatchObject({ code: 'questions_unreadable' });
    const bad = fakeSlack({ postFails: true });
    const w2 = await worldB({ slack: bad, start: new Date(MON_10), key: false });
    await put_q(w2, [item()]);
    const r = await runChase(w2.deps);
    expect(r.chased).toBe(0);
    expect(r.notes.join(' ')).toContain('channel_not_found');
  });

  it('answered and lapsed items are removed after 14 days', async () => {
    const w = await worldB({ slack: fakeSlack(), start: new Date(MON_10), key: false });
    await put_q(w, [item({ id: 'old', status: 'answered', answered_at: '2026-11-01T09:00:00Z' }), item({ id: 'new', status: 'answered', answered_at: '2026-11-20T09:00:00Z' })]);
    await runChase(w.deps);
    expect((await get(w.ctx, 'meta', 'meta/questions')).data.items.map((i: any) => i.id)).toEqual(['new']);
  });
});
