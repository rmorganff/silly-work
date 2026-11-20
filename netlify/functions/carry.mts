import type { Config, Context } from '@netlify/functions';
import { context } from '../../src/lib/runtime';
import { carry } from '../../src/lib/carry';
import { json } from '../../src/lib/auth';

/** POST /api/carry/:card_id  carries the signed answer on inbox/lms-fix-<id> to the LMS. */
export default async (req: Request, ctx: Context) => {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed', code: 'method_not_allowed' });
  const c = await context(req);
  if ('deny' in c) return c.deny;
  const out = await carry(c.ctx, decodeURIComponent(String(ctx.params.card_id ?? '')));
  return json(out.status, out.body);
};

export const config: Config = { path: '/api/carry/:card_id' };
