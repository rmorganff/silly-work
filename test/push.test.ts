import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import { seal, open, payload, sendPush, validateCard } from '../src/lib/push';
import { triggerStub } from '../src/lib/trigger';
import { authorise } from '../src/lib/auth';

const KEY = crypto.randomBytes(32).toString('base64');

describe('push', () => {
  it('seals as base64(IV + ciphertext + tag) and opens again; the wrong key does not', () => {
    const iv = Buffer.alloc(12, 7);
    const wire = seal(KEY, '{"a":1}', iv);
    const raw = Buffer.from(wire, 'base64');
    expect(raw.subarray(0, 12)).toEqual(iv);
    expect(raw.length).toBe(12 + 7 + 16);
    expect(open(KEY, wire)).toBe('{"a":1}');
    expect(() => open(crypto.randomBytes(32).toString('base64'), wire)).toThrow();
    expect(() => seal('c2hvcnQ=', 'x')).toThrow(/32 bytes/);
  });

  it('the card payload is board W with the same fields as silly-push.py', () => {
    const p = JSON.parse(payload({ id: 'x1', title: ' T ', n: 5, options: ['A: yes', ' ', 'B: no'], text: 'hi', approve: 'fix' }, new Date('2026-11-20T10:00:00.123Z')));
    expect(p).toEqual({ type: 'card', board: 'W', id: 'x1', n: 5, title: 'T', at: '2026-11-20T10:00:00Z', options: ['A: yes', 'B: no'], text: 'hi', approve: 'fix' });
  });

  it('validates the card', () => {
    expect(validateCard({ id: 'x', title: 't' })).toBeNull();
    expect(validateCard({ title: 't' })).toBe('bad_id');
    expect(validateCard({ id: 'x', title: 't', approve: 'wire' })).toBe('bad_approve');
    expect(validateCard({ id: 'x', title: 't', options: [1] })).toBe('bad_options');
  });

  it('POSTs the sealed text to WORK_NTFY_URL; refuses http and missing config; reports server failures', async () => {
    const f = vi.fn(async () => new Response('', { status: 200 }));
    const env = { WORK_NTFY_URL: 'https://ntfy.test/topic', WORK_NTFY_KEY: KEY } as any;
    expect(await sendPush({ id: 'x', title: 't' }, env, f as any)).toEqual({ ok: true, status: 200 });
    const [url, init] = f.mock.calls[0] as any;
    expect(url).toBe('https://ntfy.test/topic');
    expect(init.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(JSON.parse(open(KEY, init.body)).board).toBe('W');
    expect((await sendPush({ id: 'x', title: 't' }, {} as any, f as any)).code).toBe('push_not_configured');
    expect((await sendPush({ id: 'x', title: 't' }, { ...env, WORK_NTFY_URL: 'http://x' }, f as any)).code).toBe('push_endpoint_not_https');
    expect((await sendPush({ id: 'x', title: 't' }, { ...env, WORK_NTFY_KEY: 'nope' }, f as any)).code).toBe('push_key_invalid');
    expect((await sendPush({ id: 'x', title: 't' }, env, vi.fn(async () => new Response('', { status: 500 })) as any)).code).toBe('push_server_500');
    expect((await sendPush({ id: 'x', title: 't' }, env, vi.fn(async () => { throw new Error('x'); }) as any)).code).toBe('push_unreachable');
  });
});

describe('trigger stub', () => {
  it('lists nothing and refuses to fire, honestly', () => {
    expect(triggerStub({ tool: 'list_triggers' })).toMatchObject({ status: 200, body: { data: [] } });
    const f = triggerStub({ tool: 'fire_trigger', args: { trigger_id: 't' } });
    expect(f.body).toMatchObject({ fired: false, code: 'not_implemented' });
    expect(f.body.error).toBeTruthy(); // the bridge reads {error} as a refused fire
    expect(triggerStub({ tool: 'delete_everything' }).status).toBe(400);
  });
});

describe('bearer auth', () => {
  const rq = (h?: string) => new Request('https://x.test/api/db', { headers: h ? { authorization: h } : {} });
  it('accepts a configured per-device token and names the device', () => {
    expect(authorise(rq('Bearer abc123'), 'phone=abc123,laptop=zzz999')).toBe('phone');
    expect(authorise(rq('Bearer zzz999'), 'phone=abc123,laptop=zzz999')).toBe('laptop');
    expect(authorise(rq('Bearer plain'), 'plain')).toBe('device1');
  });
  it('refuses missing, wrong, empty and unset', () => {
    expect(authorise(rq(), 'a=b')).toBeNull();
    expect(authorise(rq('Bearer nope'), 'a=b')).toBeNull();
    expect(authorise(rq('Bearer '), 'a=b')).toBeNull();
    expect(authorise(rq('Basic b'), 'a=b')).toBeNull();
    expect(authorise(rq('Bearer b'), '')).toBeNull();
    expect(authorise(rq('Bearer b'), undefined)).toBeNull();
  });
});
