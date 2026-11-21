/**
 * Slack Web API with Ronnie's user token (SLACK_USER_TOKEN, xoxp-). Reads only, plus the one write the Work routines were
 * allowed to make: chat.postMessage into a thread (a chase, a thank-you, or a draft he tapped send on). Channels are always
 * read by ID. A missing scope is reported with the scope Slack says is needed, never with the token.
 */
export class SlackError extends Error {
  constructor(public code: string, public needed?: string, public status?: number) { super(code); }
}

export interface SlackMsg { ts: string; user?: string; text?: string; bot_id?: string; subtype?: string; thread_ts?: string; reply_count?: number }
export interface SlackAuth { ok: true; team_id?: string; user_id?: string; scopes: string[] }

export interface Slack {
  authTest(): Promise<SlackAuth>;
  history(channel: string, oldestSec: number, maxPages?: number): Promise<SlackMsg[]>;
  replies(channel: string, threadTs: string): Promise<SlackMsg[]>;
  /** One message of a channel, to prove the token can read it. Throws SlackError(code, needed) when it cannot. */
  probe(channel: string): Promise<void>;
  userName(id: string): Promise<string | null>;
  post(channel: string, threadTs: string, text: string): Promise<{ ts: string }>;
}

export function makeSlack(env: Record<string, string | undefined>, fetchImpl: typeof fetch = fetch): Slack | null {
  const token = env.SLACK_USER_TOKEN;
  if (!token) return null;
  async function call(method: string, params: Record<string, string | number> = {}, json?: unknown): Promise<{ data: any; scopes: string[] }> {
    for (let attempt = 0; ; attempt++) {
      const url = `https://slack.com/api/${method}`;
      const r = json === undefined
        ? await fetchImpl(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])), signal: AbortSignal.timeout(20_000) })
        : await fetchImpl(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(json), signal: AbortSignal.timeout(20_000) });
      if (r.status === 429 && attempt < 2) { await new Promise((res) => setTimeout(res, Math.min(10, Number(r.headers.get('retry-after')) || 2) * 1000)); continue; }
      const data: any = await r.json().catch(() => ({}));
      if (!data.ok) throw new SlackError(String(data.error ?? `http_${r.status}`), data.needed, r.status);
      return { data, scopes: String(r.headers.get('x-oauth-scopes') ?? '').split(',').map((s) => s.trim()).filter(Boolean) };
    }
  }
  const names = new Map<string, string | null>();
  return {
    async authTest() { const { data, scopes } = await call('auth.test'); return { ok: true, team_id: data.team_id, user_id: data.user_id, scopes }; },
    async history(channel, oldestSec, maxPages = 4) {
      const out: SlackMsg[] = []; let cursor = '';
      for (let p = 0; p < maxPages; p++) {
        const { data } = await call('conversations.history', { channel, oldest: oldestSec, limit: 100, ...(cursor ? { cursor } : {}) });
        out.push(...(data.messages ?? []));
        cursor = data.response_metadata?.next_cursor ?? '';
        if (!data.has_more || !cursor) break;
      }
      return out;
    },
    async probe(channel) { await call('conversations.history', { channel, limit: 1 }); },
    async replies(channel, threadTs) {
      const { data } = await call('conversations.replies', { channel, ts: threadTs, limit: 200 });
      return data.messages ?? [];
    },
    async userName(id) {
      if (names.has(id)) return names.get(id)!;
      let n: string | null = null;
      try { const { data } = await call('users.info', { user: id }); if (!data.user?.is_bot) n = data.user?.real_name || data.user?.profile?.real_name || data.user?.name || null; }
      catch (e) { if (e instanceof SlackError && e.code === 'missing_scope') names.set(id, null); else if (!(e instanceof SlackError)) throw e; }
      names.set(id, n);
      return n;
    },
    async post(channel, threadTs, text) {
      const { data } = await call('chat.postMessage', {}, { channel, thread_ts: threadTs, text, unfurl_links: false, unfurl_media: false });
      return { ts: String(data.ts) };
    },
  };
}

/** Initials from a display name ("Ada Lovelace" -> "AL"). Never the name itself. */
export function initialsOf(name: string | null | undefined): string | null {
  const w = String(name ?? '').trim().split(/[\s._-]+/).filter((x) => /^[A-Za-z]/.test(x));
  if (!w.length) return null;
  return (w.length === 1 ? w[0].slice(0, 2) : w[0][0] + w[w.length - 1][0]).toUpperCase();
}
