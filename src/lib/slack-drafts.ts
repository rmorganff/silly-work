/**
 * Saved Slack drafts (kudos replies). They live in the `slack_drafts` table, never on the board. Slack has no drafts API for a
 * user token, so a draft is sent only by an explicit tap: POST /api/slack-drafts {id, action: 'send'} from a device whose token
 * label is in SLACK_SEND_ACTORS (default "phone,chrome"). Sending posts the draft into its own thread, once.
 */
import type { Client } from '@libsql/client';
import { closeDraft } from './store';
import { makeSlack, SlackError } from './slack';

export const sendActors = (env: Record<string, string | undefined>) => String(env.SLACK_SEND_ACTORS ?? 'phone,chrome').split(',').map((s) => s.trim()).filter(Boolean);

export async function listPending(client: Client) {
  const r = await client.execute(`SELECT id, channel_id, thread_ts, kind, draft_text, context_summary, created_at FROM slack_drafts WHERE status = 'pending' ORDER BY created_at DESC LIMIT 50`);
  return r.rows.map((x) => ({ id: String(x.id), channel_id: String(x.channel_id), thread_ts: String(x.thread_ts), kind: String(x.kind), text: String(x.draft_text), context: String(x.context_summary), created_at: String(x.created_at) }));
}

export async function actOnDraft(client: Client, env: Record<string, string | undefined>, fetchImpl: typeof fetch, actor: string, body: any, now = new Date()): Promise<{ status: number; body: Record<string, unknown> }> {
  const id = String(body?.id ?? ''), action = String(body?.action ?? '');
  if (!['send', 'dismiss'].includes(action) || !id) return { status: 400, body: { error: 'bad_request', code: 'bad_request' } };
  const r = await client.execute({ sql: `SELECT channel_id, thread_ts, draft_text, status FROM slack_drafts WHERE id = ?`, args: [id] });
  if (!r.rows.length) return { status: 404, body: { error: 'not_found', code: 'not_found' } };
  if (String(r.rows[0].status) !== 'pending') return { status: 409, body: { error: 'not_pending', code: 'not_pending' } };
  if (action === 'dismiss') { await closeDraft(client, id, 'dismissed', now); return { status: 200, body: { ok: true, id, status: 'dismissed' } }; }
  if (!sendActors(env).includes(actor)) return { status: 403, body: { error: 'actor_not_allowed', code: 'actor_not_allowed' } };
  const slack = makeSlack(env, fetchImpl);
  if (!slack) return { status: 503, body: { error: 'slack_not_configured', code: 'slack_not_configured' } };
  // claim first: a second tap finds it no longer pending
  if (!(await closeDraft(client, id, 'sent', now))) return { status: 409, body: { error: 'not_pending', code: 'not_pending' } };
  try { await slack.post(String(r.rows[0].channel_id), String(r.rows[0].thread_ts), String(r.rows[0].draft_text)); }
  catch (e) {
    await client.execute({ sql: `UPDATE slack_drafts SET status = 'pending', sent_at = NULL, expires_at = NULL WHERE id = ?`, args: [id] }); // not posted: back to pending
    return { status: 502, body: { error: e instanceof SlackError ? e.code : 'slack_failed', code: 'slack_failed' } };
  }
  return { status: 200, body: { ok: true, id, status: 'sent' } };
}
