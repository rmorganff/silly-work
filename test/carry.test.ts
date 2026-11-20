import { describe, it, expect, vi } from 'vitest';
import { makeCtx, db, sillyKey, fixCard, silly } from './helpers';
import { carry } from '../src/lib/carry';

const ID = 'lms-fix-42';
async function answered(letter = 'A') {
  const k = await sillyKey();
  const c = await makeCtx({ keys: k.keys });
  const card = fixCard();
  await db(c, { op: 'set', collection: 'inbox', doc_id: ID, data: card });
  const ap = await silly.sign({ store: k.store, board: 'W', item: { id: ID, ...card }, letter });
  const answer = card.options.find(o => o.startsWith(letter + ':'))!;
  expect((await db(c, { op: 'update', collection: 'inbox', doc_id: ID, data: { answer, approval: ap } })).status).toBe(200);
  return { c, ap, answer };
}
const env = { TRIAGE_NOTIFY_TOKEN: 'tok', TRIAGE_NOTIFY_BASE: 'https://lms.test' };
const reply = (status: number, body: any) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe('carry', () => {
  it('posts the signed approval to the LMS with x-triage-token and records carried_answer and result', async () => {
    const { c, ap, answer } = await answered();
    const f = reply(200, { status: 'approved' });
    const r = await carry(c, ID, env, f as any);
    expect(r).toMatchObject({ status: 200, body: { recorded: true, report: '42', status: 'approved' } });
    const [url, init] = f.mock.calls[0] as any;
    expect(url).toBe('https://lms.test/api/triage/silly-decision');
    expect(init.headers['x-triage-token']).toBe('tok');
    expect(JSON.parse(init.body)).toEqual({ report_id: '42', approval: ap });
    const card = (await db(c, { op: 'get', collection: 'inbox', doc_id: ID })).body.data;
    expect(card.carried_answer).toBe(answer);
    expect(card.result).toMatchObject({ recorded: true });
    expect(card.actioned).toBeUndefined(); // never quietly actioned
    expect(card.approval).toEqual(ap);     // the signed pair is untouched
  });

  it('carrying twice is harmless: the second does not call the LMS again', async () => {
    const { c } = await answered();
    const f = reply(200, { status: 'approved' });
    await carry(c, ID, env, f as any);
    const again = await carry(c, ID, env, f as any);
    expect(again).toMatchObject({ status: 200, body: { recorded: true, already: true } });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('the LMS saying SILLY_APPROVAL_USED is a recorded decision, not an error', async () => {
    const { c } = await answered();
    const r = await carry(c, ID, env, reply(409, { code: 'SILLY_APPROVAL_USED' }) as any);
    expect(r).toMatchObject({ status: 200, body: { recorded: true, already: true } });
    expect((await db(c, { op: 'get', collection: 'inbox', doc_id: ID })).body.data.result.recorded).toBe(true);
  });

  it('an LMS refusal is reported and recorded as not recorded, and a retry is allowed', async () => {
    const { c } = await answered();
    const r = await carry(c, ID, env, reply(422, { code: 'BAD_SIGNATURE', error: 'no' }) as any);
    expect(r).toMatchObject({ status: 422, body: { recorded: false, code: 'BAD_SIGNATURE' } });
    const f = reply(200, { status: 'approved' });
    expect((await carry(c, ID, env, f as any)).body).toMatchObject({ recorded: true });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('an unreachable LMS is a 502 and leaves the card alone', async () => {
    const { c } = await answered();
    const r = await carry(c, ID, env, vi.fn(async () => { throw new Error('down'); }) as any);
    expect(r).toMatchObject({ status: 502, body: { code: 'LMS_UNREACHABLE' } });
    expect((await db(c, { op: 'get', collection: 'inbox', doc_id: ID })).body.data.result).toBeUndefined();
  });

  it('NOT_SIGNED, ANSWER_MISMATCH, not a fix card, missing card, no token: nothing is sent', async () => {
    const f = reply(200, {});
    const k = await sillyKey(); const c = await makeCtx({ keys: k.keys });
    await db(c, { op: 'set', collection: 'inbox', doc_id: ID, data: { title: 'T', options: ['A: x'], answer: 'A: x' } });
    expect((await carry(c, ID, env, f as any)).body).toMatchObject({ code: 'NOT_SIGNED' });
    // inserted raw: a card whose stored answer and signed letter disagree cannot get past the guard, so plant one
    await c.client.execute({ sql: "INSERT INTO docs (collection, doc_id, data, version, seq, updated_at) VALUES ('inbox', 'lms-fix-9', ?, 1, 99, 'x')", args: [JSON.stringify({ title: 'T', answer: 'B: x', approval: { option: 'A' } })] });
    expect((await carry(c, 'lms-fix-9', env, f as any)).body).toMatchObject({ code: 'ANSWER_MISMATCH' });
    expect((await carry(c, 'other-1', env, f as any)).body).toMatchObject({ code: 'NOT_A_FIX_CARD' });
    expect((await carry(c, 'lms-fix-nope', env, f as any)).status).toBe(404);
    const s = await answered();
    expect((await carry(s.c, ID, {}, f as any)).body).toMatchObject({ code: 'NOT_SET_UP' });
    expect(f).not.toHaveBeenCalled();
  });
});
