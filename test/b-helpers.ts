import crypto from 'node:crypto';
import { makeCtx } from './helpers';
import type { Slack, SlackMsg } from '../src/lib/slack';
import type { Monday, MBoard, MItem } from '../src/lib/monday';
import type { BriefDeps } from '../src/lib/brief';

export const MON = new Date('2026-11-23T07:45:00Z'); // Monday 07:45 London (GMT)

export interface FakeSlack extends Slack { posts: { channel: string; thread: string; text: string }[]; calls: string[] }
export function fakeSlack(o: { history?: Record<string, SlackMsg[]>; replies?: Record<string, SlackMsg[]>; names?: Record<string, string | null>; unreadable?: Record<string, string>; postFails?: boolean } = {}): FakeSlack {
  const posts: FakeSlack['posts'] = [], calls: string[] = [];
  return {
    posts, calls,
    async authTest() { return { ok: true, user_id: 'UCTAVAFSA', scopes: ['channels:history', 'groups:history', 'users:read', 'chat:write'] }; },
    async history(channel) { calls.push(`history ${channel}`); if (o.unreadable?.[channel]) { const { SlackError } = await import('../src/lib/slack'); throw new SlackError(o.unreadable[channel]); } return o.history?.[channel] ?? []; },
    async probe() { /* ok */ },
    async replies(channel, ts) { calls.push(`replies ${channel} ${ts}`); return o.replies?.[`${channel}/${ts}`] ?? []; },
    async userName(id) { return o.names?.[id] ?? null; },
    async post(channel, thread, text) { if (o.postFails) { const { SlackError } = await import('../src/lib/slack'); throw new SlackError('channel_not_found'); } posts.push({ channel, thread, text }); return { ts: '1.1' }; },
  };
}

export const mItem = (id: string, name: string, group: string, createdDaysAgo: number, updatedDaysAgo: number, cols: Record<string, string> = {}, now = MON): MItem => ({
  id, name, created_at: new Date(now.getTime() - createdDaysAgo * 864e5).toISOString(), updated_at: new Date(now.getTime() - updatedDaysAgo * 864e5).toISOString(),
  group: { id: group.toLowerCase(), title: group }, columns: Object.entries(cols).map(([title, text]) => ({ id: title.toLowerCase(), title, type: 'text', text })),
});
export function fakeMonday(boards: MBoard[], failIds: string[] = []): Monday & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async me() { return { id: '1' }; },
    async listBoards() { return boards.map((b) => ({ id: b.id, name: b.name })); },
    async board(id) { calls.push(id); if (failIds.includes(id)) { const { MondayError } = await import('../src/lib/monday'); throw new MondayError('ComplexityException'); } return boards.find((b) => b.id === id)!; },
  };
}
export const mBoard = (id: string, name: string, items: MItem[]): MBoard => ({ id, name, groups: [], items, truncated: false });

type Handler = (input: any) => any;
/** A fetch that answers the Anthropic API from per-tool handlers (or an error status), and records ntfy pushes. */
export function routerFetch(handlers: Record<string, Handler | number> = {}) {
  const llm: { tool: string; model: string }[] = [], pushes: string[] = [];
  const fetchImpl = (async (url: any, init: any) => {
    const u = String(url);
    if (u.includes('api.anthropic.com')) {
      const body = JSON.parse(init.body);
      const tool = body.tools?.[0]?.name ?? 'none';
      llm.push({ tool, model: body.model });
      const h = handlers[tool];
      if (typeof h === 'number') return new Response('{}', { status: h });
      if (!h) return new Response('{}', { status: 500 });
      return new Response(JSON.stringify({ content: [{ type: 'tool_use', name: tool, input: h({ user: String(body.messages[0].content), system: String(body.system) }) }] }), { status: 200 });
    }
    pushes.push(u);
    return new Response('', { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, llm, pushes };
}

export async function worldB(over: { slack?: Slack | null; monday?: Monday | null; handlers?: Record<string, Handler | number>; key?: boolean; start?: Date } = {}) {
  const ctx = await makeCtx();
  const clock = { now: over.start ?? MON };
  const { fetchImpl, llm, pushes } = routerFetch(over.handlers);
  const env: Record<string, string> = { WORK_NTFY_URL: 'https://ntfy.test/x', WORK_NTFY_KEY: crypto.randomBytes(32).toString('base64'), SILLY_WORK_SITE_URL: 'https://w.test', SILLY_WORK_TRIGGER_SECRET: 'sec-1' };
  if (over.key !== false) env.ANTHROPIC_API_KEY = 'sk-test';
  const deps: BriefDeps = { ctx, now: () => clock.now, fetchImpl, env, slack: over.slack === undefined ? null : over.slack, monday: over.monday === undefined ? null : over.monday };
  return { ctx, deps, clock, llm, pushes, advance: (ms: number) => { clock.now = new Date(clock.now.getTime() + ms); }, at: (iso: string) => { clock.now = new Date(iso); } };
}
