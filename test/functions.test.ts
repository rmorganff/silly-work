import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The Netlify function modules run end to end here: auth, migrations on cold start, routing of bodies, status codes.
let dbFn: any, carryFn: any, trigFn: any, pushFn: any;
beforeAll(async () => {
  process.env.TURSO_DATABASE_URL = `file:${join(mkdtempSync(join(tmpdir(), 'silly-work-fn-')), 'f.db')}`;
  process.env.SILLY_WORK_API_TOKEN = 'phone=secret-1,laptop=secret-2';
  dbFn = (await import('../netlify/functions/db.mts')).default;
  carryFn = (await import('../netlify/functions/carry.mts')).default;
  trigFn = (await import('../netlify/functions/trigger.mts')).default;
  pushFn = (await import('../netlify/functions/push.mts')).default;
});

const post = (url: string, body: unknown, token = 'secret-1') =>
  new Request(`https://w.test${url}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('Netlify functions', () => {
  it('every endpoint refuses a missing or wrong bearer token', async () => {
    for (const [fn, url] of [[dbFn, '/api/db'], [trigFn, '/api/trigger'], [pushFn, '/api/push']] as const) {
      expect((await fn(new Request(`https://w.test${url}`, { method: 'POST', body: '{}' }))).status).toBe(401);
      expect((await fn(post(url, {}, 'wrong'))).status).toBe(401);
    }
    expect((await carryFn(post('/api/carry/lms-fix-1', {}, 'nope'), { params: { card_id: 'lms-fix-1' } })).status).toBe(401);
  });

  it('POST /api/db round trip, GET changes, idempotency, audit actor from the token label', async () => {
    const w = await dbFn(post('/api/db', { op: 'set', collection: 'meta', doc_id: 'k:1', data: { a: 1 }, silly_wid: 'wid-fn-0001' }, 'secret-2'));
    expect(w.status).toBe(200);
    expect((await (await dbFn(post('/api/db', { op: 'set', collection: 'meta', doc_id: 'k:1', data: { a: 1 }, silly_wid: 'wid-fn-0001' }, 'secret-2'))).json()).again).toBe(true);
    const g = await (await dbFn(post('/api/db', { op: 'get', collection: 'meta', doc_id: 'k:1' }))).json();
    expect(g).toMatchObject({ exists: true, data: { a: 1 }, version: 1 });
    const ch = await dbFn(new Request('https://w.test/api/db?since_seq=0', { headers: { authorization: 'Bearer secret-1' } }));
    expect((await ch.json()).changes).toHaveLength(1);
    expect((await dbFn(new Request('https://w.test/api/db', { headers: { authorization: 'Bearer secret-1' } }))).status).toBe(400);
    expect((await dbFn(new Request('https://w.test/api/db', { method: 'PUT', headers: { authorization: 'Bearer secret-1' } }))).status).toBe(405);
    const { getClient } = await import('../src/lib/db');
    const a = await getClient().execute("SELECT actor FROM audit_log WHERE action = 'set'");
    expect(a.rows[0].actor).toBe('laptop');
  });

  it('a scrubbed write is a 422 over HTTP too', async () => {
    const r = await dbFn(post('/api/db', { op: 'set', collection: 'inbox', doc_id: 'p', data: { text: 'Emma is off' } }));
    expect(r.status).toBe(422);
    expect((await r.json()).code).toBe('scrub_rejected');
  });

  it('carry: unknown card 404s, a non-fix card 400s', async () => {
    expect((await carryFn(post('/api/carry/lms-fix-zzz', {}), { params: { card_id: 'lms-fix-zzz' } })).status).toBe(404);
    expect((await carryFn(post('/api/carry/nope', {}), { params: { card_id: 'nope' } })).status).toBe(400);
    expect((await carryFn(new Request('https://w.test/api/carry/x', { method: 'GET' }), { params: { card_id: 'x' } })).status).toBe(405);
  });

  it('trigger and push: registry list, config and card checks', async () => {
    expect((await (await trigFn(post('/api/trigger', { tool: 'list_triggers' }))).json()).data).toHaveLength(3);
    expect((await pushFn(post('/api/push', { card: { title: 't' } }))).status).toBe(400);
    delete process.env.WORK_NTFY_URL;
    expect((await pushFn(post('/api/push', { card: { id: 'x', title: 'Retail 14 open' } }))).status).toBe(503);
    expect((await pushFn(post('/api/push', { card: { id: 'x', title: 'Emma rang' } }))).status).toBe(422);
  });
});
