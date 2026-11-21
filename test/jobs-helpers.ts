import crypto from 'node:crypto';
import { makeCtx, db } from './helpers';
import type { JobDeps } from '../src/lib/jobs';

export const T0 = new Date('2026-11-23T09:30:00Z'); // a Monday, GMT

/** A throwaway board, a clock the test can move, and a recorder for pushes. */
export async function world(start: Date = T0) {
  const ctx = await makeCtx();
  const clock = { now: start };
  const pushes: { url: string }[] = [];
  const fetchImpl = (async (url: any) => { pushes.push({ url: String(url) }); return new Response('', { status: 200 }); }) as unknown as typeof fetch;
  const env = { WORK_NTFY_URL: 'https://ntfy.test/x', WORK_NTFY_KEY: crypto.randomBytes(32).toString('base64') };
  const deps: JobDeps = { ctx, now: () => clock.now, fetchImpl, env };
  const at = (iso: string) => { clock.now = new Date(iso); };
  const advance = (ms: number) => { clock.now = new Date(clock.now.getTime() + ms); };
  return { ctx, deps, clock, pushes, at, advance };
}

export const card = (id: string, n: number, over: Record<string, any> = {}) => ({
  id, n, title: 'Retail 5 open', text: 'Five vacancies are open.', options: ['A: ok', 'B: later'], source: 'work', row: 'work',
  created: '2026-11-20T08:00:00Z', answered: null, answer: null, actioned: null, ...over,
});

export async function put(ctx: any, collection: string, id: string, data: any, op: 'set' | 'add' = 'set') {
  const r = await db(ctx, { op, collection, doc_id: id, data });
  if (r.status !== 200) throw new Error(`seed ${collection}/${id}: ${r.status} ${JSON.stringify(r.body)}`);
}
export const get = async (ctx: any, collection: string, id: string) => (await db(ctx, { op: 'get', collection, doc_id: id })).body;
