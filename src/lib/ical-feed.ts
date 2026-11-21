/**
 * The daily Work calendar feed (06:50 London): reads the two iCal addresses in WORK_CAL_ICAL_URLS (comma or newline separated:
 * the first is the main Work calendar, the second is the Training team holidays) and writes `digest/calendar` on the Work Board
 * as {updated, items: [{title, text}]}, the shape the board and the retail summary already read. No model is called.
 *
 *  - "Off this week": who is on holiday in the next 7 days, from the holidays calendar, as initials and dates
 *    ("AM 17–20 Nov; NB 19–20 Nov"). It is always the first item when the holidays calendar was read.
 *  - Then the next 7 days of the main calendar, at most 15 events: "Wed 25 Nov 11:30 · <title>" with where it is.
 *
 * Privacy: only an event's title, times and location are read. Descriptions, attendees, organisers, links and passcodes are never
 * copied. A person's name in a title or a holiday entry becomes initials; a title about conduct, health or other personal
 * circumstances becomes "(private)"; and every line is checked against the board's scrubber, so a line it would refuse is
 * replaced by a plainer one. The iCal addresses are secrets: nothing here ever puts one, or any text from a response, into an
 * error, a log or the output.
 */
import ICAL from 'ical.js';
import type { StoreCtx } from './store';
import { getDoc, writeDoc, isCode } from './board';
import { scrubDoc, FIRST_NAMES, TOPIC_CORE } from './scrub';

export const TZ = 'Europe/London';
export const MAX_ITEMS = 15;
export const MAX_BYTES = 5 * 1024 * 1024;
export const TIMEOUT_MS = 12_000;
export const MAX_REDIRECTS = 3;
export const NOTE_TITLE = 'Calendar not read';
export const OFF_TITLE = 'Off this week';
export const LABELS = { work: 'Work calendar', holidays: 'Training team holidays' } as const;
const DAY = 86_400_000;
const MAX_OCCURRENCES = 20_000;

export type DateOnly = { date: string }; // YYYY-MM-DD, a calendar day in London
export type Instance = { start: Date | DateOnly; end: Date | DateOnly; allDay: boolean; summary: string; location: string };
export type Item = { title: string; text: string };
export type FeedDeps = { ctx: StoreCtx; now: () => Date; fetchImpl: typeof fetch; env: Record<string, string | undefined> };
export type FeedResult = { written: boolean; items: number; failed: string[]; skipped?: string };

/** WORK_CAL_ICAL_URLS split on commas or newlines, trimmed, empties dropped. [0] is the main Work calendar, [1] the holidays. */
export function parseCalendarUrls(raw: string | undefined | null): string[] {
  return String(raw ?? '').split(/[,\r\n]+/).map((s) => s.trim()).filter(Boolean);
}

/** An error that carries only a code and the calendar's label, never a URL or any response text. */
export class CalendarError extends Error {
  code: string; label: string;
  constructor(code: string, label: string) { super(`${label}: ${code}`); this.name = 'CalendarError'; this.code = code; this.label = label; }
}

// ---- London time with Intl only ----
const fmtCache = new Map<string, Intl.DateTimeFormat>();
function parts(d: Date, tz: string) {
  let f = fmtCache.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }); fmtCache.set(tz, f); }
  const o: Record<string, number> = {};
  for (const p of f.formatToParts(d)) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return o;
}
const offsetAt = (ms: number, tz: string) => { const p = parts(new Date(ms), tz); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000; };
/** The instant at which the wall clock in `tz` reads the given fields. */
export function wallToDate(y: number, mo: number, d: number, h: number, mi: number, s: number, tz = TZ): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let t = guess - offsetAt(guess, tz);
  const o2 = offsetAt(t, tz);
  if (guess - o2 !== t) t = guess - o2;
  return new Date(t);
}
const pad = (n: number) => String(n).padStart(2, '0');
const dateStr = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const isDateOnly = (v: any): v is DateOnly => v != null && typeof v === 'object' && typeof v.date === 'string';
/** The instant an event edge sits at: a Date as it is, a calendar day as London midnight. */
export function instant(v: Date | DateOnly): number {
  if (!isDateOnly(v)) return v.getTime();
  const [y, m, d] = v.date.split('-').map(Number);
  return wallToDate(y, m, d, 0, 0, 0).getTime();
}

// ---- parsing ----
function timeToEdge(t: any): Date | DateOnly {
  if (t.isDate) return { date: dateStr(t.year, t.month, t.day) };
  const tzid = t.zone?.tzid;
  if (tzid === 'UTC' || tzid === 'Z') return new Date(Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second));
  if (!t.zone || tzid === 'floating') return wallToDate(t.year, t.month, t.day, t.hour, t.minute, t.second); // floating: London local
  return t.toJSDate();
}
const statusOf = (ev: any): string => String(ev.component.getFirstPropertyValue('status') ?? '').toUpperCase();

/** Every instance of every event that has not ended by `windowStart` and starts before `windowEnd`, recurrences expanded. */
export function parseEvents(icsText: string, windowStart: Date, windowEnd: Date): Instance[] {
  const root = new ICAL.Component(ICAL.parse(icsText));
  const vevents = root.getAllSubcomponents('vevent');
  const byUid = new Map<string, { master: any | null; overrides: any[] }>();
  let anon = 0;
  for (const c of vevents) {
    const ev = new ICAL.Event(c);
    const uid = ev.uid || `anon-${anon++}`;
    let g = byUid.get(uid);
    if (!g) { g = { master: null, overrides: [] }; byUid.set(uid, g); }
    if (c.hasProperty('recurrence-id')) g.overrides.push(ev); else if (!g.master) g.master = ev; else g.overrides.push(ev);
  }
  const out: Instance[] = [];
  const ws = windowStart.getTime(), we = windowEnd.getTime();
  const take = (item: any, start: any, end: any) => {
    if (statusOf(item) === 'CANCELLED') return;
    const s = timeToEdge(start);
    let e = timeToEdge(end);
    if (instant(e) < instant(s)) e = s;
    const si = instant(s), ei = instant(e);
    if (si >= we) return;
    if (!(ei > ws || (ei === si && si >= ws))) return;
    out.push({ start: s, end: e, allDay: !!start.isDate, summary: String(item.summary ?? ''), location: String(item.location ?? '') });
  };
  for (const g of byUid.values()) {
    if (!g.master) { for (const o of g.overrides) take(o, o.startDate, o.endDate); continue; } // an override whose master is not in the file stands alone
    const m = g.master;
    if (statusOf(m) === 'CANCELLED') continue;
    for (const o of g.overrides) m.relateException(o);
    if (!m.isRecurring()) { take(m, m.startDate, m.endDate); continue; }
    const it = m.iterator();
    for (let n = 0, next = it.next(); next && n < MAX_OCCURRENCES; n++, next = it.next()) {
      const d = m.getOccurrenceDetails(next);
      if (instant(timeToEdge(d.startDate)) >= we && !d.item.isRecurrenceException?.()) break; // past the window: later ones start later still
      take(d.item, d.startDate, d.endDate);
    }
  }
  return out;
}

// ---- formatting ----
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const URL_RE = /(?:https?:\/\/|www\.)\S*/gi;
const VIDEO_RE = /https?:\/\/|www\.|\b(?:zoom|teams|meet\.google|webex|hangouts)\b/i;
const SECRET_RE = /(?:pass\s?code|password|passwd|meeting\s*id|dial[- ]?in|\bpin\b)\W{0,3}[\w-]*|\d[\d\s-]{4,}\d|\d{6,}/gi;
const HONORIFIC_RE = /\b(?:Mr|Mrs|Ms|Miss|Mx|Dr)\.?\s+([A-Z])[A-Za-z'’-]*/g;
const WORD_RE = /[A-Z][a-z'’-]{2,}/;

function cutAtWord(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,;:·-]+$/, '') + '…';
}

/** Would the board's scrubber accept this line? */
export function lineOk(line: string): boolean {
  try { scrubDoc('digest', 'calendar', { text: line }); return true; } catch { return false; }
}

/** A known first name (and a following capitalised surname) becomes initials; "Mr Smith" becomes "S". Nothing else is changed. */
export function reduceNames(text: string): string {
  const t = text.replace(HONORIFIC_RE, (_m, i: string) => i);
  return t.replace(/\b([A-Z][a-z]{2,})(?:\s+([A-Z][a-z'’-]{2,}))?\b/g, (m, first: string, second?: string) => {
    if (!FIRST_NAMES.has(first)) return m;
    return second ? first[0] + second[0] : first[0];
  });
}

/** A meeting title for the board: links and codes out, names as initials, personal matters not named, and always acceptable to the scrubber. */
export function cleanSummary(raw: string): string {
  let s = String(raw ?? '').replace(URL_RE, '').replace(SECRET_RE, '').replace(/\s+/g, ' ').trim();
  if (!s) return '(no title)';
  if (TOPIC_CORE.test(s)) return '(private)';
  s = cutAtWord(reduceNames(s), 80);
  return lineOk(s) ? s : '(meeting)';
}
export function cleanLocation(raw: string): string {
  const loc = String(raw ?? '').trim();
  if (!loc) return 'no location listed';
  if (VIDEO_RE.test(loc)) return 'video call';
  const first = loc.split(/\r?\n|\\n/)[0].replace(SECRET_RE, '').replace(/\s+/g, ' ').replace(/^[\s,;:-]+|[\s,;:-]+$/g, '');
  if (!first) return 'no location listed';
  const out = reduceNames(first.slice(0, 60).trim());
  return lineOk(out) ? out : 'no location listed';
}

export function formatItems(events: Instance[], now: Date): Item[] {
  const ws = now.getTime(), we = ws + 7 * DAY;
  return events
    .filter((e) => { const s = instant(e.start), en = instant(e.end); return s < we && (en > ws || (en === s && s >= ws)); })
    .sort((a, b) => instant(a.start) - instant(b.start) || Number(b.allDay) - Number(a.allDay) || a.summary.localeCompare(b.summary))
    .slice(0, MAX_ITEMS)
    .map((e) => {
      let y: number, m: number, d: number, hh = 0, mm = 0;
      if (isDateOnly(e.start)) [y, m, d] = e.start.date.split('-').map(Number);
      else { const p = parts(e.start, TZ); y = p.year; m = p.month; d = p.day; hh = p.hour; mm = p.minute; }
      const day = `${DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${MON[m - 1]}`;
      const sum = cleanSummary(e.summary);
      return e.allDay ? { title: `${day} · ${sum}`, text: 'all day' } : { title: `${day} ${pad(hh)}:${pad(mm)} · ${sum}`, text: cleanLocation(e.location) };
    });
}

// ---- "Off this week" ----
const NOISE = new Set(['annual', 'leave', 'holiday', 'holidays', 'off', 'ooo', 'out', 'of', 'office', 'pto', 'toil', 'day', 'days', 'half', 'am', 'pm', 'bank', 'vacation', 'training', 'team', 'a', 'l', 'on', 'is', 'away', 'and', 'the', 'working', 'from', 'home', 'wfh']);

const FLAGS = new Set(['PTO', 'OOO', 'TOIL', 'WFH']);
/** The initials of the people named in one holiday entry ("Ada Lovelace - annual leave" -> AL; "AM holiday" -> AM; "Ada L, Ben C off" -> AL, BC). */
export function initialsIn(summary: string): string[] {
  const cleaned = String(summary ?? '').replace(URL_RE, '').replace(/\([^)]*\)/g, ' ');
  const chunks = cleaned.split(/\s*(?:,|&|\band\b|\/|;|\+)\s*/i);
  const out: string[] = [];
  for (const chunk of chunks) {
    const words = chunk.split(/[^A-Za-z'’]+/).filter(Boolean).filter((w) => (/^[A-Z]{2,3}$/.test(w) ? !FLAGS.has(w) : !NOISE.has(w.toLowerCase())));
    const caps = words.filter((w) => /^[A-Z]{2,3}$/.test(w));
    if (caps.length) { out.push(...caps); continue; }
    const names = words.filter((w) => /^[A-Z][a-z'’-]+$/.test(w));
    if (names.length >= 2) out.push((names[0][0] + names[names.length - 1][0]).toUpperCase());
    else if (names.length === 1) out.push(names[0][0].toUpperCase());
  }
  return [...new Set(out)];
}

const dayParts = (e: Date | DateOnly, minusOneDay = false): { y: number; m: number; d: number } => {
  let y: number, m: number, d: number;
  if (isDateOnly(e)) [y, m, d] = e.date.split('-').map(Number);
  else { const p = parts(e, TZ); y = p.year; m = p.month; d = p.day; }
  if (minusOneDay) { const t = new Date(Date.UTC(y, m - 1, d) - DAY); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }; }
  return { y, m, d };
};
export function rangeText(e: Instance): string {
  const s = dayParts(e.start), en = dayParts(e.end, e.allDay && instant(e.end) > instant(e.start));
  const last = Date.UTC(en.y, en.m - 1, en.d) < Date.UTC(s.y, s.m - 1, s.d) ? s : en;
  if (s.y === last.y && s.m === last.m && s.d === last.d) return `${s.d} ${MON[s.m - 1]}`;
  return s.m === last.m && s.y === last.y ? `${s.d}–${last.d} ${MON[s.m - 1]}` : `${s.d} ${MON[s.m - 1]}–${last.d} ${MON[last.m - 1]}`;
}

/** The "Off this week" item, or null if nobody is listed. Initials and dates only. */
export function offItem(events: Instance[], now: Date): Item {
  const ws = now.getTime(), we = ws + 7 * DAY;
  const by = new Map<string, { first: number; ranges: string[] }>();
  for (const e of events.filter((x) => { const s = instant(x.start), en = instant(x.end); return s < we && (en > ws || (en === s && s >= ws)); }).sort((a, b) => instant(a.start) - instant(b.start))) {
    for (const who of initialsIn(e.summary)) {
      const g = by.get(who) ?? { first: instant(e.start), ranges: [] };
      const r = rangeText(e);
      if (!g.ranges.includes(r)) g.ranges.push(r);
      by.set(who, g);
    }
  }
  const text = [...by].sort((a, b) => a[1].first - b[1].first || a[0].localeCompare(b[0])).slice(0, 12).map(([who, g]) => `${who} ${g.ranges.join(', ')}`).join('; ');
  const line = text || 'none listed';
  return { title: OFF_TITLE, text: lineOk(line) ? line : 'see the holidays calendar' };
}

// ---- fetching ----
export function normaliseUrl(raw: string, label: string): string {
  let u = String(raw ?? '').trim();
  if (/^webcal:\/\//i.test(u)) u = 'https://' + u.slice('webcal://'.length);
  let parsed: URL;
  try { parsed = new URL(u); } catch { throw new CalendarError('bad_ical_url', label); }
  if (parsed.protocol !== 'https:') throw new CalendarError('bad_ical_url', label);
  return parsed.toString();
}

async function readCapped(res: Response, label: string): Promise<string> {
  const len = Number(res.headers.get('content-length'));
  if (Number.isFinite(len) && len > MAX_BYTES) throw new CalendarError('too_big', label);
  if (!res.body) {
    const t = await res.text();
    if (new TextEncoder().encode(t).length > MAX_BYTES) throw new CalendarError('too_big', label);
    return t;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) { try { await reader.cancel(); } catch { /* closed */ } throw new CalendarError('too_big', label); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function fetchIcs(url: string, label: string, fetchImpl: typeof fetch = fetch, opts: { timeoutMs?: number } = {}): Promise<string> {
  let cur = normaliseUrl(url, label);
  const signal = AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS);
  try {
    for (let hop = 0; ; hop++) {
      let res: Response;
      try { res = await fetchImpl(cur, { redirect: 'manual', signal, headers: { accept: 'text/calendar, text/plain, */*' } }); }
      catch (e: any) { throw new CalendarError(signal.aborted || e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout' : 'fetch_failed', label); }
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        if (hop >= MAX_REDIRECTS) throw new CalendarError('too_many_redirects', label);
        try { cur = normaliseUrl(new URL(res.headers.get('location')!, cur).toString(), label); }
        catch { throw new CalendarError('bad_ical_url', label); }
        try { await res.body?.cancel(); } catch { /* nothing to cancel */ }
        continue;
      }
      if (!res.ok) throw new CalendarError('http_error', label);
      let text: string;
      try { text = await readCapped(res, label); }
      catch (e) { if (e instanceof CalendarError) throw e; throw new CalendarError(signal.aborted ? 'timeout' : 'fetch_failed', label); }
      text = text.replace(/^﻿/, '').trim();
      if (!/^BEGIN:VCALENDAR/i.test(text)) throw new CalendarError('not_ical', label);
      return text;
    }
  } catch (e) {
    if (e instanceof CalendarError) throw e;
    throw new CalendarError('fetch_failed', label);
  }
}

// ---- the run ----
const joinLabels = (xs: string[]) => xs.join(' and ');

/** Fetches and parses one calendar. Returns the events, or the error code (never a URL or response text). */
export async function readCalendar(url: string, label: string, fetchImpl: typeof fetch, from: Date, to: Date): Promise<{ events: Instance[] } | { error: string }> {
  try {
    const text = await fetchIcs(url, label, fetchImpl);
    try { return { events: parseEvents(text, from, to) }; } catch { throw new CalendarError('parse_failed', label); }
  } catch (e: any) { return { error: e instanceof CalendarError ? e.code : 'error' }; }
}

export async function runCalendarFeed(deps: FeedDeps): Promise<FeedResult> {
  const { ctx, now, fetchImpl, env } = deps;
  const urls = parseCalendarUrls(env.WORK_CAL_ICAL_URLS);
  if (!urls.length) return { written: false, items: 0, failed: [], skipped: 'not_configured' };
  const t = now();
  const windowEnd = new Date(t.getTime() + 7 * DAY);

  // both calendars are fetched at once, so the run stays well inside a scheduled function's 30 seconds
  const [work, hol] = await Promise.all([
    readCalendar(urls[0], LABELS.work, fetchImpl, t, windowEnd),
    urls[1] ? readCalendar(urls[1], LABELS.holidays, fetchImpl, t, windowEnd) : Promise.resolve({ error: 'not_configured' } as const),
  ]);
  const failed: string[] = [];
  if ('error' in work) { failed.push(LABELS.work); console.error('calendar-feed', LABELS.work, work.error); }
  if ('error' in hol) { failed.push(LABELS.holidays); console.error('calendar-feed', LABELS.holidays, hol.error); }

  const note: Item[] = failed.length ? [{ title: NOTE_TITLE, text: `${joinLabels(failed)} could not be read` }] : [];
  const build = (prev: any): { updated: string; items: Item[] } => {
    if ('error' in work) { // the main calendar failed: the previous digest stays, with the note in front
      const kept: Item[] = Array.isArray(prev?.items) ? prev.items.filter((i: any) => i && i.title !== NOTE_TITLE) : [];
      return { updated: typeof prev?.updated === 'string' ? prev.updated : t.toISOString(), items: [...note, ...kept] };
    }
    return { updated: t.toISOString(), items: [...note, ...('events' in hol ? [offItem(hol.events, t)] : []), ...formatItems(work.events, t)] };
  };

  for (let attempt = 0; ; attempt++) {
    const cur = await getDoc(ctx, 'digest', 'calendar');
    const data = build(cur?.data);
    try {
      await writeDoc(ctx, cur ? { op: 'set', collection: 'digest', id: 'calendar', data, ifVersion: cur.version } : { op: 'add', collection: 'digest', id: 'calendar', data });
      return { written: true, items: data.items.length, failed };
    } catch (e) {
      if (isCode(e, 'scrub_rejected') && attempt === 0) { // one more try with the event titles left out, so the digest is never stale
        const plain = { ...data, items: data.items.map((i) => (i.title === NOTE_TITLE || i.title === OFF_TITLE ? i : { title: i.title.split(' · ')[0], text: 'see the calendar' })) };
        await writeDoc(ctx, cur ? { op: 'set', collection: 'digest', id: 'calendar', data: plain, ifVersion: cur.version } : { op: 'add', collection: 'digest', id: 'calendar', data: plain });
        return { written: true, items: plain.items.length, failed };
      }
      if (!isCode(e, 'version_conflict', 'exists') || attempt >= 1) throw e;
    }
  }
}
