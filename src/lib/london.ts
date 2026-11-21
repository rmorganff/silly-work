/**
 * Europe/London clock helpers. Netlify cron is UTC only, so a job that must run at a fixed London time all year is
 * scheduled on both UTC hours it could land on (one in GMT, one in BST) and each run checks the London time first,
 * exiting early on the off hour. Everything takes `now`, so tests are deterministic.
 */
const parts = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short',
});
const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export interface LondonTime { date: string; hour: number; minute: number; weekday: number }

export function londonTime(d: Date): LondonTime {
  const p = Object.fromEntries(parts.formatToParts(d).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute), weekday: DOW[p.weekday] };
}
export const londonHour = (d: Date): number => londonTime(d).hour;
export const londonDate = (d: Date): string => londonTime(d).date;
export const isLondonHour = (d: Date, hour: number): boolean => londonHour(d) === hour;

/** A job's London slot: one or more hours (0 to 23) and optionally days of the week (0 = Sunday). */
export interface LondonSlot { hour: number | number[]; weekday?: number | number[] }
export function inLondonSlot(d: Date, slot: LondonSlot): boolean {
  const t = londonTime(d);
  const has = (v: number | number[], x: number) => (Array.isArray(v) ? v.includes(x) : v === x);
  return has(slot.hour, t.hour) && (slot.weekday === undefined || has(slot.weekday, t.weekday));
}

const MS_DAY = 86_400_000;
const utcOf = (ymd: string) => { const [y, m, d] = ymd.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const ymdOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** The calendar date (YYYY-MM-DD) of the working day before `ymd`: Monday looks back to Friday, a weekend to Friday. */
export function previousWorkday(ymd: string): string {
  const dow = new Date(utcOf(ymd)).getUTCDay();
  const back = dow === 1 ? 3 : dow === 0 ? 2 : 1;
  return ymdOf(utcOf(ymd) - back * MS_DAY);
}
export const isWeekday = (ymd: string): boolean => { const d = new Date(utcOf(ymd)).getUTCDay(); return d >= 1 && d <= 5; };
/** "Fri 20 Nov" for a YYYY-MM-DD date. */
export function shortDay(ymd: string): string {
  const d = new Date(utcOf(ymd));
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]} ${d.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]}`;
}
