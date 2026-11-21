import { describe, it, expect } from 'vitest';
import { callTool, modelFor, assertAllowedModel, reserve, DEFAULT_CAPS } from '../src/lib/llm';
import { makeSlack, SlackError, initialsOf } from '../src/lib/slack';
import { makeMonday, MondayError } from '../src/lib/monday';
import { pickWins, draftOk, kudosDrafts, proposal, fridayLlm } from '../src/lib/friday-llm';
import { runFridayReview } from '../src/lib/friday-review';
import { listPending, actOnDraft } from '../src/lib/slack-drafts';
import { smoke } from '../src/lib/smoke';
import { siteUrlFrom, startBackground } from '../src/lib/background';
import { handleTrigger } from '../src/lib/trigger';
import { handleBackground, setScheduledDepsForTests } from '../src/lib/scheduled';
import { worldB, fakeSlack, fakeMonday, mBoard, MON } from './b-helpers';
import { put, get } from './jobs-helpers';

const TOOL = { name: 't', description: 'd', input_schema: { type: 'object', properties: {} } };

describe('model wrapper', () => {
  it('never lets a schedule run on Fable or Mythos, whatever the setting says', () => {
    expect(() => assertAllowedModel('claude-fable-5-2')).toThrow('model_not_allowed');
    expect(() => modelFor('sonnet', { WORK_SONNET_MODEL: 'mythos-x' })).toThrow('model_not_allowed');
    expect(modelFor('haiku', {})).toBe('claude-haiku-5-5');
    expect(modelFor('sonnet', {})).toBe('claude-sonnet-5-5');
  });

  it('a forbidden model, no key, a spent cap, an error status and a bad reply all give null and never throw; the cap is per tier per day', async () => {
    const bad = await worldB({ handlers: {} });
    bad.deps.env.WORK_SONNET_MODEL = 'fable-9';
    expect(await callTool(bad.deps, 'sonnet', { system: 's', user: 'u', tool: TOOL })).toBeNull();
    expect(bad.llm).toEqual([]);                                   // no request was even made
    const nokey = await worldB({ key: false });
    expect(await callTool(nokey.deps, 'haiku', { system: 's', user: 'u', tool: TOOL })).toBeNull();
    const w = await worldB({ handlers: { t: () => ({ ok: 1 }) } });
    w.deps.env.WORK_SONNET_DAILY_CAP = '2';
    expect(await callTool(w.deps, 'sonnet', { system: 's', user: 'u', tool: TOOL })).toEqual({ ok: 1 });
    expect(await callTool(w.deps, 'sonnet', { system: 's', user: 'u', tool: TOOL })).toEqual({ ok: 1 });
    expect(await callTool(w.deps, 'sonnet', { system: 's', user: 'u', tool: TOOL })).toBeNull();   // cap used up
    expect(w.llm).toHaveLength(2);
    expect(await callTool(w.deps, 'haiku', { system: 's', user: 'u', tool: TOOL })).toEqual({ ok: 1 }); // another tier has its own allowance
    w.advance(86_400_000);
    expect(await reserve(w.deps, 'sonnet')).toBe(true);            // a new day
    expect(DEFAULT_CAPS).toEqual({ haiku: 200, sonnet: 30 });
    const err = await worldB({ handlers: { t: 500 } });
    expect(await callTool(err.deps, 'haiku', { system: 's', user: 'u', tool: TOOL })).toBeNull();
    expect((await get(err.ctx, 'meta', 'llm-usage')).data.failed).toBe(1);
  });
});

describe('Slack client', () => {
  const res = (body: any, headers: Record<string, string> = {}, status = 200) => new Response(JSON.stringify(body), { status, headers });
  it('reads scopes from the response header, pages history, and reports the scope Slack says is missing; the token is only in the header', async () => {
    const seen: { url: string; auth: string; body: string }[] = [];
    let page = 0;
    const f = (async (url: any, init: any) => {
      seen.push({ url: String(url), auth: init.headers.authorization, body: String(init.body) });
      if (String(url).endsWith('auth.test')) return res({ ok: true, user_id: 'U1', team_id: 'T1' }, { 'x-oauth-scopes': 'channels:history, users:read' });
      if (String(url).endsWith('conversations.history') && String(init.body).includes('C2')) return res({ ok: false, error: 'missing_scope', needed: 'groups:history' });
      if (String(url).endsWith('conversations.history')) return page++ === 0 ? res({ ok: true, messages: [{ ts: '2' }], has_more: true, response_metadata: { next_cursor: 'c' } }) : res({ ok: true, messages: [{ ts: '1' }], has_more: false });
      return res({ ok: false, error: 'missing_scope', needed: 'groups:history' });
    }) as unknown as typeof fetch;
    const s = makeSlack({ SLACK_USER_TOKEN: 'xoxp-secret' }, f)!;
    expect(await s.authTest()).toMatchObject({ user_id: 'U1', scopes: ['channels:history', 'users:read'] });
    expect((await s.history('C1', 1)).map((m) => m.ts)).toEqual(['2', '1']);
    await expect(s.probe('C2')).rejects.toMatchObject({ code: 'missing_scope', needed: 'groups:history' });
    expect(seen.every((x) => x.auth === 'Bearer xoxp-secret' && !x.url.includes('xoxp') && !x.body.includes('xoxp'))).toBe(true);
    expect(makeSlack({}, f)).toBeNull();
    expect(initialsOf('Ada Lovelace')).toBe('AL');
    expect(initialsOf('Ada Byron Lovelace')).toBe('AL');
    expect(initialsOf('')).toBeNull();
  });
});

describe('monday client', () => {
  it('only ever sends queries: a mutation is refused before it leaves the process', async () => {
    let calls = 0;
    const f = (async () => { calls++; return new Response(JSON.stringify({ data: { me: { id: 7 } } })); }) as unknown as typeof fetch;
    const m = makeMonday({ MONDAY_API_TOKEN: 't' }, f)!;
    expect(await m.me()).toEqual({ id: '7' });
    const src = (await import('node:fs')).readFileSync(new URL('../src/lib/monday.ts', import.meta.url), 'utf8');
    expect(/\bmutation\b/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/read-only|mutation anywhere/g, ''))).toBe(false);
    expect(calls).toBe(1);
    expect(makeMonday({}, f)).toBeNull();
  });
  it('pages items and reports an API error as a code', async () => {
    let n = 0;
    const f = (async (_u: any, init: any) => {
      const q = JSON.parse(init.body).query as string;
      if (q.includes('next_items_page')) return new Response(JSON.stringify({ data: { next_items_page: { cursor: null, items: [{ id: 2, name: 'b', created_at: 'x', updated_at: 'y', group: { id: 'g', title: 'G' }, column_values: [] }] } } }));
      n++;
      return n === 1 ? new Response(JSON.stringify({ data: { boards: [{ id: 1, name: 'B', groups: [], items_page: { cursor: 'c', items: [{ id: 1, name: 'a', created_at: 'x', updated_at: 'y', group: null, column_values: [{ id: 'c1', type: 'text', text: 'v', column: { title: 'Shop' } }] }] } }] } }))
        : new Response(JSON.stringify({ errors: [{ message: 'x', extensions: { code: 'ComplexityException' } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const m = makeMonday({ MONDAY_API_TOKEN: 't' }, f)!;
    const b = await m.board('1');
    expect(b.items.map((i) => i.id)).toEqual(['1', '2']);
    expect(b.items[0].columns[0]).toMatchObject({ title: 'Shop', text: 'v' });
    await expect(m.board('1')).rejects.toBeInstanceOf(MondayError);
  });
});

const win = (who: string, ch: string, ts: string, day = '2026-11-20') => ({ who, channel_id: ch, ts, day, where: 'recruitment-retail', what: 'ran the new shop interviews' });

describe('Friday: kudos drafts and the proposal', () => {
  it('picks at most three wins, one per person, newest first, preferring different channels; old wins are ignored', () => {
    const picked = pickWins([win('AB', 'C1', '5'), win('AB', 'C2', '9'), win('CD', 'C2', '8'), win('EF', 'C3', '7'), win('GH', 'C4', '6'), win('XX', 'C1', '10', '2026-11-01')], MON);
    expect(picked.map((w) => w.who)).toEqual(['AB', 'EF', 'GH']);
    expect(picked.map((w) => w.ts)).toEqual(['9', '7', '6']);
  });

  it('a draft is kept only if it is plain: no emoji, no exclamation mark, short', () => {
    expect(draftOk('Thanks for running the new shop interviews, it let us fill the vacancy sooner.')).toBe(true);
    expect(draftOk('Great job!')).toBe(false);
    expect(draftOk('Thanks for the work on the interviews 🎉 really good.')).toBe(false);
    expect(draftOk('x'.repeat(400))).toBe(false);
  });

  it('saves drafts in slack_drafts (never on the board), once, and raises a card that carries no draft words', async () => {
    const w = await worldB({ handlers: { drafts: () => ({ drafts: [{ n: 1, text: 'Thanks for running the new shop interviews, it let us fill the vacancy sooner.' }, { n: 2, text: 'Well done!' }] }) } });
    await put(w.ctx, 'digest', 'wins', { updated: '2026-11-21T10:00:00Z', items: [win('AB', 'C1', '9'), win('CD', 'C2', '8')] });
    const k = await kudosDrafts(w.deps, w.deps.now());
    expect(k.saved).toBe(1);                                          // the second draft had an exclamation mark
    const rows = await listPending(w.ctx.client);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel_id: 'C1', thread_ts: '9', kind: 'kudos' });
    expect((await kudosDrafts(w.deps, w.deps.now())).saved).toBe(0);  // same id: not saved twice
    const f = await fridayLlm(w.deps, [{ title: 'Tasks', text: '1 done.' }]);
    expect(f).toMatchObject({ kudosCard: null });                     // already saved, so no second card
    const wins = JSON.stringify((await w.ctx.client.execute(`SELECT data FROM docs`)).rows);
    expect(wins).not.toContain('Thanks for running');                 // draft words are never on the board
  });

  it('proposes one thing, once a day, as a card whose Source says Friday review', async () => {
    const w = await worldB({ handlers: { propose: () => ({ kind: 'proposal', title: 'Retire the sweep', question: 'Retire the daily sweep?', why: 'It flags nothing new.', cost: 'saves 5 runs a week', full: 'Retire the daily sweep because the health check covers it.' }) } });
    const p = await proposal(w.deps, [{ title: 'Tasks', text: '1 done.' }], w.deps.now());
    expect(p.card).toBe('proposal-2026-11-23');
    const c = (await get(w.ctx, 'inbox', 'proposal-2026-11-23')).data;
    expect(c).toMatchObject({ title: 'Proposal: Retire the sweep', options: ['A: yes, do it', 'B: no', 'C: later'], source: 'friday-review' });
    expect(c.details[0]).toEqual({ h: 'Source', text: 'Friday review 2026-11-23' });
    expect((await proposal(w.deps, [], w.deps.now())).why).toBe('already one today');
    expect(w.llm).toHaveLength(1);
  });

  it('the Friday review without a model key still does its deterministic half', async () => {
    const w = await worldB({ key: false, start: new Date('2026-11-20T15:45:00Z') });
    const r = await runFridayReview(w.deps);
    expect(r.llm).toEqual({ skipped: 'no_api_key' });
    expect(r.card?.created).toBe(true);
  });
});

describe('Slack drafts: sending is a tap', () => {
  const seed = async () => {
    const w = await worldB({ slack: fakeSlack() });
    await w.ctx.client.execute({ sql: `INSERT INTO slack_drafts (id, channel_id, thread_ts, kind, draft_text, context_summary, status, created_at) VALUES ('d1','C1','9.1','kudos','Thanks for the interviews work.','win by AB','pending','2026-11-20T15:50:00Z')`, args: [] });
    return w;
  };
  const posted: any[] = [];
  const slackFetch = (async (url: any, init: any) => { posted.push({ url: String(url), body: JSON.parse(init.body) }); return new Response(JSON.stringify({ ok: true, ts: '1.2' })); }) as unknown as typeof fetch;

  it('only a device on the allowed list can send; it posts once into the thread; a second tap is refused; dismiss needs no Slack', async () => {
    const w = await seed();
    const env = { SLACK_USER_TOKEN: 'xoxp-x' };
    expect((await actOnDraft(w.ctx.client, env, slackFetch, 'claude-chat', { id: 'd1', action: 'send' })).status).toBe(403);
    expect(posted).toHaveLength(0);
    expect((await actOnDraft(w.ctx.client, env, slackFetch, 'phone', { id: 'd1', action: 'send' })).body).toMatchObject({ ok: true, status: 'sent' });
    expect(posted).toEqual([{ url: 'https://slack.com/api/chat.postMessage', body: { channel: 'C1', thread_ts: '9.1', text: 'Thanks for the interviews work.', unfurl_links: false, unfurl_media: false } }]);
    expect((await actOnDraft(w.ctx.client, env, slackFetch, 'phone', { id: 'd1', action: 'send' })).status).toBe(409);
    expect(await listPending(w.ctx.client)).toEqual([]);
    const w2 = await seed();
    expect((await actOnDraft(w2.ctx.client, {}, slackFetch, 'anyone', { id: 'd1', action: 'dismiss' })).body).toMatchObject({ status: 'dismissed' });
  });

  it('a failed post puts the draft back to pending', async () => {
    const w = await seed();
    const failing = (async () => new Response(JSON.stringify({ ok: false, error: 'channel_not_found' }))) as unknown as typeof fetch;
    const r = await actOnDraft(w.ctx.client, { SLACK_USER_TOKEN: 'xoxp-x' }, failing, 'phone', { id: 'd1', action: 'send' });
    expect(r.status).toBe(502);
    expect(await listPending(w.ctx.client)).toHaveLength(1);
  });
});

describe('smoke test', () => {
  it('reports booleans, scopes and codes, never a token or a message; flags a missing scope and an unreadable channel', async () => {
    const env = { SLACK_USER_TOKEN: 'xoxp-SECRET1', MONDAY_API_TOKEN: 'MONDAYSECRET2', ANTHROPIC_API_KEY: 'sk-SECRET3', SILLY_WORK_SITE_URL: '[https://w.test](https://w.test)', SILLY_WORK_TRIGGER_SECRET: 'SECRET4' };
    const f = (async (url: any, init: any) => {
      const u = String(url);
      if (u.endsWith('auth.test')) return new Response(JSON.stringify({ ok: true, user_id: 'UCTAVAFSA', team_id: 'T1' }), { headers: { 'x-oauth-scopes': 'channels:history,users:read,chat:write' } });
      if (u.endsWith('conversations.history')) { const ch = String(init.body).includes('C0692KPGJUR') ? 'not_in_channel' : null; return ch ? new Response(JSON.stringify({ ok: false, error: ch })) : new Response(JSON.stringify({ ok: true, messages: [] })); }
      if (u.endsWith('users.info')) return new Response(JSON.stringify({ ok: true, user: { real_name: 'Ronnie X' } }));
      if (u.includes('monday.com')) return new Response(JSON.stringify({ data: JSON.parse(init.body).query.includes('me {') ? { me: { id: 1 } } : { boards: [{ id: 1232451925, name: 'Retail' }, { id: 5, name: 'Retail Recruitment' }, { id: 6, name: 'Recruitment OLD' }] } }));
      return new Response(JSON.stringify({ content: [] }));
    }) as unknown as typeof fetch;
    const out = await smoke(env, f, { llm: true });
    expect(out.slack).toMatchObject({ auth: true, user_is_ronnie: true, missing_scopes: ['groups:history'], later_scopes_missing: ['files:write'], channels_readable: '16 of 17' });
    expect(out.slack.channels.losjefes).toBe('not_in_channel');
    expect(out.monday).toMatchObject({ auth: true, boards: 3, retail_board: true, loss_prevention_board: false, recruitment_boards: [{ id: '5', name: 'Retail Recruitment' }] });
    expect(out.background).toEqual({ site_url_ok: true, site_host: 'w.test', secret_set: true, ready: true });
    expect(out.ok).toBe(false);                                      // a required scope is missing
    expect(JSON.stringify(out)).not.toMatch(/xoxp-SECRET1|MONDAYSECRET2|sk-SECRET3|SECRET4/);
    const none = await smoke({}, f);
    expect(none.slack).toEqual({ configured: false });
    expect(none.env.SLACK_USER_TOKEN).toBe(false);
  });
});

describe('background jobs', () => {
  it('accepts a pasted markdown link as the site address', () => {
    expect(siteUrlFrom('[https://silly-work.netlify.app](https://silly-work.netlify.app)')).toBe('https://silly-work.netlify.app');
    expect(siteUrlFrom('https://x.test/')).toBe('https://x.test');
    expect(siteUrlFrom('')).toBeNull();
  });

  it('a start goes to the job’s background function with the secret; unset settings, an error status and an unreachable site are reasons, not throws', async () => {
    const def = (await import('../src/lib/job-defs')).JOB_DEFS.find((j) => j.id === 'trig_weekbrief')!;
    const calls: any[] = [];
    const ok = (async (u: any, i: any) => { calls.push({ u: String(u), secret: i.headers['x-silly-trigger-secret'], body: JSON.parse(i.body) }); return new Response('', { status: 202 }); }) as unknown as typeof fetch;
    expect(await startBackground(def, { SILLY_WORK_SITE_URL: 'https://w.test', SILLY_WORK_TRIGGER_SECRET: 's' }, ok, 'schedule')).toEqual({ started: true, reason: 'ok' });
    expect(calls[0]).toEqual({ u: 'https://w.test/.netlify/functions/week-brief-background', secret: 's', body: { trigger_id: 'trig_weekbrief', source: 'schedule' } });
    expect((await startBackground(def, {}, ok, 'fire')).reason).toBe('background_not_configured');
    expect((await startBackground(def, { SILLY_WORK_SITE_URL: 'https://w.test', SILLY_WORK_TRIGGER_SECRET: 's' }, (async () => new Response('', { status: 503 })) as any, 'fire')).reason).toBe('status_503');
    expect((await startBackground(def, { SILLY_WORK_SITE_URL: 'https://w.test', SILLY_WORK_TRIGGER_SECRET: 's' }, (async () => { throw new Error('x'); }) as any, 'fire')).reason).toBe('unreachable');
  });

  it('fire_trigger on a long job starts its background function, records "started" as the cooldown, and refuses a second fire', async () => {
    const w = await worldB({ slack: fakeSlack() });
    const starts: string[] = [];
    w.deps.fetchImpl = (async (u: any) => { starts.push(String(u)); return new Response('', { status: 202 }); }) as any;
    const a = await handleTrigger(w.deps, { tool: 'fire_trigger', args: { trigger_id: 'trig_weekbrief' } });
    expect(a.body).toMatchObject({ fired: true, status: 'started' });
    expect(starts).toEqual(['https://w.test/.netlify/functions/week-brief-background']);
    expect((await get(w.ctx, '_trigger_runs', 'trig_weekbrief')).data.status).toBe('started');
    expect((await handleTrigger(w.deps, { tool: 'fire_trigger', args: { trigger_id: 'trig_weekbrief' } })).body).toMatchObject({ code: 'rate_limited' });
    const dead = await worldB();
    dead.deps.env.SILLY_WORK_SITE_URL = '';
    expect((await handleTrigger(dead.deps, { tool: 'fire_trigger', args: { trigger_id: 'trig_chase' } })).body).toMatchObject({ fired: false, code: 'background_not_configured' });
    expect((await get(dead.ctx, '_trigger_runs', 'trig_chase')).data.status).toBe('failed');
  });

  it('the background function refuses a wrong or missing secret and runs the job with the right one', async () => {
    const w = await worldB({ slack: fakeSlack(), monday: fakeMonday([mBoard('1232451925', 'Retail', [])]), key: false });
    setScheduledDepsForTests(w.deps);
    try {
      process.env.SILLY_WORK_TRIGGER_SECRET = 'right';
      const req = (secret?: string) => new Request('https://w.test/x', { method: 'POST', headers: secret ? { 'x-silly-trigger-secret': secret } : {}, body: '{}' });
      expect((await handleBackground(req(), 'trig_weekbrief')).status).toBe(401);
      expect((await handleBackground(req('wrong'), 'trig_weekbrief')).status).toBe(401);
      expect((await get(w.ctx, '_trigger_runs', 'trig_weekbrief')).exists).toBe(false);
      expect((await handleBackground(req('right'), 'trig_weekbrief')).status).toBe(202);
      expect((await get(w.ctx, '_trigger_runs', 'trig_weekbrief')).data.status).toBe('ok');
      expect((await handleBackground(new Request('https://w.test/x'), 'trig_weekbrief')).status).toBe(405);
      delete process.env.SILLY_WORK_TRIGGER_SECRET;
      expect((await handleBackground(req('right'), 'trig_weekbrief')).status).toBe(503);
    } finally { setScheduledDepsForTests(null); delete process.env.SILLY_WORK_TRIGGER_SECRET; }
  });
});
