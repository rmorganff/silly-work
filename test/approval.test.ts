import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { makeCtx, db, sillyKey, fixCard, silly, sha256hex } from './helpers';
import { signedText, parseKeys, optionLetter } from '../src/lib/approval';

const CARD = 'lms-fix-42';
async function setup(action: 'fix' | 'deploy' | 'tablet' = 'fix', device: 'phone' | 'phone_unlock' | 'chrome' = 'chrome', card = fixCard(undefined, action)) {
  const k = await sillyKey(device);
  const c = await makeCtx({ keys: k.keys });
  const put = await db(c, { op: 'set', collection: 'inbox', doc_id: CARD, data: card });
  expect(put.status).toBe(200);
  return { k, c, card };
}
const answerWith = async (k: any, card: any, letter = 'A', now?: number) =>
  silly.sign({ store: k.store, board: 'W', item: { id: CARD, ...card }, letter, now });
const write = (c: any, answer: string, approval?: any, extra: any = {}) =>
  db(c, { op: 'update', collection: 'inbox', doc_id: CARD, data: { answer, ...(approval ? { approval } : {}), ...extra } });
const code = (r: any) => r.body.code;

describe('inbox approval guard (silly-approval-v1)', () => {
  it('accepts an answer signed by Silly for Chrome itself (interop with the real signer)', async () => {
    const { k, c, card } = await setup();
    const ap = await answerWith(k, card, 'A');
    const r = await write(c, 'A: approve and ship', ap);
    expect(r.status).toBe(200);
    const got = (await db(c, { op: 'get', collection: 'inbox', doc_id: CARD })).body.data;
    expect(got.answer).toBe('A: approve and ship');
    expect(got.approval).toEqual(ap);
  });

  it('needs_signature: an approve card answered with no approval writes nothing', async () => {
    const { c } = await setup();
    const r = await write(c, 'A: approve and ship');
    expect(r.status).toBe(422); expect(code(r)).toBe('needs_signature');
    expect((await db(c, { op: 'get', collection: 'inbox', doc_id: CARD })).body.data.answer).toBeUndefined();
    expect(code(await write(c, 'A: approve and ship', 'nonsense' as any))).toBe('needs_signature');
  });

  it('bad_signature: tampered, wrong letter, malformed, extra fields, unknown key, wrong device, stale, future, wrong board', async () => {
    const { k, c, card } = await setup();
    const ap = await answerWith(k, card, 'A');
    // tampered signature (still well-formed base64)
    const flip = Buffer.from(ap.sig, 'base64'); flip[5] ^= 1;
    expect(code(await write(c, 'A: approve and ship', { ...ap, sig: flip.toString('base64') }))).toBe('bad_signature');
    // signed A, answered B
    expect(code(await write(c, 'B: use this reply', ap))).toBe('bad_signature');
    // malformed fields
    expect(code(await write(c, 'A: approve and ship', { ...ap, v: 2 }))).toBe('bad_signature');
    expect(code(await write(c, 'A: approve and ship', { ...ap, sig: 'abc' }))).toBe('bad_signature');
    expect(code(await write(c, 'A: approve and ship', { ...ap, signed_at: '2026-11-20' }))).toBe('bad_signature');
    expect(code(await write(c, 'A: approve and ship', { ...ap, extra: 1 }))).toBe('bad_signature');
    // a key the server does not know
    const other = await sillyKey('chrome');
    const foreign = await answerWith(other, card, 'A');
    expect(code(await write(c, 'A: approve and ship', foreign))).toBe('bad_signature');
    // signed for another card id
    const wrongCard = await silly.sign({ store: k.store, board: 'W', item: { id: 'lms-fix-43', ...card }, letter: 'A' });
    expect(code(await write(c, 'A: approve and ship', wrongCard))).toBe('bad_signature');
    // signed for the Personal board 'P'
    const personal = await silly.sign({ store: k.store, board: 'P', item: { id: CARD, ...card }, letter: 'A' });
    expect(code(await write(c, 'A: approve and ship', personal))).toBe('bad_signature');
    // a fix signed a week and a bit ago; one from the future
    expect(code(await write(c, 'A: approve and ship', await answerWith(k, card, 'A', Date.now() - 8 * 864e5)))).toBe('bad_signature');
    expect(code(await write(c, 'A: approve and ship', await answerWith(k, card, 'A', Date.now() + 3600e3)))).toBe('bad_signature');
    // nothing was ever written
    expect((await db(c, { op: 'get', collection: 'inbox', doc_id: CARD })).body.data.answer).toBeUndefined();
  });

  it('a deploy needs the phone_unlock key: a chrome or phone key is refused', async () => {
    for (const device of ['chrome', 'phone'] as const) {
      const { k, c, card } = await setup('deploy', device);
      // Silly for Chrome refuses to sign deploys itself, so build the signature directly with the enrolled key class.
      const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
      const spki = Buffer.from(await crypto.subtle.exportKey('spki', key.publicKey));
      const keys = parseKeys(JSON.stringify([{ device, spki: spki.toString('base64'), user_id: 'u' }]));
      const c2 = { ...c, keys };
      const at = silly.isoNow();
      const text = signedText({ board: 'W', card_id: CARD, subject: card.approve.subject, option: 'A', signed_at: at });
      const sig = Buffer.from(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, Buffer.from(text)));
      const ap = { v: 1, key_id: keys[0].id, signed_at: at, option: 'A', subject: card.approve.subject, sig: sig.toString('base64') };
      expect(code(await write(c2, 'A: approve and ship', ap))).toBe('bad_signature');
      void k;
    }
  });

  it('a phone_unlock key signs a deploy, with a DER signature as Android makes it, and a stale deploy is refused', async () => {
    const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    const spki = Buffer.from(await crypto.subtle.exportKey('spki', key.publicKey));
    const keys = parseKeys(JSON.stringify([{ device: 'phone_unlock', spki: spki.toString('base64'), user_id: 'u' }]));
    const card = fixCard(undefined, 'deploy');
    const c = await makeCtx({ keys });
    await db(c, { op: 'set', collection: 'inbox', doc_id: CARD, data: card });
    const sign = async (at: string) => {
      const text = signedText({ board: 'W', card_id: CARD, subject: card.approve.subject, option: 'A', signed_at: at });
      const der = crypto.sign('sha256', Buffer.from(text), { key: crypto.createPrivateKey({ key: Buffer.from(await crypto.subtle.exportKey('pkcs8', key.privateKey)), format: 'der', type: 'pkcs8' }), dsaEncoding: 'der' });
      // Silly's wire format is fixed-length base64; a DER signature is 70-72 bytes so it does not match the 86-char shape: refused as malformed.
      return { v: 1, key_id: keys[0].id, signed_at: at, option: 'A', subject: card.approve.subject, sig: der.toString('base64') };
    };
    // DER is outside the wire contract (sig must be 64 bytes r||s): the guard is stricter than the LMS here, on purpose.
    expect(code(await write(c, 'A: approve and ship', await sign(silly.isoNow())))).toBe('bad_signature');
    // r||s over WebCrypto, fresh: accepted
    const at = silly.isoNow();
    const text = signedText({ board: 'W', card_id: CARD, subject: card.approve.subject, option: 'A', signed_at: at });
    const rs = Buffer.from(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, Buffer.from(text)));
    const ap = { v: 1, key_id: keys[0].id, signed_at: at, option: 'A', subject: card.approve.subject, sig: rs.toString('base64') };
    expect((await write(c, 'A: approve and ship', ap)).status).toBe(200);
    // 20 minutes old: a deploy lives 15
    const old = new Date(Date.now() - 20 * 60e3).toISOString().replace(/\.\d{3}Z$/, 'Z');
    await db(c, { op: 'update', collection: 'inbox', doc_id: CARD, data: { answer: null } });
    const t2 = signedText({ board: 'W', card_id: CARD, subject: card.approve.subject, option: 'A', signed_at: old });
    const sg2 = Buffer.from(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, Buffer.from(t2)));
    expect(code(await write(c, 'A: approve and ship', { ...ap, signed_at: old, sig: sg2.toString('base64') }))).toBe('bad_signature');
  });

  it('approve_changed: the card moved since it was read', async () => {
    const { k, c, card } = await setup();
    const ap = await answerWith(k, card, 'A');
    // subject in the signature is not the card's subject
    expect(code(await write(c, 'A: approve and ship', { ...ap, subject: sha256hex('something else') }))).toBe('approve_changed');
    // option text that is not one of the card's options
    expect(code(await write(c, 'A: approve and ship now', ap))).toBe('approve_changed');
    // the card's own approve being rewritten in the same write
    expect(code(await write(c, 'A: approve and ship', ap, { approve: { ...card.approve, subject: sha256hex('x') } }))).toBe('approve_changed');
    // a replacement that drops approve
    const { approve: _a, ...plain } = card;
    expect(code(await db(c, { op: 'set', collection: 'inbox', doc_id: CARD, data: plain }))).toBe('approve_changed');
    // approve cannot be bolted onto an existing card either
    expect(code(await db(c, { op: 'update', collection: 'inbox', doc_id: CARD, data: { approve: null } }))).toBe('approve_changed');
  });

  it('approve_unreadable: a card whose approve cannot be read is never answered', async () => {
    const k = await sillyKey();
    const c = await makeCtx({ keys: k.keys });
    for (const [i, bad] of [{ action: 'wire', subject: sha256hex('x') }, { action: 'fix', subject: 'short' }, 'yes', { action: 'fix' }].entries()) {
      const id = `bad-${i}`;
      await db(c, { op: 'set', collection: 'inbox', doc_id: id, data: { title: 't', options: ['A: yes'], approve: bad } });
      const r = await db(c, { op: 'update', collection: 'inbox', doc_id: id, data: { answer: 'A: yes' } });
      expect(r.status).toBe(422); expect(r.body.code).toBe('approve_unreadable');
    }
  });

  it('answer and approval are written atomically: an approval alone is refused, an answer alone is refused', async () => {
    const { k, c, card } = await setup();
    const ap = await answerWith(k, card, 'A');
    expect(code(await db(c, { op: 'update', collection: 'inbox', doc_id: CARD, data: { approval: ap } }))).toBe('needs_signature');
    expect(code(await write(c, 'A: approve and ship'))).toBe('needs_signature');
    const got = (await db(c, { op: 'get', collection: 'inbox', doc_id: CARD })).body.data;
    expect(got.answer).toBeUndefined(); expect(got.approval).toBeUndefined();
  });

  it('undo clears the approval with the answer, even if the write forgets it or tries to keep it', async () => {
    const { k, c, card } = await setup();
    const ap = await answerWith(k, card, 'A');
    await write(c, 'A: approve and ship', ap);
    const undo = await db(c, { op: 'update', collection: 'inbox', doc_id: CARD, data: { answer: null, answered: null } });
    expect(undo.status).toBe(200);
    let got = (await db(c, { op: 'get', collection: 'inbox', doc_id: CARD })).body.data;
    expect(got.answer).toBeNull(); expect(got.approval).toBeNull();
    // answered again, then "undone" with a smuggled approval: still cleared
    await write(c, 'A: approve and ship', await answerWith(k, card, 'A'));
    await db(c, { op: 'update', collection: 'inbox', doc_id: CARD, data: { answer: '', approval: ap } });
    got = (await db(c, { op: 'get', collection: 'inbox', doc_id: CARD })).body.data;
    expect(got.approval).toBeNull();
  });

  it('keeps the board letter W and approve/approval byte-for-byte, with no normalising', async () => {
    const k = await sillyKey();
    const c = await makeCtx({ keys: k.keys });
    // odd key order, unusual spacing inside strings, unicode: all must survive as written
    const approve = { subject: sha256hex('s'), action: 'fix', board: 'W', card_id: CARD, material: { b: 1, a: [3, 1, 2], note: '  spaced  é ' } };
    const card = { title: 'T', options: ['A: yes ', 'B: no'], approve, text: 'x' };
    await db(c, { op: 'set', collection: 'inbox', doc_id: CARD, data: card });
    const raw1 = String((await c.client.execute({ sql: 'SELECT data FROM docs WHERE collection = ? AND doc_id = ?', args: ['inbox', CARD] })).rows[0].data);
    expect(JSON.parse(raw1).approve).toEqual(approve);
    expect(JSON.stringify(JSON.parse(raw1).approve)).toBe(JSON.stringify(approve));
    const ap = await silly.sign({ store: k.store, board: 'W', item: { id: CARD, approve }, letter: 'A' });
    // the answer text is stored exactly as sent, trailing space included (the option itself has one)
    const r = await write(c, 'A: yes ', ap);
    expect(r.status).toBe(200);
    const raw2 = JSON.parse(String((await c.client.execute({ sql: 'SELECT data FROM docs WHERE collection = ? AND doc_id = ?', args: ['inbox', CARD] })).rows[0].data));
    expect(raw2.answer).toBe('A: yes ');
    expect(JSON.stringify(raw2.approval)).toBe(JSON.stringify(ap));
    expect(JSON.stringify(raw2.approve)).toBe(JSON.stringify(approve));
    expect(signedText({ board: 'W', card_id: CARD, subject: ap.subject, option: 'A', signed_at: ap.signed_at }).split('\n')[1]).toBe('W');
    // an unrelated update leaves both alone
    await db(c, { op: 'update', collection: 'inbox', doc_id: CARD, data: { seen: '2026-11-20T10:00:00Z' } });
    const raw3 = JSON.parse(String((await c.client.execute({ sql: 'SELECT data FROM docs WHERE collection = ? AND doc_id = ?', args: ['inbox', CARD] })).rows[0].data));
    expect(JSON.stringify(raw3.approval)).toBe(JSON.stringify(ap));
  });

  it('a card with no approve takes plain answers; any approval sent with it is dropped', async () => {
    const k = await sillyKey();
    const c = await makeCtx({ keys: k.keys });
    await db(c, { op: 'set', collection: 'inbox', doc_id: 'plain', data: { title: 'T', options: ['A: yes'] } });
    const r = await db(c, { op: 'update', collection: 'inbox', doc_id: 'plain', data: { answer: 'A: yes', approval: { junk: 1 } } });
    expect(r.status).toBe(200);
    expect((await db(c, { op: 'get', collection: 'inbox', doc_id: 'plain' })).body.data).toEqual({ title: 'T', options: ['A: yes'], answer: 'A: yes' });
  });

  it('other collections are not guarded, and writes that touch no approval fields pass', async () => {
    const { c } = await setup();
    expect((await db(c, { op: 'set', collection: 'tasks', doc_id: 'a', data: { answer: 'A: x', approve: 'not a card' } })).status).toBe(200);
    expect((await db(c, { op: 'update', collection: 'inbox', doc_id: CARD, data: { note: 'hello' } })).status).toBe(200);
  });

  it('only the four refusal codes exist', async () => {
    const { k, c, card } = await setup();
    const ap = await answerWith(k, card, 'A');
    const seen = new Set<string>();
    for (const r of [await write(c, 'A: approve and ship'), await write(c, 'A: approve and ship', { ...ap, sig: 'x' }),
      await write(c, 'A: approve and ship', { ...ap, subject: sha256hex('q') }), await write(c, 'A: approve and ship', { ...ap, signed_at: 'x' })]) seen.add(code(r));
    for (const s of seen) expect(['needs_signature', 'bad_signature', 'approve_changed', 'approve_unreadable']).toContain(s);
  });

  it('optionLetter reads the letter the way the bridge does', () => {
    expect(optionLetter('A: yes')).toBe('A'); expect(optionLetter(' B. no')).toBe('B'); expect(optionLetter('later')).toBeNull();
  });
});
