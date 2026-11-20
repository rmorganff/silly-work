import type { Config } from '@netlify/functions';
import { context } from '../../src/lib/runtime';
import { handleDb } from '../../src/lib/store';
import { json } from '../../src/lib/auth';

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '86400',
};

/** POST /api/db  {op: get|list|set|update|add|delete|changes, collection, doc_id, data, ifVersion, silly_wid, since_seq}
 *  GET  /api/db?since_seq=N[&collection=c]  is the same as {op:'changes'}. */
export default async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  const c = await context(req);
  if ('deny' in c) {
    const h = new Headers(c.deny.headers);
    for (const [k, v] of Object.entries(CORS_HEADERS)) h.set(k, v);
    return new Response(c.deny.body, { status: c.deny.status, headers: h });
  }
  let body: any;
  if (req.method === 'GET') {
    const u = new URL(req.url);
    if (!u.searchParams.has('since_seq')) return json(400, { error: 'bad_request', code: 'bad_request' }, CORS_HEADERS);
    body = { op: 'changes', since_seq: Number(u.searchParams.get('since_seq')), collection: u.searchParams.get('collection') ?? undefined };
  } else if (req.method === 'POST') {
    body = await req.json().catch(() => null);
  } else return json(405, { error: 'method_not_allowed', code: 'method_not_allowed' }, CORS_HEADERS);
  const out = await handleDb(c.ctx, body);
  return json(out.status, out.body, CORS_HEADERS);
};

export const config: Config = { path: '/api/db' };
