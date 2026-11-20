import { createClient, type Client } from '@libsql/client';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { migrate } from '../src/lib/db';
import { parseKeys, type EnrolledKey } from '../src/lib/approval';
import type { StoreCtx } from '../src/lib/store';
import { handleDb } from '../src/lib/store';
// Silly for Chrome's own signing module, copied verbatim: the interop test signs with the real thing.
// @ts-ignore (plain JS)
import * as silly from './vendor/silly-approvals.js';

export async function freshClient(): Promise<Client> {
  // a file, not :memory:, because libsql opens a new connection for each transaction
  const c = createClient({ url: `file:${join(mkdtempSync(join(tmpdir(), 'silly-work-')), 'test.db')}` });
  await migrate(c);
  return c;
}

export async function makeCtx(over: Partial<StoreCtx> = {}): Promise<StoreCtx> {
  return { client: await freshClient(), keys: [], actor: 'test', ...over };
}

export const db = (c: StoreCtx, req: any) => handleDb(c, req);

/** Silly's real signing module with a real (WebCrypto, not extractable) key, enrolled as the given device. */
export async function sillyKey(device: 'phone' | 'phone_unlock' | 'chrome' = 'chrome') {
  const store = silly.memoryStore();
  const info = await silly.makeKey(store);
  const keys: EnrolledKey[] = parseKeys(JSON.stringify([{ device, spki: info.spki, user_id: 'u1', label: device }]));
  return { store, info, keys, device };
}

export const sha256hex = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/** An LMS-style approve card as the Work Board holds it. */
export function fixCard(subject = sha256hex('the change'), action: 'fix' | 'deploy' | 'tablet' = 'fix') {
  return {
    title: 'LMS fix: a thing', text: 'Triage has a proposal.', n: 7, row: 'lms',
    options: ['A: approve and ship', 'B: use this reply', 'C: not this'],
    approve: { action, board: 'W', card_id: 'lms-fix-42', subject },
    source: 'lms-triage',
  };
}

export { silly };
