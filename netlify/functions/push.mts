import type { Config } from '@netlify/functions';
import { context } from '../../src/lib/runtime';
import { sendPush, validateCard } from '../../src/lib/push';
import { scrubDoc, ScrubRejected } from '../../src/lib/scrub';
import { json } from '../../src/lib/auth';

/** POST /api/push  {card: {id, title, n, options, text, details, kind, silent, urgent, approve}}  -> sealed ntfy push, board W. */
export default async (req: Request) => {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed', code: 'method_not_allowed' });
  const c = await context(req);
  if ('deny' in c) return c.deny;
  const body: any = await req.json().catch(() => null);
  const bad = validateCard(body?.card);
  if (bad) return json(400, { error: bad, code: bad });
  try { scrubDoc('push', String(body.card.id), body.card); }
  catch (e) { if (e instanceof ScrubRejected) return json(422, { error: 'scrub_rejected', code: 'scrub_rejected', rule: e.rule }); throw e; }
  const r = await sendPush(body.card);
  return json(r.ok ? 200 : r.status, r.ok ? { ok: true } : { error: r.code, code: r.code });
};

export const config: Config = { path: '/api/push' };
