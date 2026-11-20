import type { Config } from '@netlify/functions';
import { context } from '../../src/lib/runtime';
import { triggerStub } from '../../src/lib/trigger';
import { json } from '../../src/lib/auth';

/** POST /api/trigger {tool: 'fire_trigger'|'list_triggers', args}. Stub until the Stage 3 workers exist. */
export default async (req: Request) => {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed', code: 'method_not_allowed' });
  const c = await context(req);
  if ('deny' in c) return c.deny;
  const body: any = await req.json().catch(() => null);
  const out = triggerStub(body);
  return json(out.status, out.body);
};

export const config: Config = { path: '/api/trigger' };
