/**
 * The answered-card watcher for the Work Board. Looks for cards Ronnie answered that nobody is acting on, queues one task for
 * each and holds the card on it, so no answer is left lying. No model is called. It never changes `answered`, `answer`,
 * `actioned` or `options`, and it never writes to `rows`.
 *
 * Cards answered before the watcher's baseline (`meta/answer-watch.since`, set on its first run) are left alone: they belong to
 * whoever was acting on them before this job existed. They are counted, never touched.
 */
import type { StoreCtx } from './store';
import { getDoc, listDocs, putDoc, queryAnsweredOpen, writeDoc, isCode, type Doc } from './board';
import { raiseCard, pushCard, clip } from './cards';
import {
  ageMs, buildAttention, classifyAnswered, findStalls, isAnswered, isClosed, isoOf, parseTime,
  type AttentionItem, type Ctx,
} from './board-health';

export type WatchDeps = { ctx: StoreCtx; now: () => Date; fetchImpl: typeof fetch; env: Record<string, string | undefined> };
export type WatchResult = {
  baselined: boolean; handled: { id: string; did: string }[]; skipped: string[]; legacy: number; attention: AttentionItem[];
};

export const taskIdFor = (cardId: string) => `t-answer-${cardId}`;
const active = (t: any) => t?.status === 'queued' || t?.status === 'running';
const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '');

function taskBody(card: Doc, now: Date, withTitle: boolean) {
  const c = card.data, t = isoOf(now);
  const label = withTitle ? `: ${clip(c.title, 60)}` : '';
  return {
    title: `Act on answered card ${c.n ?? card.id}${label}`,
    // The answer's own words are not copied: the task points at the card, which is where they are.
    detail: `Card ${card.id} was answered ${c.answered}. Read the card and act on it, then set actioned.`,
    status: 'queued', source: 'answer-watch', card: card.id, row: c.row ?? null, needs_laptop: c.needs_laptop === true, created: t, updated: t, result: null,
  };
}

/** Queues the task and holds the card on it. Returns what was done, or null when the card changed under it. */
async function handleCard(ctx: StoreCtx, card: Doc, now: Date): Promise<string | null> {
  const taskId = taskIdFor(card.id);
  let created = true;
  for (const withTitle of [true, false]) {
    try { await writeDoc(ctx, { op: 'add', collection: 'tasks', id: taskId, data: taskBody(card, now, withTitle) }); break; }
    catch (e) {
      if (isCode(e, 'exists')) { created = false; break; }
      if (withTitle && isCode(e, 'scrub_rejected')) continue; // the card's title is not fit to copy: a plain title instead
      throw e;
    }
  }
  if (!created) {
    const t = await getDoc(ctx, 'tasks', taskId);
    if (t && !active(t.data)) return null; // finished, yet the card is still open: that is for a person (reported as overdue)
  }
  try {
    await writeDoc(ctx, { op: 'update', collection: 'inbox', id: card.id, ifVersion: card.version, data: { hold: { task: taskId }, watch_seen: isoOf(now) } });
  } catch (e) {
    if (isCode(e, 'version_conflict', 'not_found')) return null; // someone just changed the card: the next pass looks again
    throw e;
  }
  return created ? `queued task ${taskId}` : `held on task ${taskId}`;
}

const attentionText = (open: AttentionItem[]) => `${open.length} ${open.length === 1 ? 'thing needs' : 'things need'} a look: ${open.map((o) => `${o.kind} ${o.name}`).join('; ')}`.slice(0, 900);

/** Keeps the one "Runs needing attention" card in step with the list. Returns the card id to store. */
async function syncAttentionCard(deps: WatchDeps, existing: any, open: AttentionItem[], changed: boolean, now: Date): Promise<string | null> {
  const { ctx } = deps;
  const cur = existing?.card ? await getDoc(ctx, 'inbox', existing.card) : null;
  const isOpen = !!cur && !isClosed(cur.data);
  if (!open.length) {
    if (isOpen) await writeDoc(ctx, { op: 'update', collection: 'inbox', id: cur!.id, ifVersion: cur!.version, data: { actioned: isoOf(now), outcome: 'done' } }).catch((e) => { if (!isCode(e, 'version_conflict')) throw e; });
    return existing?.card ?? null;
  }
  if (isOpen) {
    if (changed) await writeDoc(ctx, { op: 'update', collection: 'inbox', id: cur!.id, ifVersion: cur!.version, data: { text: attentionText(open) } }).catch((e) => { if (!isCode(e, 'version_conflict', 'scrub_rejected')) throw e; });
    return cur!.id;
  }
  for (let i = 0; i < 6; i++) { // a card closed earlier today keeps its id; a new problem the same day gets the next suffix
    const id = `runs-attention-${ymd(now)}${i ? '-' + String.fromCharCode(97 + i) : ''}`;
    const text = attentionText(open);
    const r = await raiseCard(ctx, { id, title: 'Runs needing attention', text, options: ['ok', 'later'], source: 'answer-watch' }, now);
    if (!r.existed) {
      await pushCard({ id, n: r.n ?? undefined, title: r.title, text, options: r.options, kind: 'runs' }, deps.env, deps.fetchImpl);
      return id;
    }
    const have = await getDoc(ctx, 'inbox', id);
    if (have && !isClosed(have.data)) return id;
  }
  return null;
}

async function failedRuns(ctx: StoreCtx, now: Date): Promise<AttentionItem[]> {
  const out: AttentionItem[] = [];
  for (const r of await listDocs(ctx, '_trigger_runs', 200)) {
    if (r.data?.status !== 'failed' || !(ageMs(r.data.fired_at, now) <= 24 * 3600_000)) continue;
    const t = await getDoc(ctx, '_triggers', r.id);
    out.push({ id: `failed/${r.id}`, kind: 'failed', name: clip(t?.data?.name || r.id, 60), since: r.data.fired_at });
  }
  return out;
}

export async function runAnswerWatch(deps: WatchDeps): Promise<WatchResult> {
  const { ctx } = deps, now = deps.now();
  const answered = (await queryAnsweredOpen(ctx)).filter((d) => isAnswered(d.data) && !isClosed(d.data));

  const state = await getDoc(ctx, 'meta', 'answer-watch');
  if (!state) { // first run: draw the line at now; nothing before it is touched
    await putDoc(ctx, 'meta', 'answer-watch', { since: isoOf(now), checked_at: isoOf(now), legacy_open: answered.length, note: 'cards answered before `since` are never touched by the answer watcher' });
    return { baselined: true, handled: [], skipped: [], legacy: answered.length, attention: [] };
  }
  const since = parseTime(state.data.since);
  const fresh = answered.filter((d) => parseTime(d.data.answered) >= since);
  const legacy = answered.length - fresh.length;

  const tasks = new Map<string, any>();
  const taskDocs = await listDocs(ctx, 'tasks');
  for (const t of taskDocs) if (active(t.data)) tasks.set(t.id, t.data);
  const cards = new Map<string, any>(fresh.map((c) => [c.id, c.data]));
  for (const c of fresh) { // a card held on another card needs that card's state
    const ref = c.data?.hold?.card;
    if (typeof ref === 'string' && ref && !cards.has(ref)) { const o = await getDoc(ctx, 'inbox', ref); if (o) cards.set(ref, o.data); }
  }
  const cctx: Ctx = { tasks, cards };

  const handled: WatchResult['handled'] = [], skipped: string[] = [], found: AttentionItem[] = [];
  for (const card of fresh) {
    const cls = classifyAnswered(card.data, cctx, now);
    if (cls !== 'unowned' && cls !== 'overdue') { skipped.push(card.id); continue; }
    const did = await handleCard(ctx, card, now);
    if (did) handled.push({ id: card.id, did });
    else if (cls === 'overdue') found.push({ id: `card/${card.id}`, kind: 'overdue', name: clip(`card ${card.data.n ?? card.id}`, 60), since: card.data.answered });
    else skipped.push(card.id);
  }

  // Running tasks nothing has touched for 90 minutes are reported, never changed. (Running rows are the Work shift's to move.)
  for (const s of findStalls([], taskDocs.filter((t) => t.data?.status === 'running'), now)) found.push({ id: `task/${s.id}`, kind: 'stalled', name: clip(`task ${s.id}`, 60), since: s.since });
  found.push(...await failedRuns(ctx, now));

  const meta = await getDoc(ctx, 'meta', 'runs-attention');
  const next = buildAttention(meta?.data, found);
  const sig = (o: AttentionItem[]) => JSON.stringify(o.map((x) => [x.id, x.kind, x.name, x.since]));
  const changed = sig(next.open) !== sig(meta?.data?.open ?? []);
  if (changed) {
    next.card = await syncAttentionCard(deps, meta?.data, next.open, true, now);
    try { await putDoc(ctx, 'meta', 'runs-attention', next); } catch (e) { if (!isCode(e, 'version_conflict', 'exists')) throw e; }
  }

  // Written only when something moved, so a quiet pass leaves no trace on the board (the run record shows it ran).
  if (handled.length || legacy !== state.data.legacy_open) {
    await putDoc(ctx, 'meta', 'answer-watch', { ...state.data, checked_at: isoOf(now), legacy_open: legacy, last_handled: handled.length ? isoOf(now) : state.data.last_handled ?? null });
  }
  return { baselined: false, handled, skipped, legacy, attention: next.open };
}
