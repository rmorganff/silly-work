/**
 * The Friday review. Two parts need no model:
 *  - step 2: act on last week's answered proposal and idea cards (A on an idea queues a task, B drops it, C drops it for later);
 *  - step 3: the week in numbers, as one "Work week review" card.
 * Then, with a model key and inside the daily cap, the steps that do (friday-llm.ts): kudos drafts and the weekly proposal.
 * It runs as a background job, Fridays 15:45 London.
 */
import type { StoreCtx } from './store';
import { getDoc, listDocs, putDoc, writeDoc, isCode, type Doc } from './board';
import { raiseCard, pushCard, clip } from './cards';
import { HOUR, ageMs, isoOf, parseTime, type Now } from './board-health';
import { londonTime, shortDay } from './london';
import { fridayLlm } from './friday-llm';

export type ReviewDeps = { ctx: StoreCtx; now: () => Date; fetchImpl: typeof fetch; env: Record<string, string | undefined> };
export type ReviewItem = { title: string; text: string };
const DAY = 24 * HOUR;
const within = (v: unknown, ms: number, now: Now) => ageMs(v, now) <= ms;

const isProposal = (c: any) => /^(Proposal|Idea):/.test(String(c?.title ?? '')) && (Array.isArray(c?.details) ? c.details : []).some((s: any) => /Friday review/.test(`${s?.text ?? ''}`) && String(s?.h ?? '') === 'Source');
const letterOf = (a: unknown) => String(a ?? '').trim().charAt(0).toUpperCase();

export type ProposalOutcome = { id: string; did: string };

/** Step 2. Returns what was done and what is left for Ronnie. */
export async function actOnProposals(ctx: StoreCtx, now: Date): Promise<{ done: ProposalOutcome[]; left: string[] }> {
  const done: ProposalOutcome[] = [], left: string[] = [];
  const cards = (await listDocs(ctx, 'inbox')).filter((c) => isProposal(c.data) && c.data.answered && !c.data.actioned);
  for (const card of cards) {
    const letter = letterOf(card.data.answer), idea = /^Idea:/.test(card.data.title);
    const ideaTitle = String(card.data.title).replace(/^Idea:\s*/, '');
    let outcome: string | null = null;
    if (letter === 'A' && idea) {
      const taskId = `idea-${card.id}`;
      await writeDoc(ctx, { op: 'add', collection: 'tasks', id: taskId, data: { title: clip(`${ideaTitle}`, 70), detail: clip(card.data.text, 400), source: 'Friday review', status: 'queued', created: isoOf(now), updated: isoOf(now), result: null } })
        .catch((e) => { if (!isCode(e, 'exists')) throw e; });
      await setIdeaStatus(ctx, ideaTitle, 'taken', 'queued as a task by the Friday review');
      outcome = 'done: queued as a task by the Friday review';
    } else if (letter === 'A') { left.push(card.id); continue; } // a routine or fix: Ronnie's or a chat's to do
    else if (letter === 'B') { if (idea) await setIdeaStatus(ctx, ideaTitle, 'dropped', 'dropped by the Friday review'); outcome = idea ? 'dropped: idea dropped' : 'dropped'; }
    else if (letter === 'C') outcome = 'dropped: later';
    else { left.push(card.id); continue; }
    try {
      await writeDoc(ctx, { op: 'update', collection: 'inbox', id: card.id, ifVersion: card.version, data: { actioned: isoOf(now), outcome } });
      done.push({ id: card.id, did: outcome });
    } catch (e) { if (!isCode(e, 'version_conflict', 'not_found')) throw e; }
  }
  return { done, left };
}

/** Changes only the status and note of one idea in `meta/ideas` (an array under `value`). A document the guard refuses is left as it is. */
async function setIdeaStatus(ctx: StoreCtx, title: string, status: string, note: string): Promise<void> {
  const cur = await getDoc(ctx, 'meta', 'ideas');
  const list: any[] | null = Array.isArray(cur?.data?.value) ? cur!.data.value : null;
  if (!cur || !list) return;
  const i = list.findIndex((x) => String(x?.title ?? '').trim() === title.trim());
  if (i < 0) return;
  const value = list.map((x, k) => (k === i ? { ...x, status, note } : x));
  try { await writeDoc(ctx, { op: 'update', collection: 'meta', id: 'ideas', data: { value }, ifVersion: cur.version }); }
  catch (e) { if (!isCode(e, 'version_conflict', 'scrub_rejected')) throw e; }
}

export interface WeekData { inbox: Doc[]; tasks: Doc[]; rows: Doc[]; ideas: any[]; triggers: Doc[]; runs: Doc[]; sweep: any; health: any }

/** Step 3. Up to 8 items {title (under 70), text (one sentence)}, from the data alone. */
export function weekItems(w: WeekData, now: Now): ReviewItem[] {
  const out: ReviewItem[] = [];
  const answered = w.inbox.filter((c) => c.data.answered && within(c.data.answered, 7 * DAY, now));
  const waits = answered.map((c) => (parseTime(c.data.answered) - parseTime(c.data.created)) / HOUR).filter((x) => Number.isFinite(x) && x >= 0);
  const avg = waits.length ? waits.reduce((a, b) => a + b, 0) / waits.length : null;
  out.push({ title: 'Cards answered this week', text: avg === null ? `${answered.length} answered.` : `${answered.length} answered, waiting ${avg.toFixed(1)} hours on average.` });

  const open = w.inbox.filter((c) => !c.data.answered && !c.data.actioned);
  const oldest = open.length ? Math.max(...open.map((c) => ageMs(c.data.created, now))) : 0;
  out.push({ title: 'Cards waiting for Ronnie', text: open.length ? `${open.length} unanswered, the oldest ${Number.isFinite(oldest) ? Math.floor(oldest / DAY) : '?'} days old.` : 'None unanswered.' });

  const done = w.tasks.filter((t) => t.data.status === 'done' && within(t.data.updated ?? t.data.done, 7 * DAY, now)).length;
  out.push({ title: 'Tasks', text: `${done} done this week, ${w.tasks.filter((t) => t.data.status === 'queued').length} still queued.` });

  const fresh = w.rows.filter((r) => within(r.data.updated, 7 * DAY, now)).length;
  out.push({ title: 'Project rows', text: `${fresh} updated in the last 7 days, ${w.rows.length - fresh} not.` });

  const filed = w.ideas.filter((i) => within(i?.created, 7 * DAY, now)).length;
  out.push({ title: 'Ideas filed this week', text: `${filed} filed, ${w.ideas.filter((i) => ['new', 'shortlisted'].includes(i?.status)).length} still new or shortlisted.` });

  const on = w.triggers.filter((t) => t.data.enabled !== false).length;
  const failed = w.runs.filter((r) => r.data.status === 'failed' && within(r.data.fired_at, 7 * DAY, now)).length;
  out.push({ title: 'Scheduled jobs on this site', text: `${on} enabled, ${w.triggers.length - on} off, ${failed} failed runs this week.` });

  const flags = Array.isArray(w.sweep?.flags) ? w.sweep.flags.length : null;
  if (flags !== null) out.push({ title: 'Sweep flags still open', text: `${flags} flagged by the last sweep.` });
  if (w.health?.status_line) out.push({ title: 'Latest health check', text: String(w.health.status_line).slice(0, 110) });
  return out.slice(0, 8).map((i) => ({ title: clip(i.title, 69), text: i.text }));
}

export async function runFridayReview(deps: ReviewDeps) {
  const { ctx } = deps, now = deps.now();
  const acted = await actOnProposals(ctx, now);
  const sweepDoc = (await getDoc(ctx, 'meta', 'sweep'))?.data ?? (await getDoc(ctx, 'meta', 'meta/sweep'))?.data ?? null;
  const ideasDoc = (await getDoc(ctx, 'meta', 'ideas'))?.data?.value;
  const w: WeekData = {
    inbox: await listDocs(ctx, 'inbox'), tasks: await listDocs(ctx, 'tasks'), rows: await listDocs(ctx, 'rows'), ideas: Array.isArray(ideasDoc) ? ideasDoc : [],
    triggers: await listDocs(ctx, '_triggers', 200), runs: await listDocs(ctx, '_trigger_runs', 500), sweep: sweepDoc, health: (await getDoc(ctx, 'audit', 'health-latest'))?.data ?? null,
  };
  const items = weekItems(w, now);
  const date = londonTime(now).date;
  const id = `work-week-review-${date}`;
  // One review a day: the routine's own card (same title) counts too.
  const already = w.inbox.some((c) => c.id === id || (/^Work week review/.test(String(c.data.title ?? '')) && londonTime(new Date(parseTime(c.data.created))).date === date));
  let card: { id: string; created: boolean } | null = null;
  if (!already && items.length) {
    const lines = items.map((i) => `${i.title}: ${i.text}`.slice(0, 110));
    const text = lines.slice(0, 3).join(' ').slice(0, 300);
    const r = await raiseCard(ctx, { id, title: `Work week review w-e ${shortDay(date)}`, text, options: ['noted'], source: 'friday-review', details: [{ h: 'The week', numbered: true, lines }] }, now);
    if (!r.existed) await pushCard({ id, n: r.n ?? undefined, title: r.title, text, options: r.options, kind: 'cards' }, deps.env, deps.fetchImpl);
    card = { id, created: !r.existed };
  }
  // The two steps that need a model (kudos drafts, the weekly proposal). Without a key or inside the cap they are simply skipped.
  const llm = await fridayLlm(deps, items);
  await putDoc(ctx, 'audit', 'friday-review-latest', { at: isoOf(now), date, proposals_done: acted.done.length, proposals_left: acted.left.length, card: card?.id ?? null, llm });
  return { acted, items, card, llm };
}
