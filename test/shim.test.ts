import { describe, it, expect, vi } from 'vitest';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { makeCtx, db } from './helpers';
import { handleDb } from '../src/lib/store';
import { handleTrigger } from '../src/lib/trigger';

const SRC = readFileSync(new URL('../public/claude-shim.js', import.meta.url), 'utf8');

/** Loads the real shim in a sandbox "browser" whose fetch is wired straight to the store (no network). */
async function browser(ctx?: Awaited<ReturnType<typeof makeCtx>>) {
  const c = ctx ?? await makeCtx();
  const timers: { fn: () => void; ms: number; id: number }[] = [];
  let tid = 0;
  const listeners: Record<string, Function[]> = {};
  const doc = { visibilityState: 'visible', addEventListener: (n: string, f: Function) => (listeners[n] ||= []).push(f) };
  const calls: any[] = [];
  const win: any = {
    SILLY_WORK_TOKEN: 'tok', document: doc, console,
    fetch: async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      calls.push({ url, auth: init.headers.authorization, body });
      if (!/^Bearer tok$/.test(init.headers.authorization)) return new Response('{"code":"unauthorised"}', { status: 401 });
      const out = url === '/api/trigger' ? await handleTrigger({ ctx: c, now: () => new Date(), fetchImpl: fetch, env: {} }, body) : await handleDb(c, body);
      return new Response(JSON.stringify(out.body), { status: out.status });
    },
    setTimeout: (fn: () => void, ms: number) => { timers.push({ fn, ms, id: ++tid }); return tid; },
    clearTimeout: (id: number) => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); },
  };
  win.window = win;
  vm.runInNewContext(SRC, win);
  const claude = win.claude;
  return {
    c, claude, win, timers, calls,
    db: await claude.use('db'),
    hide: () => { doc.visibilityState = 'hidden'; listeners.visibilitychange?.forEach(f => f()); },
    show: () => { doc.visibilityState = 'visible'; listeners.visibilitychange?.forEach(f => f()); },
    tick: async () => { const t = timers.shift(); t?.fn(); await new Promise(r => setTimeout(r, 30)); },
  };
}
const settle = () => new Promise(r => setTimeout(r, 40));

describe('claude-shim.js', () => {
  it('exposes use(db) and use(mcp); an unknown capability is null, as the bridge expects', async () => {
    const b = await browser();
    expect(b.db.doc).toBeTypeOf('function');
    expect(b.db.collection).toBeTypeOf('function');
    expect((await b.claude.use('mcp')).callTool).toBeTypeOf('function');
    expect(await b.claude.use('assets')).toBeNull();
  });

  it('doc get/set/update/delete behave like the Firestore-style refs desk-bridge.js uses', async () => {
    const b = await browser();
    const ref = b.db.doc('meta/cardn:2026');
    expect((await ref.get()).exists).toBe(false);
    await ref.set({ n: 1 });
    let s = await ref.get();
    expect(s).toMatchObject({ exists: true, id: 'cardn:2026', version: 1 });
    expect(s.data()).toEqual({ n: 1 });
    await ref.update({ m: 2 });
    expect((await ref.get()).data()).toEqual({ n: 1, m: 2 });
    await ref.delete();
    s = await ref.get();
    expect(s.exists).toBe(false); expect(s.data()).toBeUndefined();
    // first slash only: the rest is the id
    await b.db.doc('inbox/a/b:c').set({ x: 1 });
    expect((await db(b.c, { op: 'get', collection: 'inbox', doc_id: 'a/b:c' })).body.exists).toBe(true);
    expect(() => b.db.doc('nonsense')).toThrow();
  });

  it('ifVersion rejects a stale write with {code: version_conflict}; version comes from the snapshot', async () => {
    const b = await browser();
    const ref = b.db.doc('meta/cardn');
    await ref.set({ n: 1 });
    const v = (await ref.get()).version;
    await ref.update({ n: 2 }, { ifVersion: v });
    await expect(ref.update({ n: 3 }, { ifVersion: v })).rejects.toMatchObject({ code: 'version_conflict', status: 409, version: 2 });
  });

  it('silly_wid travels with the write, from options or from data, and a retry is not done twice', async () => {
    const b = await browser();
    const ref = b.db.doc('tasks/t1');
    await ref.set({ title: 'x' }, { silly_wid: 'wid-aaaaaa' });
    const again = await ref.set({ title: 'x' }, { silly_wid: 'wid-aaaaaa' });
    expect(again.again).toBe(true);
    await b.db.doc('tasks/t2').set({ title: 'y', silly_wid: 'wid-bbbbbb' });
    expect((await b.db.doc('tasks/t2').set({ title: 'y', silly_wid: 'wid-bbbbbb' })).again).toBe(true);
    expect((await ref.get()).version).toBe(1);
  });

  it('collection add/get/doc, and server errors surface as thrown {code, status}', async () => {
    const b = await browser();
    const col = b.db.collection('tasks');
    const ref = await col.add({ title: 'a' });
    expect(ref.id).toMatch(/^[A-Za-z0-9_-]{20}$/);
    const snap = await col.get();
    expect(snap.size).toBe(1);
    expect(snap.docs[0].data()).toEqual({ title: 'a' });
    await expect(b.db.doc('inbox/z').update({ a: 1 })).rejects.toMatchObject({ code: 'not_found', status: 404 });
    await expect(b.db.doc('inbox/z').set({ text: 'Sarah rang' })).rejects.toMatchObject({ code: 'scrub_rejected', status: 422 });
  });

  it('onSnapshot: first snapshot, then deltas by seq, polled every 7 s; own writes show at once', async () => {
    const b = await browser();
    await db(b.c, { op: 'set', collection: 'inbox', doc_id: 'c1', data: { t: 1 } });
    const docSeen: any[] = [], colSeen: number[] = [];
    b.db.doc('inbox/c1').onSnapshot((s: any) => docSeen.push(s.data()));
    b.db.collection('inbox').onSnapshot((s: any) => colSeen.push(s.size));
    await settle();
    expect(docSeen).toEqual([{ t: 1 }]);
    expect(colSeen).toEqual([1]);
    expect(b.timers).toHaveLength(1);
    expect(b.timers[0].ms).toBe(7000);

    // another device writes; nothing arrives until the poll
    await db(b.c, { op: 'update', collection: 'inbox', doc_id: 'c1', data: { t: 2 } });
    await db(b.c, { op: 'set', collection: 'inbox', doc_id: 'c2', data: { t: 9 } });
    expect(docSeen).toHaveLength(1);
    await b.tick();
    expect(docSeen).toEqual([{ t: 1 }, { t: 2 }]);
    expect(colSeen).toEqual([1, 2]);
    expect(b.calls.at(-1).body).toMatchObject({ op: 'changes', collection: 'inbox' });
    expect(b.timers).toHaveLength(1); // re-armed

    // a quiet poll fires no callbacks
    await b.tick();
    expect(docSeen).toHaveLength(2); expect(colSeen).toHaveLength(2);

    // a delete elsewhere arrives as a snapshot that does not exist
    await db(b.c, { op: 'delete', collection: 'inbox', doc_id: 'c2' });
    await b.tick();
    expect(colSeen.at(-1)).toBe(1);

    // this page's own write: reflected immediately, and the poll does not repeat it
    await b.db.doc('inbox/c1').update({ t: 3 });
    expect(docSeen.at(-1)).toEqual({ t: 3 });
    const n = docSeen.length;
    await b.tick();
    expect(docSeen).toHaveLength(n);
  });

  it('polling pauses while the page is hidden and resumes (with an immediate catch-up) when visible', async () => {
    const b = await browser();
    await db(b.c, { op: 'set', collection: 'meta', doc_id: 'k', data: { v: 1 } });
    const seen: any[] = [];
    b.db.doc('meta/k').onSnapshot((s: any) => seen.push(s.data()));
    await settle();
    expect(b.timers).toHaveLength(1);
    b.hide();
    expect(b.timers).toHaveLength(0);       // no timer while hidden
    const before = b.calls.length;
    await db(b.c, { op: 'update', collection: 'meta', doc_id: 'k', data: { v: 2 } });
    await settle();
    expect(b.calls.length).toBe(before);    // and no requests
    b.show();
    await settle();
    expect(seen.at(-1)).toEqual({ v: 2 });  // caught up at once
    expect(b.timers).toHaveLength(1);       // timer back
  });

  it('unsubscribing the last listener stops the timer; errors go to the error callback', async () => {
    const b = await browser();
    await db(b.c, { op: 'set', collection: 'meta', doc_id: 'k', data: { v: 1 } });
    const un = b.db.doc('meta/k').onSnapshot(() => {});
    await settle();
    expect(b.timers).toHaveLength(1);
    un();
    expect(b.timers).toHaveLength(0);

    const bad = await browser(); bad.win.SILLY_WORK_TOKEN = 'wrong';
    const errs: any[] = [];
    bad.db.doc('meta/k').onSnapshot(() => {}, (e: any) => errs.push(e));
    await settle();
    expect(errs[0]).toMatchObject({ status: 401, code: 'unauthorised' });
  });

  it('mcp.callTool routes to /api/trigger: list_triggers lists the site jobs, fire_trigger of an unknown id is refused with an {error}', async () => {
    const b = await browser();
    const mcp = await b.claude.use('mcp');
    const list = await mcp.callTool('Claude Code Remote', 'list_triggers', { enabled: true, limit: 100 });
    expect(list.data.map((t: any) => t.id).sort()).toEqual(['trig_answerwatch', 'trig_chase', 'trig_fridayreview', 'trig_healthcheck', 'trig_weekbrief']);
    const fired = await mcp.callTool('Claude Code Remote', 'fire_trigger', { trigger_id: 't', text: 'go' });
    expect(fired.error).toBeTruthy();
    expect(b.calls.at(-1)).toMatchObject({ url: '/api/trigger', body: { server: 'Claude Code Remote', tool: 'fire_trigger', args: { trigger_id: 't' } } });
  });

  it('does not replace a real claude.ai host', async () => {
    const win: any = { claude: { real: true }, console };
    win.window = win;
    vm.runInNewContext(SRC, win);
    expect(win.claude.real).toBe(true);
  });

  it('survives desk-bridge.js use: its readDoc and queries only need get/exists/data', async () => {
    const b = await browser();
    await b.db.doc('meta/rush').set({ a: 1 });
    const d = await b.db.doc('meta/rush').get();
    expect(d && d.exists ? d.data() || {} : null).toEqual({ a: 1 }); // the bridge's readDoc line
    const s = await b.db.collection('meta').get();
    expect(s.docs.map((x: any) => Object.assign({}, x.data(), { id: x.id }))).toEqual([{ a: 1, id: 'rush' }]); // the bridge's all()
    vi.restoreAllMocks();
  });
});
