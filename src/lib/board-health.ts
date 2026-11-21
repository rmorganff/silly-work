/**
 * Pure rules for the board jobs (answer watch, health check, Friday review). Nothing here reads a database or the clock:
 * every function is handed `now`. The rules copy Silly's own (what counts as answered, held or owned by a chat), so a card
 * is never reported that Silly itself shows as looked after. Same rules as silly-personal's board-health.ts.
 */
export const HOUR = 3600_000;
export const OVERDUE_MS = 2 * HOUR;
export const DOING_MS = 2 * HOUR;
export const STALL_MS = 90 * 60_000;

export type Now = Date | number;
export const nowMs = (n: Now): number => (typeof n === 'number' ? n : n.getTime());

/** Board times arrive as ISO ("2026-11-20T16:14:13Z") or as "2026-11-20 16:14:13" (UTC). */
export function parseTime(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return NaN;
  const s = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(v) ? v.replace(' ', 'T') + (/[zZ]|[+-]\d{2}:?\d{2}$/.test(v) ? '' : 'Z') : v;
  return new Date(s).getTime();
}
/** Age of a timestamp in ms; a missing or unreadable time counts as infinitely old. */
export const ageMs = (v: unknown, now: Now): number => { const t = parseTime(v); return Number.isNaN(t) ? Infinity : nowMs(now) - t; };
export const isoOf = (n: Now): string => new Date(nowMs(n)).toISOString().replace(/\.\d{3}Z$/, 'Z');

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "21 Nov 10:00" in UTC, the wording the board's flags use. */
export function fmtWhen(v: unknown): string {
  const t = parseTime(v);
  if (Number.isNaN(t)) return 'an unknown time';
  const d = new Date(t), p = (x: number) => String(x).padStart(2, '0');
  return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export const isAnswered = (card: any): boolean => !!card?.answered;
export const isClosed = (card: any): boolean => !!card?.actioned;
export const workedNow = (card: any, now: Now): boolean => card?.state === 'doing' && ageMs(card?.state_at, now) < DOING_MS;

export type Ctx = { tasks: Map<string, any>; cards: Map<string, any> };
export type Hold = { kind: 'task' | 'card' | 'until' | 'remind'; ref: string };

/** What a card is waiting on, by Silly's rules. A name in `waiting_on` covers nothing. */
export function holdOf(card: any, ctx: Ctx, now: Now): Hold | null {
  const h = card?.hold;
  if (h && typeof h === 'object') {
    if (typeof h.task === 'string' && h.task) {
      const st = ctx.tasks.get(h.task)?.status;
      if (st === 'queued' || st === 'running') return { kind: 'task', ref: h.task };
    }
    if (typeof h.card === 'string' && h.card) {
      const other = ctx.cards.get(h.card);
      if (other && !other.answered && !other.withdrawn) return { kind: 'card', ref: h.card };
    }
    if (h.until && parseTime(h.until) > nowMs(now)) return { kind: 'until', ref: String(h.until) };
  }
  if (typeof card?.remind_on === 'string' && card.remind_on.slice(0, 10) > new Date(nowMs(now)).toISOString().slice(0, 10)) return { kind: 'remind', ref: card.remind_on };
  return null;
}

/** Its own chat was woken: the card links a Claude session, or carries a wake id, with no relay error, and the answer is fresh. */
export function isChatOwned(card: any, now: Now): boolean {
  const linked = (typeof card?.link === 'string' && /^https:\/\/claude\.ai\/code\/session_/.test(card.link)) || !!card?.wake_id;
  return linked && !card?.relay_error && ageMs(card?.answered, now) < OVERDUE_MS;
}

export type Class = 'closed' | 'doing' | 'held' | 'chat-owned' | 'overdue' | 'unowned';
/** For an answered card. A card that is not answered has nothing waiting on it, so it reads as 'closed'. */
export function classifyAnswered(card: any, ctx: Ctx, now: Now): Class {
  if (!isAnswered(card) || isClosed(card)) return 'closed';
  if (workedNow(card, now)) return 'doing';
  if (holdOf(card, ctx, now)) return 'held';
  if (isChatOwned(card, now)) return 'chat-owned';
  return ageMs(card.answered, now) >= OVERDUE_MS ? 'overdue' : 'unowned';
}

export type Item = { id: string; data: any };
export type Stall = { id: string; kind: 'row' | 'task'; outcome: 'idle' | 'blocked'; where: string; since: string };
const newestOf = (d: any): number => Math.max(...[d?.updated, d?.heartbeat].map(parseTime).filter((x) => !Number.isNaN(x)), -Infinity);

/** Running rows and tasks nothing has touched for 90 minutes. Waiting on a future wake is idle; anything else has stopped. */
export function findStalls(rows: Item[], tasks: Item[], now: Now): Stall[] {
  const out: Stall[] = [];
  const one = (kind: 'row' | 'task', x: Item) => {
    const d = x.data;
    if (d?.status !== 'running') return;
    const t = newestOf(d);
    if (!Number.isFinite(t) || !(nowMs(now) - t > STALL_MS)) return; // no time at all is not a stall we can date
    const wake = [d.next_wake, d.eta].map(parseTime).filter((w) => !Number.isNaN(w) && w > nowMs(now)).sort((a, b) => a - b)[0];
    const old = typeof d.where === 'string' && d.where ? `: ${d.where}` : '';
    const since = isoOf(t);
    if (wake !== undefined) out.push({ id: x.id, kind, outcome: 'idle', where: `waiting until ${fmtWhen(wake)}${old}`, since });
    else out.push({ id: x.id, kind, outcome: 'blocked', where: `stopped since ${fmtWhen(t)}${old}`, since });
  };
  for (const r of rows) one('row', r);
  for (const t of tasks) one('task', t);
  return out;
}

export type AttentionKind = 'stalled' | 'failed' | 'overdue';
export type AttentionItem = { id: string; kind: AttentionKind; name: string; since: string };
/** Merge what was found this pass into the stored list: gone entries drop, kept entries keep their first `since`. */
export function buildAttention(existing: any, found: AttentionItem[]): { card: string | null; open: AttentionItem[] } {
  const before = new Map<string, AttentionItem>((Array.isArray(existing?.open) ? existing.open : []).map((x: AttentionItem) => [x.id, x]));
  const seen = new Set<string>();
  const open: AttentionItem[] = [];
  for (const f of found) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    open.push({ id: f.id, kind: f.kind, name: f.name, since: before.get(f.id)?.since ?? f.since });
  }
  return { card: existing?.card ?? null, open };
}
