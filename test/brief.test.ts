import { describe, it, expect } from 'vitest';
import { runWeekBrief, lineOk, safeLine, vacancies, lossPrevention, openItems } from '../src/lib/brief';
import { runJob } from '../src/lib/jobs';
import { worldB, fakeSlack, fakeMonday, mBoard, mItem, MON } from './b-helpers';
import { put, get } from './jobs-helpers';

const ts = (daysAgo: number) => String((MON.getTime() - daysAgo * 864e5) / 1000);
const msg = (user: string, daysAgo: number, text = 'update on the rota', extra: any = {}) => ({ ts: ts(daysAgo), user, text, ...extra });

const slackWith = () => fakeSlack({
  names: { UA: 'Ada Lovelace', UB: 'Ben Carter', UC: 'Cleo Reed' },
  history: {
    C0101QQN8SY: [msg('UA', 1), msg('UA', 2), msg('UB', 3, 'who owns the Wigan advert?', { reply_count: 0 }), msg('UCTAVAFSA', 1), { ts: ts(1), bot_id: 'B1', text: 'bot' }],
    C06AQD5H5RT: [msg('UC', 2)],
    C0692KPGJUR: [msg('UA', 1, 'Decision: the rota is agreed, 12 shops')],
  },
});

const boards = () => [
  mBoard('1232451925', 'Retail', [mItem('1', 'Wigan Retail Park', 'Interviews', 42, 3), mItem('2', 'Thornaby', 'Awaiting Apps', 40, 20), mItem('3', 'Bury', 'Closed', 90, 1), mItem('4', 'Kirkcaldy', 'Interviews', 5, 1)]),
  mBoard('10', 'Retail Recruitment 2026', [mItem('5', 'Some Candidate', 'Live', 30, 16), mItem('6', 'Another One', 'Callbacks', 2, 1)]),
  mBoard('11', 'Recruitment OLD 2024', [mItem('7', 'x', 'Live', 400, 400)]),
  mBoard('12', 'Subitems of SM / AM Recruitment', [mItem('8', 'A Candidate', 'Live', 500, 500)]),
  mBoard('8247581349', 'Auror', [
    mItem('a1', 'Report 1', 'Arrested | Charged - Awaiting Outcome', 2, 1, { Shop: 'Bolton' }), mItem('a2', 'Report 2', 'Potential Investigations', 3, 2, { Shop: 'Bolton' }),
    mItem('a3', 'Report 3', 'Potential Investigations', 3, 2, { Shop: 'Bury' }), mItem('a4', 'Report 4', 'Evidence Submitted', 60, 40, { Shop: 'Bury' }),
  ]),
];

describe('brief: line checks', () => {
  it('a line the board would refuse is replaced by a plainer one', () => {
    expect(lineOk('Wigan 14 open')).toBe(true);
    expect(lineOk('Emma 14 open')).toBe(false);
    expect(safeLine(['Emma is blocked on the advert', '1 person blocked'])).toBe('1 person blocked');
    expect(lineOk('Arrested | Charged 51', 'lp')).toBe(false);   // narrative words in the loss-prevention context
    expect(safeLine(['x'.repeat(130), 'short'])).toBe('short');
  });
});

describe('brief: monday.com parts', () => {
  it('vacancies: Recruitment boards (not OLD) plus Retail; open items by stage; the oldest; unchanged over 14 days; item names only for Retail', async () => {
    const w = await worldB();
    const monday = fakeMonday(boards());
    const v = await vacancies(monday, MON);
    const text = v.lines.map((l) => l.text).join('\n');
    expect(text).toContain('Retail: 3 open');                  // Bury is in Closed
    expect(text).toContain('Retail Recruitment 2026: 2 open');
    expect(text).not.toContain('OLD');
    expect(text).not.toContain('Subitems');
    expect(monday.calls).not.toContain('12');   // a subitems board is never even read
    expect(text).toMatch(/Oldest open: Wigan Retail Park 42d, Thornaby 40d, Retail Recruitmen… 30d/);
    expect(text).not.toContain('Some Candidate');               // a recruitment board's items are never named
    expect(text).toMatch(/Unchanged over 14 days: Retail 1, Retail Recruitment 2026 1/);
    expect(v.oldest).toBe(42);
    expect(openItems(boards()[0]).map((i) => i.id)).toEqual(['1', '2', '4']);
    void w;
  });

  it('loss prevention: counts and locations only, repeat locations; a stage name with a narrative word falls back to counts', async () => {
    const l = await lossPrevention(fakeMonday(boards()), MON);
    const text = l.lines.map((x) => x.text).join('\n');
    expect(text).toContain('Last 7 days: 3 items changed or created, 3 new');
    expect(text).toContain('Repeat locations: Bolton 2');
    expect(text).not.toMatch(/arrest|charged/i);
    expect(l.repeat).toEqual(['Bolton']);
    expect(text).toContain('Unchanged over 14 days: 1 open items');
  });
});

describe('brief: the card', () => {
  it('Slack and monday.com together make one card with three sections, a push, and nothing posted anywhere', async () => {
    const slack = slackWith(), monday = fakeMonday(boards());
    const w = await worldB({ slack, monday, key: false });
    await put(w.ctx, 'meta', 'brief-seen', { people: { ZZ: '2026-11-17T08:00:00Z', AL: '2026-11-16T08:00:00Z' } });
    await put(w.ctx, 'digest', 'live', { updated: '2026-11-22T10:00:00Z', open: [{ from: 'MJ', where: 'losjefes', since: '2026-11-21T08:00:00Z' }, { from: 'NF', where: 'loss-prevention', since: '2026-11-22T08:00:00Z' }] });
    const r = await runWeekBrief(w.deps);
    expect(r.card).toEqual({ id: 'work-brief-2026-11-23', created: true });
    const c = (await get(w.ctx, 'inbox', 'work-brief-2026-11-23')).data;
    expect(c).toMatchObject({ title: 'Work week brief w/c Mon 23 Nov', options: ['A: noted'], row: 'work', source: 'week-brief', answered: null, n: 1 });
    expect(c.details.map((d: any) => d.h)).toEqual(['Team week', 'Vacancies', 'Loss prevention']);
    const team = c.details[0].lines.join('\n');
    expect(team).toContain('Most active: AL 3, BC 1, CR 1');              // initials only
    expect(team).toContain('Silent all week: ZZ');
    expect(team).not.toContain('Silent all week: AL');             // seen before, silent now
    expect(team).toMatch(/Questions with no reply: 1 over a day old: recruitment-retail 1/);
    expect(team).toContain('Still open for Ronnie: 2, oldest: MJ in management channel');
    const all = JSON.stringify(c);
    expect(all).not.toMatch(/Ada|Lovelace|Ben Carter|Cleo|losjefes|Auror/i);
    expect(w.pushes).toHaveLength(1);
    expect(slack.posts).toEqual([]);                           // read-only
    expect((await get(w.ctx, 'meta', 'brief-seen')).data.people).toMatchObject({ AL: expect.any(String), BC: expect.any(String), CR: expect.any(String), ZZ: '2026-11-17T08:00:00Z' });
    const again = await runWeekBrief(w.deps);                  // a rerun on the same day makes no second card or push
    expect(again.card).toEqual({ id: 'work-brief-2026-11-23', created: false });
    expect(w.pushes).toHaveLength(1);
  });

  it('Sonnet adds themes and 1:1 topics; a line with a name is dropped; the model call is capped and uses the right model', async () => {
    const w = await worldB({ slack: slackWith(), monday: null, handlers: { team_week: () => ({
      items: [{ title: 'Rota agreed', text: 'The rota was agreed for 12 shops.', from_management: true }, { title: 'Advert owner', text: 'Emma was asked who owns the advert.', from_management: false }],
      one_to_ones: [{ who: 'MJ', topic: 'E-learning review dates' }, { who: 'NB', topic: 'Advert ownership' }] }) } });
    const r = await runWeekBrief(w.deps);
    const lines = r.parts.team.map((l) => l.text).join('\n');
    expect(lines).toContain('Rota agreed: The rota was agreed for 12 shops.');
    expect(lines).toContain('1:1 topic MJ: E-learning review dates');
    expect(lines).not.toContain('Emma');
    expect(w.llm).toEqual([{ tool: 'team_week', model: 'claude-sonnet-5-5' }]);
    expect((await get(w.ctx, 'meta', 'llm-usage')).data).toMatchObject({ sonnet: 1 });
  });

  it('with no model key, or a refused call, the deterministic lines stand', async () => {
    const a = await worldB({ slack: slackWith(), key: false });
    expect((await runWeekBrief(a.deps)).parts.team.length).toBeGreaterThan(1);
    expect(a.llm).toEqual([]);
    const b = await worldB({ slack: slackWith(), handlers: { team_week: 529 } });
    expect((await runWeekBrief(b.deps)).card?.created).toBe(true);
  });

  it('a channel that cannot be read, or a part that fails, is said on the card and the rest still arrives', async () => {
    const slack = fakeSlack({ names: { UA: 'Ada Lovelace' }, history: { C0101QQN8SY: [msg('UA', 1)] }, unreadable: { C06AQD5H5RT: 'not_in_channel', C0692KPGJUR: 'missing_scope' } });
    const w = await worldB({ slack, monday: fakeMonday(boards(), ['8247581349']), key: false });
    const r = await runWeekBrief(w.deps);
    const c = (await get(w.ctx, 'inbox', 'work-brief-2026-11-23')).data;
    expect(r.parts.team.map((l) => l.text).join('\n')).toContain('Channels not read: training-team (not_in_channel), management channel (missing_scope)');
    expect(c.details.find((d: any) => d.h === 'Not read').lines.join('\n')).toContain('loss prevention board: ComplexityException');
    expect(c.details.map((d: any) => d.h)).toContain('Vacancies');
  });

  it('with neither Slack nor monday.com configured the run fails loudly (recorded, so the health check sees it); both down still raises a card saying so', async () => {
    const w = await worldB({ slack: null, monday: null });
    expect(await runJob(w.deps, 'trig_weekbrief', 'background')).toMatchObject({ status: 'failed', error: 'integrations_not_configured' });
    expect((await get(w.ctx, '_trigger_runs', 'trig_weekbrief')).data).toMatchObject({ status: 'failed' });
    const down = await worldB({ slack: fakeSlack({ unreadable: Object.fromEntries(['C0101QQN8SY'].map((c) => [c, 'invalid_auth'])) }), monday: fakeMonday([], []), key: false });
    const r = await runWeekBrief(down.deps);
    expect(r.card?.created).toBe(true);
  });

  it('the job runner runs it as a background job, and a scheduled start is gated by the London hour', async () => {
    const w = await worldB({ slack: slackWith(), monday: fakeMonday(boards()), key: false });
    expect(await runJob(w.deps, 'trig_weekbrief', 'background')).toMatchObject({ status: 'ok', result: { card: 'work-brief-2026-11-23' } });
    const late = await worldB({ slack: slackWith(), monday: fakeMonday(boards()), key: false, start: new Date('2026-11-23T08:45:00Z') });
    expect(await runJob(late.deps, 'trig_weekbrief', 'schedule')).toMatchObject({ status: 'off_hour' });
  });
});
