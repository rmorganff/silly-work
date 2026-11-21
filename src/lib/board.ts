/**
 * Board access for the background jobs. Reads go straight to the docs table; every write goes through handleDb, so the
 * scrubber, the inbox approval guard, `seq`, `version` and the audit log all apply to a job exactly as they do to a device.
 */
import { handleDb, type StoreCtx } from './store';

export interface Doc { id: string; data: any; version: number; seq: number; updated_at: string }

export class BoardError extends Error {
  constructor(public code: string, public status: number, public rule?: string) { super(code); }
}
export const isCode = (e: unknown, ...codes: string[]): boolean => e instanceof BoardError && codes.includes(e.code);

export async function getDoc(c: StoreCtx, collection: string, id: string): Promise<Doc | null> {
  const r = await handleDb(c, { op: 'get', collection, doc_id: id });
  if (r.status !== 200) throw new BoardError(r.body.code ?? 'error', r.status);
  return r.body.exists ? { id, data: r.body.data, version: r.body.version, seq: r.body.seq, updated_at: r.body.updated_at } : null;
}

export async function listDocs(c: StoreCtx, collection: string, limit = 2000): Promise<Doc[]> {
  const r = await handleDb(c, { op: 'list', collection, limit });
  if (r.status !== 200) throw new BoardError(r.body.code ?? 'error', r.status);
  return r.body.docs as Doc[];
}

export interface WriteReq { op: 'add' | 'set' | 'update' | 'delete'; collection: string; id: string; data?: Record<string, any>; ifVersion?: number }

export async function writeDoc(c: StoreCtx, w: WriteReq): Promise<{ id: string; version: number; seq: number }> {
  const r = await handleDb(c, { op: w.op, collection: w.collection, doc_id: w.id, data: w.data, ifVersion: w.ifVersion });
  if (r.status !== 200) throw new BoardError(r.body.code ?? 'error', r.status, r.body.rule);
  return { id: w.id, version: r.body.version, seq: r.body.seq };
}

/** Writes a whole document, replacing it when it is already there. One retry if someone wrote in between. */
export async function putDoc(c: StoreCtx, collection: string, id: string, data: Record<string, any>): Promise<void> {
  for (let i = 0; i < 2; i++) {
    const cur = await getDoc(c, collection, id);
    try {
      await writeDoc(c, cur ? { op: 'update', collection, id, data, ifVersion: cur.version } : { op: 'add', collection, id, data });
      return;
    } catch (e) { if (i || !isCode(e, 'version_conflict', 'exists')) throw e; }
  }
}

const toDoc = (x: any): Doc => ({ id: String(x.doc_id), data: JSON.parse(String(x.data)), version: Number(x.version), seq: Number(x.seq), updated_at: String(x.updated_at) });

/** Inbox cards that carry an answer and no `actioned`, newest answer first (at most 500). */
export async function queryAnsweredOpen(c: StoreCtx): Promise<Doc[]> {
  const r = await c.client.execute({
    sql: `SELECT doc_id, data, version, seq, updated_at FROM docs WHERE collection = 'inbox' AND data IS NOT NULL
          AND json_extract(data, '$.answered') IS NOT NULL AND json_extract(data, '$.actioned') IS NULL
          ORDER BY json_extract(data, '$.answered') DESC, doc_id ASC LIMIT 500`,
    args: [],
  });
  return r.rows.map(toDoc);
}

/** The highest card number on the inbox, 0 when there are none. */
export async function maxCardNumber(c: StoreCtx): Promise<number> {
  const r = await c.client.execute(`SELECT MAX(CAST(json_extract(data, '$.n') AS INTEGER)) AS m FROM docs WHERE collection = 'inbox' AND data IS NOT NULL`);
  return Number(r.rows[0]?.m ?? 0) || 0;
}
