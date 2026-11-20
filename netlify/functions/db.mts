import type { Config } from '@netlify/functions';
import { context } from '../../src/lib/runtime';
import { handleDb } from '../../src/lib/store';
import { json } from '../../src/lib/auth';

/** POST /api/db  {op: get|list|set|update|add|delete|changes, collection, doc_id, data, ifVersion, silly_wid, since_seq}
 *  GET  /api/db?since_seq=N[&collection=c]  is the same as {op:'changes'}. */
export default async (req: Request) => {
  const c = await context(req);
  if ('deny' in c) return c.deny;
  let body: any;
  if (req.method === 'GET') {
    const u = new URL(req.url);
    if (!u.searchParams.has('since_seq')) return json(400, { error: 'bad_request', code: 'bad_request' });
    body = { op: 'changes', since_seq: Number(u.searchParams.get('since_seq')), collection: u.searchParams.get('collection') ?? undefined };
  } else if (req.method === 'POST') {
    body = await req.json().catch(() => null);
  } else return json(405, { error: 'method_not_allowed', code: 'method_not_allowed' });
  const out = await handleDb(c.ctx, body);
  return json(out.status, out.body);
};

export const config: Config = { path: '/api/db' };
