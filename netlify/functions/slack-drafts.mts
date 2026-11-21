import type { Config } from '@netlify/functions';
import { context } from '../../src/lib/runtime';
import { listPending, actOnDraft } from '../../src/lib/slack-drafts';
import { json } from '../../src/lib/auth';

/** GET /api/slack-drafts lists pending drafts. POST {id, action: 'send' | 'dismiss'} sends one into its thread, or drops it. */
export default async (req: Request) => {
  const c = await context(req);
  if ('deny' in c) return c.deny;
  if (req.method === 'GET') return json(200, { drafts: await listPending(c.ctx.client) });
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed', code: 'method_not_allowed' });
  const body: any = await req.json().catch(() => null);
  const out = await actOnDraft(c.ctx.client, process.env, fetch, c.ctx.actor, body);
  return json(out.status, out.body);
};

export const config: Config = { path: '/api/slack-drafts' };
