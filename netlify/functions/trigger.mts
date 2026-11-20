import type { Config } from '@netlify/functions';
import { context } from '../../src/lib/runtime';
import { triggerStub } from '../../src/lib/trigger';
import { json } from '../../src/lib/auth';

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '86400',
};

/** POST /api/trigger {tool: 'fire_trigger'|'list_triggers', args}. Stub until the Stage 3 workers exist. */
export default async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed', code: 'method_not_allowed' }, CORS_HEADERS);
  const c = await context(req);
  if ('deny' in c) {
    const h = new Headers(c.deny.headers);
    for (const [k, v] of Object.entries(CORS_HEADERS)) h.set(k, v);
    return new Response(c.deny.body, { status: c.deny.status, headers: h });
  }
  const body: any = await req.json().catch(() => null);
  const out = triggerStub(body);
  return json(out.status, out.body, CORS_HEADERS);
};

export const config: Config = { path: '/api/trigger' };
