import type { Config } from '@netlify/functions';
import { context } from '../../src/lib/runtime';
import { smoke } from '../../src/lib/smoke';
import { json } from '../../src/lib/auth';

/** POST /api/smoke {llm?: true}: read-only check of Slack, monday.com, the model key and the background settings. Answers booleans and codes, never secrets. */
export default async (req: Request) => {
  const c = await context(req);
  if ('deny' in c) return c.deny;
  const body: any = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  return json(200, await smoke(process.env, fetch, { llm: body?.llm === true }));
};

export const config: Config = { path: '/api/smoke' };
