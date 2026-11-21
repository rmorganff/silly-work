/**
 * A read-only smoke test of every outside connection, for POST /api/smoke (bearer token). It answers booleans, ids, scope names
 * and error codes: never a token, never a message, never an item. Slack and monday.com are only read; the model is called
 * (one tiny Haiku request) only when the body says {llm: true}.
 */
import { makeSlack, SlackError } from './slack';
import { makeMonday, MondayError } from './monday';
import { CHANNELS, RONNIE_SLACK, RETAIL_BOARD_ID, LP_BOARD_ID } from './channels';
import { siteUrlFrom } from './background';
import { isRecruitmentBoard } from './brief';
import { modelFor } from './llm';

export const REQUIRED_SLACK_SCOPES = ['channels:history', 'groups:history', 'users:read', 'chat:write'];
export const LATER_SLACK_SCOPES = ['files:write'];
const ENV_NAMES = ['TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN', 'SILLY_WORK_API_TOKEN', 'SLACK_USER_TOKEN', 'MONDAY_API_TOKEN', 'ANTHROPIC_API_KEY', 'SILLY_WORK_SITE_URL', 'SILLY_WORK_TRIGGER_SECRET', 'WORK_NTFY_URL', 'WORK_NTFY_KEY'];
const code = (e: any) => (e instanceof SlackError || e instanceof MondayError ? e.code : String(e?.name || 'error'));

export async function smoke(env: Record<string, string | undefined>, fetchImpl: typeof fetch, opts: { llm?: boolean } = {}) {
  const out: Record<string, any> = { env: Object.fromEntries(ENV_NAMES.map((n) => [n, !!env[n]])) };
  const site = siteUrlFrom(env.SILLY_WORK_SITE_URL);
  out.background = { site_url_ok: !!site, site_host: site ? new URL(site).host : null, secret_set: !!env.SILLY_WORK_TRIGGER_SECRET, ready: !!site && !!env.SILLY_WORK_TRIGGER_SECRET };

  const slack = makeSlack(env, fetchImpl);
  if (!slack) out.slack = { configured: false };
  else {
    const s: Record<string, any> = { configured: true };
    try {
      const a = await slack.authTest();
      s.auth = true; s.team_id = a.team_id; s.user_is_ronnie = a.user_id === RONNIE_SLACK; s.scopes = a.scopes;
      s.scopes_known = a.scopes.length > 0;
      s.missing_scopes = a.scopes.length ? REQUIRED_SLACK_SCOPES.filter((x) => !a.scopes.includes(x)) : null;
      s.later_scopes_missing = a.scopes.length ? LATER_SLACK_SCOPES.filter((x) => !a.scopes.includes(x)) : null;
    } catch (e) { s.auth = false; s.error = code(e); }
    if (s.auth) {
      const ch: Record<string, string> = {}; let ok = 0;
      for (const c of CHANNELS) { try { await slack.probe(c.id); ch[c.name] = 'ok'; ok++; } catch (e) { ch[c.name] = e instanceof SlackError ? `${e.code}${e.needed ? ` (needs ${e.needed})` : ''}` : code(e); } }
      s.channels_readable = `${ok} of ${CHANNELS.length}`; s.channels = ch;
      try { s.users_info = (await slack.userName(RONNIE_SLACK)) ? 'ok' : 'no_name'; } catch (e) { s.users_info = code(e); }
    }
    out.slack = s;
  }

  const monday = makeMonday(env, fetchImpl);
  if (!monday) out.monday = { configured: false };
  else {
    const m: Record<string, any> = { configured: true };
    try {
      m.me = (await monday.me()).id ? 'ok' : 'no_id'; m.auth = true;
      const boards = await monday.listBoards();
      m.boards = boards.length;
      m.recruitment_boards = boards.filter((b) => isRecruitmentBoard(b.name)).map((b) => ({ id: b.id, name: b.name }));
      m.retail_board = boards.some((b) => b.id === RETAIL_BOARD_ID);
      m.loss_prevention_board = boards.some((b) => b.id === LP_BOARD_ID);
    } catch (e) { m.auth = m.auth ?? false; m.error = code(e); }
    out.monday = m;
  }

  const a: Record<string, any> = { configured: !!env.ANTHROPIC_API_KEY };
  if (opts.llm && env.ANTHROPIC_API_KEY) {
    try {
      const model = modelFor('haiku', env);
      const r = await fetchImpl('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: 'user', content: 'Reply with the word ok.' }] }), signal: AbortSignal.timeout(30_000) });
      a.call = r.ok ? 'ok' : `http_${r.status}`; a.model = model;
    } catch (e) { a.call = code(e); }
  }
  out.anthropic = a;
  out.ok = !!out.slack?.auth && !!out.monday?.auth && a.configured && out.background.ready && !(out.slack?.missing_scopes?.length);
  return out;
}
