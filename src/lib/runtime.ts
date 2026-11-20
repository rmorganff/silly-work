import { getClient, migrate } from './db';
import { parseKeys } from './approval';
import { authorise, unauthorised } from './auth';
import type { StoreCtx } from './store';

let ready: Promise<void> | null = null;
/** Applies migrations once per function copy. All statements are idempotent. */
export function ensureMigrated(): Promise<void> {
  if (!ready) ready = migrate(getClient()).then(() => {}, e => { ready = null; throw e; });
  return ready;
}

/** Authorises the request and builds the store context, or returns the 401 to send. */
export async function context(req: Request): Promise<{ ctx: StoreCtx } | { deny: Response }> {
  const actor = authorise(req);
  if (!actor) return { deny: unauthorised() };
  await ensureMigrated();
  return { ctx: { client: getClient(), keys: parseKeys(process.env.SILLY_APPROVAL_KEYS, m => console.warn('[silly-work]', m)), actor } };
}
