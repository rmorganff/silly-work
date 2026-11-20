import { describe, it, expect, afterEach } from 'vitest';
import { scrubDoc, ScrubRejected, LOSJEFES_ID } from '../src/lib/scrub';
import { makeCtx, db } from './helpers';

const rejects = (collection: string, data: any, rule: string, id = 'd') => {
  try { scrubDoc(collection, id, data); } catch (e) { expect(e).toBeInstanceOf(ScrubRejected); expect((e as ScrubRejected).rule).toBe(rule); return; }
  throw new Error(`expected ${rule} to be rejected: ${JSON.stringify(data)}`);
};

afterEach(() => { delete process.env.PII_NAME_DENYLIST; delete process.env.PII_ALLOW_DOCS; });

describe('names', () => {
  it('rejects a first name, a full name, an honorific, a name with an initial', () => {
    rejects('inbox', { text: 'Sarah asked about the rota' }, 'person_name');
    rejects('inbox', { text: 'Spoke to Mark Jones today' }, 'person_name');
    rejects('inbox', { title: 'Mrs Patel called' }, 'person_name');
    rejects('digest', { lines: ['Raj K. is waiting'] }, 'person_name');
    rejects('tasks', { detail: { nested: ['ok', 'Call Emma back'] } }, 'person_name');
  });
  it('allows initials, counts, channel ids and ordinary capitalised words', () => {
    const ok = { title: 'Work Board shift', text: 'RJ has 3 open, TM has 2. Retail 14 vacancies. Walsall, Dudley.', channel: 'C0101QQN8SY' };
    expect(scrubDoc('digest', 'live', ok)).toEqual({ data: ok, stripped: [] });
  });
  it('honours a deployment name denylist (env) without hardcoding names in the repo', () => {
    process.env.PII_NAME_DENYLIST = 'Zxqvt, Plimmer';
    rejects('inbox', { text: 'plimmer is off' }, 'person_name');
  });
  it('strips person, applicant and subitem keys rather than storing them', () => {
    const r = scrubDoc('digest', 'recruit', { count: 4, applicant_name: 'x', Applicants: ['a'], subitems: [{ id: 1380722202 }], first_name: 'x', board: 'Retail' });
    expect(r.data).toEqual({ count: 4, board: 'Retail' });
    expect(r.stripped.sort()).toEqual(['$.Applicants', '$.applicant_name', '$.first_name', '$.subitems']);
  });
  it('PII_ALLOW_DOCS opts one named document out', () => {
    process.env.PII_ALLOW_DOCS = 'meta/reviewers';
    const d = { text: 'Sarah reviews' };
    expect(scrubDoc('meta', 'reviewers', d).data).toEqual(d);
    rejects('meta', d, 'person_name', 'other');
  });
});

describe('losjefes', () => {
  const ch = { channel_id: LOSJEFES_ID };
  it('drops anything about an individual: performance, conduct, health, personal circumstances', () => {
    rejects('digest', { ...ch, text: 'Performance concerns in the east team' }, 'losjefes_individual');
    rejects('digest', { ...ch, text: 'disciplinary hearing booked' }, 'losjefes_individual');
    rejects('digest', { ...ch, text: 'off sick again this week' }, 'losjefes_individual');
    rejects('digest', { ...ch, text: 'family issues at home' }, 'losjefes_individual');
    rejects('slack', { source: 'losjefes', q: 'late again, attitude problem' }, 'losjefes_individual');
  });
  it('keeps decisions, numbers and questions', () => {
    const d = { ...ch, text: 'Decision: Christmas rota goes live Monday. 12 stores confirmed. Who owns the stock count?' };
    expect(scrubDoc('digest', 'slack', d).data).toEqual(d);
  });
});

describe('personal circumstances anywhere', () => {
  it('rejects health or conduct talk that points at a person', () => {
    rejects('inbox', { text: 'she has been signed off sick' }, 'personal_sensitive');
    rejects('inbox', { text: 'his conduct at the depot' }, 'personal_sensitive');
  });
  it('lets the same words through when they describe a process, not a person', () => {
    const d = { text: 'Update the sickness absence policy and the disciplinary process doc' };
    expect(scrubDoc('inbox', 'x', d).data).toEqual(d);
  });
});

describe('Auror: counts and locations only', () => {
  it('rejects narratives, however short or long', () => {
    rejects('digest', { board: 8247581349, text: 'Offender took three bottles and ran out of the store' }, 'auror_narrative');
    rejects('digest', { channel_id: 'C06MA3XB6M6', text: 'CCTV footage shows the suspect leaving' }, 'auror_narrative');
    rejects('digest', { source: 'Auror', summary: 'x'.repeat(200) }, 'auror_narrative');
  });
  it('lets counts and locations through', () => {
    const d = { source: 'Auror', week: '2026-W47', incidents: 14, by_location: { Walsall: 3, Dudley: 4, Wolverhampton: 7 } };
    expect(scrubDoc('digest', 'auror', d).data).toEqual(d);
  });
});

describe('signed and machine fields are never touched', () => {
  it('leaves approve, approval and silly_wid exactly as they came', () => {
    const d = { approve: { action: 'fix', subject: 'a'.repeat(64), material: { reply: 'Emma' } }, approval: { sig: 'Sarah' }, silly_wid: 'wid-000001', note: 'ok' };
    expect(scrubDoc('inbox', 'c', d).data).toEqual(d);
  });
});

describe('middleware: rejected before anything reaches docs', () => {
  it('returns 422 scrub_rejected with the rule only, writes nothing, and audits rule + target without the text', async () => {
    const c = await makeCtx();
    const r = await db(c, { op: 'set', collection: 'inbox', doc_id: 'c1', data: { text: 'Chat with Sarah about the missed shift' } });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ code: 'scrub_rejected', rule: 'person_name' });
    expect(JSON.stringify(r.body)).not.toContain('Sarah');
    expect((await db(c, { op: 'get', collection: 'inbox', doc_id: 'c1' })).body.exists).toBe(false);
    const n = await c.client.execute('SELECT COUNT(*) AS n FROM docs');
    expect(Number(n.rows[0].n)).toBe(0);
    const a = await c.client.execute('SELECT action, target FROM audit_log');
    expect(a.rows.map(x => ({ ...x }))).toEqual([{ action: 'scrub_rejected:person_name', target: 'inbox/c1' }]);
    expect(JSON.stringify(a.rows)).not.toContain('Sarah');
  });
  it('strips person keys on the way in, and checks updates too', async () => {
    const c = await makeCtx();
    await db(c, { op: 'set', collection: 'digest', doc_id: 'r', data: { count: 2, applicant_name: 'x' } });
    expect((await db(c, { op: 'get', collection: 'digest', doc_id: 'r' })).body.data).toEqual({ count: 2 });
    expect((await db(c, { op: 'update', collection: 'digest', doc_id: 'r', data: { note: 'Mark Jones rang' } })).status).toBe(422);
    expect((await db(c, { op: 'add', collection: 'digest', data: { channel_id: LOSJEFES_ID, text: 'he is ill' } })).status).toBe(422);
  });
});
