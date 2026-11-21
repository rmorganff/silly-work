import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CalendarError, MAX_BYTES, NOTE_TITLE, cleanLocation, cleanSummary, fetchIcs, formatItems, initialsIn, offItem, parseCalendarUrls, parseEvents, reduceNames, runCalendarFeed } from '../src/lib/ical-feed';
import { runJob } from '../src/lib/jobs';
import { smoke } from '../src/lib/smoke';
import { world, get, put } from './jobs-helpers';

const NOW = new Date('2026-11-21T10:00:00Z'); // a Saturday, GMT
const DAY = 86_400_000;
const W_URL = 'https://cal.example/private-WORK-TOKEN-xyz/basic.ics';
const H_URL = 'https://hol.example/private-HOLIDAY-TOKEN-abc/basic.ics';
const LONDON = ['BEGIN:VTIMEZONE', 'TZID:Europe/London', 'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0000', 'TZOFFSETTO:+0100', 'TZNAME:BST', 'DTSTART:19700329T010000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT', 'BEGIN:STANDARD', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0000', 'TZNAME:GMT', 'DTSTART:19701025T020000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD', 'END:VTIMEZONE'];
const cal = (...events: string[][]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...LONDON, ...events.flat(), 'END:VCALENDAR'].join('\r\n');
let n = 0;
const ev = (...lines: string[]) => ['BEGIN:VEVENT', `UID:e${++n}@test`, 'DTSTAMP:20260101T000000Z', ...lines, 'END:VEVENT'];
const WIN = (now = NOW) => [now, new Date(now.getTime() + 7 * DAY)] as const;
const fmt = (ics: string, now = NOW) => formatItems(parseEvents(ics, ...WIN(now)), now);
const off = (ics: string, now = NOW) => offItem(parseEvents(ics, ...WIN(now)), now);

function feed(map: Record<string, string | (() => Response)>) {
  const calls: string[] = [];
  const f = (async (url: any) => {
    calls.push(String(url));
    const v = map[String(url)];
    if (v === undefined) return new Response('nope', { status: 404 });
    return typeof v === 'string' ? new Response(v, { status: 200 }) : v();
  }) as unknown as typeof fetch;
  return { f, calls };
}

let logs: string[];
beforeEach(() => {
  n = 0; logs = [];
  for (const m of ['log', 'error', 'warn', 'info', 'debug'] as const) vi.spyOn(console, m).mockImplementation((...a: any[]) => { logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); });
});
afterEach(() => vi.restoreAllMocks());
const noSecretsLogged = () => { const all = logs.join('\n'); for (const s of ['WORK-TOKEN', 'HOLIDAY-TOKEN', 'cal.example', 'hol.example']) expect(all).not.toContain(s); };

describe('WORK_CAL_ICAL_URLS', () => {
  it('splits on commas or newlines, trims, drops empties; the first is Work, the second the holidays', () => {
    expect(parseCalendarUrls(' https://a.test/x , https://b.test/y ')).toEqual(['https://a.test/x', 'https://b.test/y']);
    expect(parseCalendarUrls('https://a.test/x\r\nhttps://b.test/y\n\n')).toEqual(['https://a.test/x', 'https://b.test/y']);
    expect(parseCalendarUrls('https://a.test/x,,')).toEqual(['https://a.test/x']);
    expect(parseCalendarUrls(undefined)).toEqual([]);
    expect(parseCalendarUrls('')).toEqual([]);
  });
});

describe('Work calendar items', () => {
  it('timed and all-day events; London time across the clock change; recurrence; cancelled skipped', () => {
    expect(fmt(cal(ev('DTSTART:20261125T113000Z', 'DTEND:20261125T120000Z', 'SUMMARY:Weekly check in', 'LOCATION:Head office')))).toEqual([{ title: 'Wed 25 Nov 11:30 · Weekly check in', text: 'Head office' }]);
    expect(fmt(cal(ev('DTSTART;VALUE=DATE:20261124', 'DTEND;VALUE=DATE:20261125', 'SUMMARY:Stocktake')))).toEqual([{ title: 'Tue 24 Nov · Stocktake', text: 'all day' }]);
    const OCT = new Date('2026-10-20T08:00:00Z');
    const t = fmt(cal(ev('DTSTART:20261022T140000Z', 'DTEND:20261022T150000Z', 'SUMMARY:BST'), ev('DTSTART:20261026T140000Z', 'DTEND:20261026T150000Z', 'SUMMARY:GMT')), OCT).map((i) => i.title);
    expect(t).toEqual(['Thu 22 Oct 15:00 · BST', 'Mon 26 Oct 14:00 · GMT']);
    const series = cal(ev('DTSTART;TZID=Europe/London:20261019T090000', 'DTEND;TZID=Europe/London:20261019T100000', 'RRULE:FREQ=DAILY', 'SUMMARY:Daily'));
    expect(fmt(series, new Date('2026-10-22T00:00:00Z')).every((i) => i.title.includes(' 09:00 · Daily'))).toBe(true);
    expect(fmt(cal(ev('DTSTART:20261125T113000Z', 'DTEND:20261125T120000Z', 'STATUS:CANCELLED', 'SUMMARY:Gone')))).toEqual([]);
  });

  it('at most 15 events, and only the next 7 days', () => {
    const many = Array.from({ length: 20 }, (_, i) => ev(`DTSTART:2026112${(i % 5) + 2}T${String(8 + (i % 8)).padStart(2, '0')}0000Z`, `DTEND:2026112${(i % 5) + 2}T${String(9 + (i % 8)).padStart(2, '0')}0000Z`, `SUMMARY:Meeting ${i}`));
    expect(fmt(cal(...many))).toHaveLength(15);
    expect(fmt(cal(ev('DTSTART:20261201T113000Z', 'DTEND:20261201T120000Z', 'SUMMARY:Later')))).toEqual([]);
  });
});

describe('what never reaches the board', () => {
  it('description, attendees, organiser, links and passcodes are never copied', () => {
    const ics = cal(ev('DTSTART:20261125T113000Z', 'DTEND:20261125T120000Z', 'SUMMARY:Review https://leak.example/summary-LEAK passcode 998877', 'LOCATION:Zoom https://leak.example/room', 'DESCRIPTION:SECRET-DESC passcode 998877 https://leak.example/desc', 'ATTENDEE;CN=Bob Leaker:mailto:bob@leak.example', 'ORGANIZER;CN=Olga Leaker:mailto:olga@leak.example', 'URL:https://leak.example/url', 'ATTACH:https://leak.example/attach'));
    const s = JSON.stringify(fmt(ics));
    for (const x of ['LEAK', 'leak.example', 'SECRET-DESC', '998877', 'Bob', 'Olga', 'mailto']) expect(s).not.toContain(x);
    expect(s).toContain('Review');
    expect(s).toContain('video call');
  });

  it('staff names become initials; titles about personal matters are not named; a line the scrubber would refuse is replaced', () => {
    expect(reduceNames('Lunch with Emma Smith and Barry')).toBe('Lunch with ES and B');
    expect(reduceNames('Call with Mr Jones')).toBe('Call with J');
    expect(cleanSummary('1:1 with Emma Smith')).toBe('1:1 with ES');
    expect(cleanSummary('Disciplinary hearing for AB')).toBe('(private)');
    expect(cleanSummary('Sickness absence review')).toBe('(private)');
    expect(cleanSummary('')).toBe('(no title)');
    expect(cleanSummary('x'.repeat(200)).length).toBeLessThanOrEqual(80);
    expect(cleanLocation('Cafe with Emma Smith')).toBe('Cafe with ES');
    expect(cleanLocation('Teams meeting')).toBe('video call');
  });
});

describe('Off this week (Training team holidays)', () => {
  it('names become initials, ranges follow the board’s wording, an exclusive all-day end is handled, one line per person', () => {
    const ics = cal(
      ev('DTSTART;VALUE=DATE:20261123', 'DTEND;VALUE=DATE:20261127', 'SUMMARY:AM holiday'),
      ev('DTSTART;VALUE=DATE:20261125', 'DTEND;VALUE=DATE:20261127', 'SUMMARY:Ada Lovelace - Annual Leave'),
      ev('DTSTART;VALUE=DATE:20261124', 'DTEND;VALUE=DATE:20261125', 'SUMMARY:NB off'),
      ev('DTSTART;VALUE=DATE:20261124', 'DTEND;VALUE=DATE:20261125', 'SUMMARY:Ben Carter, Cleo Reed off'),
      ev('DTSTART;VALUE=DATE:20261126', 'DTEND;VALUE=DATE:20261127', 'SUMMARY:AM half day'),
    );
    const o = off(ics);
    expect(o.title).toBe('Off this week');
    expect(o.text).toBe('AM 23–26 Nov, 26 Nov; BC 24 Nov; CR 24 Nov; NB 24 Nov; AL 25–26 Nov');
    expect(JSON.stringify(o)).not.toMatch(/Ada|Lovelace|Ben|Carter|Cleo|Reed/);
    expect(initialsIn('Ada Lovelace - annual leave')).toEqual(['AL']);
    expect(initialsIn('Training team: PTO')).toEqual([]);
    expect(initialsIn('AM holiday (Madeira)')).toEqual(['AM']);
  });
  it('a range spanning a month end, and nobody off', () => {
    expect(off(cal(ev('DTSTART;VALUE=DATE:20261130', 'DTEND;VALUE=DATE:20261203', 'SUMMARY:LL leave')), new Date('2026-11-28T10:00:00Z')).text).toBe('LL 30 Nov–2 Dec');
    expect(off(cal()).text).toBe('none listed');
  });
});

describe('fetching', () => {
  it('only https; redirects are followed a few times; a non-calendar page, a bad status and a too-big file are errors with a code', async () => {
    await expect(fetchIcs('http://x.test/a.ics', 'Work calendar', feed({}).f)).rejects.toMatchObject({ code: 'bad_ical_url' });
    const redir = (async (u: any) => String(u).endsWith('/a') ? new Response('', { status: 302, headers: { location: 'https://b.test/b.ics' } }) : new Response(cal(), { status: 200 })) as unknown as typeof fetch;
    expect(await fetchIcs('https://a.test/a', 'Work calendar', redir)).toContain('BEGIN:VCALENDAR');
    await expect(fetchIcs('https://a.test/a', 'L', feed({ 'https://a.test/a': 'hello' }).f)).rejects.toMatchObject({ code: 'not_ical' });
    await expect(fetchIcs('https://a.test/a', 'L', feed({}).f)).rejects.toMatchObject({ code: 'http_error' });
    const big = (async () => new Response('BEGIN:VCALENDAR' + 'x'.repeat(MAX_BYTES + 10), { status: 200 })) as unknown as typeof fetch;
    await expect(fetchIcs('https://a.test/a', 'L', big)).rejects.toMatchObject({ code: 'too_big' });
    expect(new CalendarError('http_error', 'L').message).toBe('L: http_error');
  });
});

describe('the daily run', () => {
  const urls = `${W_URL}, ${H_URL}`;
  const work = () => cal(ev('DTSTART:20261124T093000Z', 'DTEND:20261124T100000Z', 'SUMMARY:Team meeting', 'LOCATION:Head office'), ev('DTSTART:20261125T100000Z', 'DTEND:20261125T110000Z', 'SUMMARY:1:1 with Emma Smith'));
  const hol = () => cal(ev('DTSTART;VALUE=DATE:20261123', 'DTEND;VALUE=DATE:20261127', 'SUMMARY:AM holiday'));

  it('writes digest/calendar in the shape the board reads: {updated, items}, "Off this week" first, then the Work calendar', async () => {
    const w = await world(NOW);
    w.deps.env.WORK_CAL_ICAL_URLS = urls;
    w.deps.fetchImpl = feed({ [W_URL]: work(), [H_URL]: hol() }).f;
    const r = await runCalendarFeed(w.deps);
    expect(r).toEqual({ written: true, items: 3, failed: [] });
    const d = (await get(w.ctx, 'digest', 'calendar')).data;
    expect(Object.keys(d).sort()).toEqual(['items', 'updated']);
    expect(d.updated).toBe('2026-11-21T10:00:00.000Z');
    expect(d.items).toEqual([
      { title: 'Off this week', text: 'AM 23–26 Nov' },
      { title: 'Tue 24 Nov 09:30 · Team meeting', text: 'Head office' },
      { title: 'Wed 25 Nov 10:00 · 1:1 with ES', text: 'no location listed' },
    ]);
    expect(JSON.stringify(d)).not.toMatch(/Emma|Smith/);
    noSecretsLogged();
  });

  it('replaces the whole old document (its leftover fields go) and a rerun is safe', async () => {
    const w = await world(NOW);
    await put(w.ctx, 'digest', 'calendar', { items: [{ title: 'Off this week', text: 'old' }], updated: '2026-11-17 18:23:26', _relay_updated: 'x' });
    w.deps.env.WORK_CAL_ICAL_URLS = urls;
    w.deps.fetchImpl = feed({ [W_URL]: work(), [H_URL]: hol() }).f;
    await runCalendarFeed(w.deps);
    await runCalendarFeed(w.deps);
    const d = await get(w.ctx, 'digest', 'calendar');
    expect(Object.keys(d.data).sort()).toEqual(['items', 'updated']);
    expect(d.version).toBe(3);
  });

  it('if the Work calendar fails, the previous digest stays with "Calendar not read" in front; the note is not stacked on the next failure; a good run clears it', async () => {
    const w = await world(NOW);
    const prev = { updated: '2026-11-20T06:50:00.000Z', items: [{ title: 'Off this week', text: 'NB 24 Nov' }, { title: 'Fri 20 Nov 10:00 · Old meeting', text: 'Head office' }] };
    await put(w.ctx, 'digest', 'calendar', prev);
    w.deps.env.WORK_CAL_ICAL_URLS = urls;
    w.deps.fetchImpl = feed({ [W_URL]: () => new Response('no', { status: 500 }), [H_URL]: hol() }).f;
    expect(await runCalendarFeed(w.deps)).toEqual({ written: true, items: 3, failed: ['Work calendar'] });
    let d = (await get(w.ctx, 'digest', 'calendar')).data;
    expect(d.items[0]).toEqual({ title: NOTE_TITLE, text: 'Work calendar could not be read' });
    expect(d.items.slice(1)).toEqual(prev.items);
    expect(d.updated).toBe(prev.updated);
    await runCalendarFeed(w.deps);
    d = (await get(w.ctx, 'digest', 'calendar')).data;
    expect(d.items.filter((i: any) => i.title === NOTE_TITLE)).toHaveLength(1);
    w.deps.fetchImpl = feed({ [W_URL]: work(), [H_URL]: hol() }).f;
    await runCalendarFeed(w.deps);
    expect((await get(w.ctx, 'digest', 'calendar')).data.items.some((i: any) => i.title === NOTE_TITLE)).toBe(false);
    noSecretsLogged();
  });

  it('if only the holidays calendar fails, the Work events are fresh, the note says so, and no stale "Off this week" is kept', async () => {
    const w = await world(NOW);
    await put(w.ctx, 'digest', 'calendar', { updated: 'x', items: [{ title: 'Off this week', text: 'stale' }] });
    w.deps.env.WORK_CAL_ICAL_URLS = urls;
    w.deps.fetchImpl = feed({ [W_URL]: work() }).f; // the holidays address answers 404
    const r = await runCalendarFeed(w.deps);
    expect(r.failed).toEqual(['Training team holidays']);
    const d = (await get(w.ctx, 'digest', 'calendar')).data;
    expect(d.items.map((i: any) => i.title)).toEqual([NOTE_TITLE, 'Tue 24 Nov 09:30 · Team meeting', 'Wed 25 Nov 10:00 · 1:1 with ES']);
    expect(d.items[0].text).toBe('Training team holidays could not be read');
  });

  it('with one address only the Work calendar is read; with none the run does nothing', async () => {
    const w = await world(NOW);
    w.deps.env.WORK_CAL_ICAL_URLS = W_URL;
    w.deps.fetchImpl = feed({ [W_URL]: work() }).f;
    const r = await runCalendarFeed(w.deps);
    expect(r.failed).toEqual(['Training team holidays']);
    const w2 = await world(NOW);
    expect(await runCalendarFeed(w2.deps)).toEqual({ written: false, items: 0, failed: [], skipped: 'not_configured' });
    expect((await get(w2.ctx, 'digest', 'calendar')).exists).toBe(false);
  });

  it('a title the board refuses is replaced, not the whole digest', async () => {
    const w = await world(NOW);
    w.deps.env.WORK_CAL_ICAL_URLS = urls;
    w.deps.fetchImpl = feed({ [W_URL]: cal(ev('DTSTART:20261124T093000Z', 'DTEND:20261124T100000Z', 'SUMMARY:Catch up with Maxwell Zorn about the rota')), [H_URL]: hol() }).f;
    process.env.PII_NAME_DENYLIST = 'Maxwell,Zorn';
    try { await runCalendarFeed(w.deps); } finally { delete process.env.PII_NAME_DENYLIST; }
    const d = (await get(w.ctx, 'digest', 'calendar')).data;
    expect(d.items[1].title).toBe('Tue 24 Nov 09:30 · (meeting)');
  });

  it('runs as a scheduled job at 06:50 London in winter and summer, and not on the other UTC hour', async () => {
    const winter = await world(new Date('2026-11-23T06:50:00Z'));
    winter.deps.env.WORK_CAL_ICAL_URLS = urls;
    winter.deps.fetchImpl = feed({ [W_URL]: work(), [H_URL]: hol() }).f;
    expect(await runJob(winter.deps, 'trig_calendar', 'schedule')).toMatchObject({ status: 'ok', result: { written: true } });
    const winterOff = await world(new Date('2026-11-23T05:50:00Z'));
    expect(await runJob(winterOff.deps, 'trig_calendar', 'schedule')).toMatchObject({ status: 'off_hour' });
    const summer = await world(new Date('2026-07-10T05:50:00Z'));
    summer.deps.env.WORK_CAL_ICAL_URLS = urls;
    summer.deps.fetchImpl = feed({ [W_URL]: work(), [H_URL]: hol() }).f;
    expect(await runJob(summer.deps, 'trig_calendar', 'schedule')).toMatchObject({ status: 'ok' });
    expect(await runJob(await world(new Date('2026-07-10T06:50:00Z')).then((x) => x.deps), 'trig_calendar', 'schedule')).toMatchObject({ status: 'off_hour' });
  });
});

describe('/api/smoke: the two feeds', () => {
  it('answers booleans and counts only: never an address, a title or a name; a failing feed shows its error code', async () => {
    const f = feed({ [W_URL]: cal(ev('DTSTART:20261124T093000Z', 'DTEND:20261124T100000Z', 'SUMMARY:Secret meeting title with Emma Smith')), [H_URL]: cal(ev('DTSTART;VALUE=DATE:20261123', 'DTEND;VALUE=DATE:20261127', 'SUMMARY:AM holiday'), ev('DTSTART;VALUE=DATE:20261124', 'DTEND;VALUE=DATE:20261125', 'SUMMARY:NB off')) }).f;
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
    try {
      const out = await smoke({ WORK_CAL_ICAL_URLS: `${W_URL}\n${H_URL}` }, f);
      expect(out.calendar).toEqual({ configured: true, urls: 2, extra_urls_ignored: 0, feeds: [
        { label: 'Work calendar', fetched: true, parsed: true, events_next_7_days: 1 },
        { label: 'Training team holidays', fetched: true, parsed: true, events_next_7_days: 2, people_off_this_week: 2 },
      ], ok: true });
      expect(out.env.WORK_CAL_ICAL_URLS).toBe(true);
      const s = JSON.stringify(out);
      for (const x of ['cal.example', 'hol.example', 'WORK-TOKEN', 'HOLIDAY-TOKEN', 'Secret meeting', 'Emma', 'AM holiday']) expect(s).not.toContain(x);
      const bad = await smoke({ WORK_CAL_ICAL_URLS: `${W_URL},${H_URL},https://third.test/x` }, feed({ [W_URL]: 'not a calendar' }).f);
      expect(bad.calendar.feeds[0]).toEqual({ label: 'Work calendar', fetched: false, parsed: false, error: 'not_ical' });
      expect(bad.calendar.feeds[1]).toMatchObject({ fetched: false, error: 'http_error' });
      expect(bad.calendar).toMatchObject({ ok: false, extra_urls_ignored: 1 });
      expect((await smoke({}, f)).calendar).toMatchObject({ configured: false, urls: 0, feeds: [], ok: false });
    } finally { vi.useRealTimers(); }
  });
});
