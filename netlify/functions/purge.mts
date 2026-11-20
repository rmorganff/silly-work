import type { Config } from '@netlify/functions';
import { ensureMigrated } from '../../src/lib/runtime';
import { getClient } from '../../src/lib/db';
import { purgeExpired } from '../../src/lib/store';

/** Daily: expired slack_drafts (7 days after sent/dismissed), old idempotency keys and tombstones. */
export default async () => {
  await ensureMigrated();
  console.log('[silly-work] purge', JSON.stringify(await purgeExpired(getClient())));
};

export const config: Config = { schedule: '@daily' };
