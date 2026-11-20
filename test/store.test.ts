import { describe, it, expect } from 'vitest';
import { makeCtx, db } from './helpers';
import { closeDraft, purgeExpired } from '../src/lib/store';

describe('docs store', () => {
  it('sets, gets and lists; colons and slashes stay legal in doc_id', async () => {
    const c = await makeCtx();
    const ids = ['plain', 'cardn:2026-11', 'a:b:c', 'lms-fix-123', 'x/y'];
    for (const id of ids) expect((await db(c, { op: 'set', collection: 'meta', doc_id: id, data: { v: id } })).status).toBe(200);
    for (const id of ids) {
      const g = await db(c, { op: 'get', collection: 'meta', doc_id: id });
      expect(g.body).toMatchObject({ exists: true, id, data: { v: id }, version: 1 });
    }
    const l = await db(c, { op: 'list', collection: 'meta' });
    expect(l.body.docs.map((d: any) => d.id).sort()).toEqual([...ids].sort());
    expect((await db(c, { op: 'get', collection: 'meta', doc_id: 'nope' })).body).toMatchObject({ exists: false });
  });

  it('seq is monotonic across collections and versions count writes', async () => {
    const c = await makeCtx();
    const a = await db(c, { op: 'set', collection: 'a', doc_id: '1', data: { n: 1 } });
    const b = await db(c, { op: 'set', collection: 'b', doc_id: '1', data: { n: 1 } });
    const a2 = await db(c, { op: 'update', collection: 'a', doc_id: '1', data: { n: 2 } });
    expect(b.body.seq).toBe(a.body.seq + 1);
    expect(a2.body.seq).toBe(b.body.seq + 1);
    expect(a2.body.version).toBe(2);
  });

  it('update merges, and 404s on a missing doc', async () => {
    const c = await makeCtx();
    await db(c, { op: 'set', collection: 'tasks', doc_id: 't', data: { a: 1, b: 2 } });
    await db(c, { op: 'update', collection: 'tasks', doc_id: 't', data: { b: 3, c: 4 } });
    expect((await db(c, { op: 'get', collection: 'tasks', doc_id: 't' })).body.data).toEqual({ a: 1, b: 3, c: 4 });
    expect((await db(c, { op: 'update', collection: 'tasks', doc_id: 'zz', data: { a: 1 } })).status).toBe(404);
  });

  it('add makes an id and refuses nothing it did not make', async () => {
    const c = await makeCtx();
    const r = await db(c, { op: 'add', collection: 'tasks', data: { title: 'x' } });
    expect(r.status).toBe(200);
    expect(r.body.id).toMatch(/^[A-Za-z0-9_-]{20}$/);
    expect((await db(c, { op: 'get', collection: 'tasks', doc_id: r.body.id })).body.data).toEqual({ title: 'x' });
  });

  it('ifVersion is a real compare-and-set (meta/cardn)', async () => {
    const c = await makeCtx();
    // ifVersion 0 = must not exist yet
    expect((await db(c, { op: 'set', collection: 'meta', doc_id: 'cardn', data: { n: 1 }, ifVersion: 0 })).status).toBe(200);
    expect((await db(c, { op: 'set', collection: 'meta', doc_id: 'cardn', data: { n: 9 }, ifVersion: 0 })).status).toBe(409);
    // two writers both read version 1; only the first lands
    const first = await db(c, { op: 'update', collection: 'meta', doc_id: 'cardn', data: { n: 2 }, ifVersion: 1 });
    const second = await db(c, { op: 'update', collection: 'meta', doc_id: 'cardn', data: { n: 2 }, ifVersion: 1 });
    expect(first.status).toBe(200);
    expect(second).toMatchObject({ status: 409, body: { code: 'version_conflict', version: 2 } });
    expect((await db(c, { op: 'get', collection: 'meta', doc_id: 'cardn' })).body.data).toEqual({ n: 2 });
    expect((await db(c, { op: 'update', collection: 'meta', doc_id: 'cardn', data: { n: 3 }, ifVersion: 2 })).status).toBe(200);
  });

  it('concurrent CAS writers: exactly one wins', async () => {
    const c = await makeCtx();
    await db(c, { op: 'set', collection: 'meta', doc_id: 'cardn', data: { n: 0 } });
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => db(c, { op: 'update', collection: 'meta', doc_id: 'cardn', data: { n: i + 1 }, ifVersion: 1 })));
    expect(results.filter(r => r.status === 200)).toHaveLength(1);
    expect(results.filter(r => r.status === 409)).toHaveLength(5);
  });

  it('silly_wid: a retry that already landed is not done twice', async () => {
    const c = await makeCtx();
    const w = { op: 'set', collection: 'tasks', doc_id: 'idea-abc123', data: { title: 'x' }, silly_wid: 'wid-000001' };
    const a = await db(c, w);
    const b = await db(c, w);
    expect(a.body).toMatchObject({ ok: true, version: 1 });
    expect(b.body).toMatchObject({ ok: true, again: true, version: 1 });
    expect((await db(c, { op: 'get', collection: 'tasks', doc_id: 'idea-abc123' })).body.version).toBe(1);
    const n = await c.client.execute('SELECT COUNT(*) AS n FROM idempotency_keys');
    expect(Number(n.rows[0].n)).toBe(1);
  });

  it('silly_wid inside data counts too, and a bad wid is ignored', async () => {
    const c = await makeCtx();
    const w = { op: 'update', collection: 'inbox', doc_id: 'x', data: { note: 'hi', silly_wid: 'wid-abcdef' } };
    await db(c, { op: 'set', collection: 'inbox', doc_id: 'x', data: {} });
    await db(c, w);
    expect((await db(c, w)).body.again).toBe(true);
    const bad = { op: 'update', collection: 'inbox', doc_id: 'x', data: { note: 'a' }, silly_wid: 'no' };
    await db(c, bad);
    expect((await db(c, bad)).body.again).toBeUndefined();
  });

  it('a refused write does not burn its silly_wid', async () => {
    const c = await makeCtx();
    const w = { op: 'update', collection: 'tasks', doc_id: 'late', data: { a: 1 }, silly_wid: 'wid-late-01' };
    expect((await db(c, w)).status).toBe(404);
    await db(c, { op: 'set', collection: 'tasks', doc_id: 'late', data: {} });
    expect((await db(c, w)).body).toMatchObject({ ok: true });
  });

  it('delete leaves a tombstone the change feed reports', async () => {
    const c = await makeCtx();
    await db(c, { op: 'set', collection: 'tasks', doc_id: 'a', data: { x: 1 } });
    const before = (await db(c, { op: 'list', collection: 'tasks' })).body.seq;
    await db(c, { op: 'delete', collection: 'tasks', doc_id: 'a' });
    expect((await db(c, { op: 'get', collection: 'tasks', doc_id: 'a' })).body.exists).toBe(false);
    expect((await db(c, { op: 'list', collection: 'tasks' })).body.docs).toHaveLength(0);
    const ch = await db(c, { op: 'changes', since_seq: before });
    expect(ch.body.changes).toMatchObject([{ id: 'a', deleted: true, data: null }]);
    // recreate: the version keeps counting
    expect((await db(c, { op: 'set', collection: 'tasks', doc_id: 'a', data: { x: 2 } })).body.version).toBe(3);
  });

  it('changes?since_seq returns only newer docs, in order, with a cursor; pages when there are many', async () => {
    const c = await makeCtx();
    for (let i = 0; i < 5; i++) await db(c, { op: 'set', collection: 'a', doc_id: `d${i}`, data: { i } });
    const all = await db(c, { op: 'changes', since_seq: 0 });
    expect(all.body.changes.map((x: any) => x.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(all.body).toMatchObject({ seq: 5, more: false });
    expect((await db(c, { op: 'changes', since_seq: 5 })).body).toMatchObject({ changes: [], seq: 5 });
    const page = await db(c, { op: 'changes', since_seq: 0, limit: 2 });
    expect(page.body).toMatchObject({ more: true, seq: 2 });
    const rest = await db(c, { op: 'changes', since_seq: page.body.seq, limit: 10 });
    expect(rest.body.changes.map((x: any) => x.id)).toEqual(['d2', 'd3', 'd4']);
    await db(c, { op: 'set', collection: 'b', doc_id: 'z', data: {} });
    expect((await db(c, { op: 'changes', since_seq: 0, collection: 'b' })).body.changes).toHaveLength(1);
    expect((await db(c, { op: 'changes', since_seq: -1 })).status).toBe(400);
  });

  it('rejects bad input without writing', async () => {
    const c = await makeCtx();
    expect((await db(c, { op: 'nope', collection: 'a', doc_id: 'x' })).status).toBe(400);
    expect((await db(c, { op: 'set', collection: 'bad coll!', doc_id: 'x', data: {} })).status).toBe(400);
    expect((await db(c, { op: 'set', collection: 'a', doc_id: '', data: {} })).status).toBe(400);
    expect((await db(c, { op: 'set', collection: 'a', doc_id: 'x', data: 'str' })).status).toBe(400);
    expect((await db(c, { op: 'set', collection: 'a', doc_id: 'x', data: {}, ifVersion: 'z' })).status).toBe(400);
    expect((await db(c, null)).status).toBe(400);
  });

  it('writes an audit row with actor and target, never content', async () => {
    const c = await makeCtx({ actor: 'phone1' });
    await db(c, { op: 'set', collection: 'meta', doc_id: 'k', data: { secret_note: 'zzz' } });
    const r = await c.client.execute('SELECT actor, action, target FROM audit_log');
    expect(r.rows.map(x => ({ ...x }))).toEqual([{ actor: 'phone1', action: 'set', target: 'meta/k' }]);
  });
});

describe('slack_drafts 7-day purge', () => {
  it('purges 7 days after send or dismiss, not before, and never pending ones', async () => {
    const c = await makeCtx();
    const t0 = new Date('2026-11-20T10:00:00Z');
    const ins = (id: string) => c.client.execute({ sql: "INSERT INTO slack_drafts (id, channel_id, kind, draft_text, status, created_at) VALUES (?, 'C1', 'reply', 'ok', 'pending', ?)", args: [id, t0.toISOString()] });
    await ins('sent1'); await ins('dis1'); await ins('pend1');
    expect(await closeDraft(c.client, 'sent1', 'sent', t0)).toBe(true);
    expect(await closeDraft(c.client, 'dis1', 'dismissed', t0)).toBe(true);
    expect(await closeDraft(c.client, 'sent1', 'sent', t0)).toBe(false); // already closed
    const sent = await c.client.execute("SELECT sent_at, expires_at FROM slack_drafts WHERE id = 'sent1'");
    expect(String(sent.rows[0].expires_at)).toBe('2026-11-27T10:00:00.000Z');
    expect((await purgeExpired(c.client, new Date('2026-11-27T09:59:00Z'))).drafts).toBe(0);
    expect((await purgeExpired(c.client, new Date('2026-11-27T10:01:00Z'))).drafts).toBe(2);
    const left = await c.client.execute('SELECT id FROM slack_drafts');
    expect(left.rows.map(r => r.id)).toEqual(['pend1']);
  });
});
