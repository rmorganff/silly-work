import crypto from 'node:crypto';
import type { Client, Transaction, InValue } from '@libsql/client';
import { guardInboxWrite, Refusal, type EnrolledKey } from './approval';
import { scrubDoc, ScrubRejected } from './scrub';

export interface StoreCtx {
  client: Client;
  keys: EnrolledKey[];
  actor: string;
  now?: () => Date;
}
export interface Out { status: number; body: any }

const WID = /^[A-Za-z0-9_-]{6,80}$/;
const COLLECTION = /^[A-Za-z0-9_.-]{1,100}$/;
const MAX_DOC_BYTES = 512 * 1024;
const MAX_CHANGES = 500;

const err = (status: number, code: string, extra: Record<string, unknown> = {}): Out => ({ status, body: { error: code, code, ...extra } });
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const iso = (c: StoreCtx) => (c.now ? c.now() : new Date()).toISOString();

interface Row { data: Record<string, any> | null; version: number; seq: number; updated_at: string }

async function readRow(tx: Pick<Transaction, 'execute'>, collection: string, docId: string): Promise<Row | null> {
  const r = await tx.execute({ sql: 'SELECT data, version, seq, updated_at FROM docs WHERE collection = ? AND doc_id = ?', args: [collection, docId] });
  if (!r.rows.length) return null;
  const x = r.rows[0];
  return { data: x.data == null ? null : JSON.parse(String(x.data)), version: Number(x.version), seq: Number(x.seq), updated_at: String(x.updated_at) };
}

async function nextSeq(tx: Pick<Transaction, 'execute'>): Promise<number> {
  const r = await tx.execute('UPDATE seq_counter SET value = value + 1 WHERE id = 1 RETURNING value');
  return Number(r.rows[0].value);
}
export async function currentSeq(client: Pick<Client, 'execute'>): Promise<number> {
  const r = await client.execute('SELECT value FROM seq_counter WHERE id = 1');
  return r.rows.length ? Number(r.rows[0].value) : 0;
}

const view = (id: string, row: Row) => ({ id, data: row.data, version: row.version, seq: row.seq, updated_at: row.updated_at });

async function audit(c: StoreCtx, action: string, target: string, tx?: Pick<Transaction, 'execute'>) {
  try {
    await (tx ?? c.client).execute({ sql: 'INSERT INTO audit_log (actor, action, target, created_at) VALUES (?, ?, ?, ?)', args: [c.actor, action, target, iso(c)] });
  } catch { /* an audit failure never blocks or leaks */ }
}

/** One request to /api/db. Everything returns {status, body}; nothing throws to the caller. */
export async function handleDb(c: StoreCtx, req: any): Promise<Out> {
  if (!isObj(req)) return err(400, 'bad_request');
  const op = String(req.op ?? '');
  try {
    if (op === 'changes') return await changes(c, req);
    const collection = String(req.collection ?? '');
    if (!COLLECTION.test(collection)) return err(400, 'bad_collection');
    if (op === 'list') return await list(c, collection, req);
    if (op === 'add') return await write(c, { ...req, op: 'add', doc_id: String(req.doc_id || crypto.randomBytes(15).toString('base64url')) });
    const docId = String(req.doc_id ?? '');
    if (!docId || docId.length > 500 || /[\u0000-\u001f]/.test(docId)) return err(400, 'bad_doc_id');
    if (op === 'get') {
      const row = await readRow(c.client, collection, docId);
      return { status: 200, body: row && row.data !== null ? { exists: true, ...view(docId, row) } : { exists: false, id: docId } };
    }
    if (op === 'set' || op === 'update' || op === 'delete') return await write(c, { ...req, op, collection, doc_id: docId });
    return err(400, 'bad_op');
  } catch (e: any) {
    return err(500, 'server_error', { message: String(e?.message ?? e).slice(0, 200) });
  }
}

async function list(c: StoreCtx, collection: string, req: any): Promise<Out> {
  const seq = await currentSeq(c.client); // read first: a doc written meanwhile has a higher seq and comes again in changes
  const limit = Math.min(Math.max(Number(req.limit) || 2000, 1), 5000);
  const r = await c.client.execute({
    sql: 'SELECT doc_id, data, version, seq, updated_at FROM docs WHERE collection = ? AND data IS NOT NULL ORDER BY doc_id LIMIT ?',
    args: [collection, limit],
  });
  const docs = r.rows.map(x => ({ id: String(x.doc_id), data: JSON.parse(String(x.data)), version: Number(x.version), seq: Number(x.seq), updated_at: String(x.updated_at) }));
  return { status: 200, body: { docs, seq } };
}

async function changes(c: StoreCtx, req: any): Promise<Out> {
  const since = Number(req.since_seq);
  if (!Number.isInteger(since) || since < 0) return err(400, 'bad_since_seq');
  const limit = Math.min(Math.max(Number(req.limit) || MAX_CHANGES, 1), MAX_CHANGES);
  const args: InValue[] = [since];
  let sql = 'SELECT collection, doc_id, data, version, seq, updated_at FROM docs WHERE seq > ?';
  if (req.collection != null) {
    if (!COLLECTION.test(String(req.collection))) return err(400, 'bad_collection');
    sql += ' AND collection = ?'; args.push(String(req.collection));
  }
  sql += ' ORDER BY seq ASC LIMIT ?'; args.push(limit + 1);
  const counter = await currentSeq(c.client);
  const r = await c.client.execute({ sql, args });
  const more = r.rows.length > limit;
  const rows = r.rows.slice(0, limit);
  const out = rows.map(x => ({
    collection: String(x.collection), id: String(x.doc_id), data: x.data == null ? null : JSON.parse(String(x.data)),
    deleted: x.data == null, version: Number(x.version), seq: Number(x.seq), updated_at: String(x.updated_at),
  }));
  // With more to come the cursor is the last row returned; when drained it is the counter read before the query.
  const seq = more ? out[out.length - 1].seq : Math.max(counter, out.length ? out[out.length - 1].seq : since);
  return { status: 200, body: { changes: out, seq, more } };
}

const isBusy = (e: any) => /SQLITE_BUSY|database is locked/i.test(String(e?.message ?? e));

/** A write that lost the race for the database lock is retried (nothing of it was committed); the retry then sees the winner's version. */
async function write(c: StoreCtx, req: any): Promise<Out> {
  for (let attempt = 0; ; attempt++) {
    try { return await writeOnce(c, req); }
    catch (e) {
      if (!isBusy(e) || attempt >= 12) throw e;
      await new Promise(r => setTimeout(r, 15 * (attempt + 1) + Math.random() * 20));
    }
  }
}

async function writeOnce(c: StoreCtx, req: any): Promise<Out> {
  const { op, collection, doc_id: docId } = req as { op: 'set' | 'update' | 'add' | 'delete'; collection: string; doc_id: string };
  const target = `${collection}/${docId}`;
  let incoming: Record<string, any> | undefined;
  if (op !== 'delete') {
    if (!isObj(req.data)) return err(400, 'bad_data');
    if (Buffer.byteLength(JSON.stringify(req.data), 'utf8') > MAX_DOC_BYTES) return err(413, 'doc_too_large');
    try {
      const s = scrubDoc(collection, docId, req.data);
      incoming = s.data;
    } catch (e) {
      if (e instanceof ScrubRejected) {
        await audit(c, `scrub_rejected:${e.rule}`, target); // rule and target only, never the matched text
        return err(422, 'scrub_rejected', { rule: e.rule });
      }
      throw e;
    }
  }
  const widRaw = req.silly_wid ?? req.data?.silly_wid;
  const wid = typeof widRaw === 'string' && WID.test(widRaw) ? widRaw : null;
  const ifVersion = req.ifVersion === undefined || req.ifVersion === null ? null : Number(req.ifVersion);
  if (ifVersion !== null && (!Number.isInteger(ifVersion) || ifVersion < 0)) return err(400, 'bad_ifVersion');

  const tx = await c.client.transaction('write');
  try {
    if (wid) {
      const k = await tx.execute({ sql: 'SELECT collection, doc_id FROM idempotency_keys WHERE silly_wid = ?', args: [wid] });
      if (k.rows.length && String(k.rows[0].collection) === collection && String(k.rows[0].doc_id) === docId) {
        const row = await readRow(tx, collection, docId);
        await tx.rollback();
        return { status: 200, body: { ok: true, again: true, id: docId, ...(row ? { version: row.version, seq: row.seq } : {}) } };
      }
    }
    const row = await readRow(tx, collection, docId);
    const exists = !!row && row.data !== null;
    if (ifVersion !== null && (exists ? row!.version : 0) !== ifVersion) {
      await tx.rollback();
      return err(409, 'version_conflict', { version: exists ? row!.version : 0 });
    }
    if (op === 'add' && exists) { await tx.rollback(); return err(409, 'exists'); }
    if ((op === 'update' || op === 'delete') && !exists) { await tx.rollback(); return err(404, 'not_found'); }

    let next: Record<string, any> | null;
    if (op === 'delete') next = null;
    else if (op === 'update') next = { ...row!.data, ...incoming };
    else next = { ...incoming };

    if (collection === 'inbox' && next) {
      const g = guardInboxWrite({
        collection, docId, existing: exists ? row!.data : null, incoming: incoming!, keys: c.keys,
        now: c.now?.(), replace: op === 'set',
      });
      next = op === 'update' ? { ...row!.data, ...g.data } : { ...g.data };
    }
    if (next && Buffer.byteLength(JSON.stringify(next), 'utf8') > MAX_DOC_BYTES) { await tx.rollback(); return err(413, 'doc_too_large'); }

    const seq = await nextSeq(tx);
    const at = iso(c);
    // A tombstone (data NULL) keeps the row so pollers hear about the delete.
    await tx.execute({
      sql: `INSERT INTO docs (collection, doc_id, data, version, seq, updated_at) VALUES (?, ?, ?, 1, ?, ?)
            ON CONFLICT (collection, doc_id) DO UPDATE SET data = excluded.data, version = docs.version + 1, seq = excluded.seq, updated_at = excluded.updated_at`,
      args: [collection, docId, next === null ? null : JSON.stringify(next), seq, at],
    });
    if (wid) await tx.execute({ sql: 'INSERT OR IGNORE INTO idempotency_keys (silly_wid, collection, doc_id, created_at) VALUES (?, ?, ?, ?)', args: [wid, collection, docId, at] });
    await audit(c, op, target, tx);
    const after = await readRow(tx, collection, docId);
    await tx.commit();
    return { status: 200, body: { ok: true, id: docId, version: after!.version, seq: after!.seq } };
  } catch (e) {
    try { await tx.rollback(); } catch { /* already closed */ }
    if (e instanceof Refusal) {
      await audit(c, `refused:${e.code}`, target);
      return err(422, e.code);
    }
    throw e;
  } finally {
    tx.close();
  }
}

// ---- housekeeping -------------------------------------------------------------

/** Marks a Slack draft sent or dismissed and starts its 7-day clock. */
export async function closeDraft(client: Client, id: string, status: 'sent' | 'dismissed', now = new Date()): Promise<boolean> {
  const exp = new Date(now.getTime() + 7 * 864e5).toISOString();
  const r = await client.execute({
    sql: `UPDATE slack_drafts SET status = ?, sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END, expires_at = ? WHERE id = ? AND status = 'pending'`,
    args: [status, status, now.toISOString(), exp, id],
  });
  return r.rowsAffected > 0;
}

/** Purges expired drafts, old idempotency keys (30 days) and old tombstones (30 days). Returns counts. */
export async function purgeExpired(client: Client, now = new Date()) {
  const iso0 = now.toISOString(), old = new Date(now.getTime() - 30 * 864e5).toISOString();
  const d = await client.execute({ sql: 'DELETE FROM slack_drafts WHERE expires_at IS NOT NULL AND expires_at < ?', args: [iso0] });
  const k = await client.execute({ sql: 'DELETE FROM idempotency_keys WHERE created_at < ?', args: [old] });
  const t = await client.execute({ sql: 'DELETE FROM docs WHERE data IS NULL AND updated_at < ?', args: [old] });
  return { drafts: d.rowsAffected, keys: k.rowsAffected, tombstones: t.rowsAffected };
}
