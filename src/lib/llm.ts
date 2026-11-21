/**
 * The Anthropic API for the Work jobs: direct API with ANTHROPIC_API_KEY (as silly-personal's Sorter does), tool-use for
 * structured answers, a daily call cap per tier counted in `meta/llm-usage`, and the guard that nothing scheduled ever runs on
 * Fable or Mythos. Any failure (no key, cap used up, model refused, bad reply) returns null and the caller carries on without
 * the model. The text sent is data to be summarised: nothing in it can change what the code lets the model do.
 */
import type { StoreCtx } from './store';
import { getDoc, writeDoc, isCode } from './board';
import { isoOf } from './board-health';

export const HAIKU = 'claude-haiku-5-5';
export const SONNET = 'claude-sonnet-5-5';
export type Tier = 'haiku' | 'sonnet';
export const DEFAULT_CAPS: Record<Tier, number> = { haiku: 200, sonnet: 30 };
export const USAGE = { collection: 'meta', id: 'llm-usage' };

export function assertAllowedModel(m: string): string {
  if (/fable|mythos/i.test(m)) throw new Error('model_not_allowed'); // Ronnie's rule: nothing scheduled on Fable
  return m;
}
export function modelFor(tier: Tier, env: Record<string, string | undefined>): string {
  return assertAllowedModel((tier === 'haiku' ? env.WORK_HAIKU_MODEL : env.WORK_SONNET_MODEL) || (tier === 'haiku' ? HAIKU : SONNET));
}
const capFor = (tier: Tier, env: Record<string, string | undefined>) => {
  const n = Number(tier === 'haiku' ? env.WORK_HAIKU_DAILY_CAP : env.WORK_SONNET_DAILY_CAP);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_CAPS[tier];
};

export type LlmDeps = { ctx: StoreCtx; now: () => Date; fetchImpl: typeof fetch; env: Record<string, string | undefined> };
export interface Tool { name: string; description: string; input_schema: Record<string, unknown> }

/** Takes one call from today's allowance (counted when reserved: a failed call still counts). False when used up. */
export async function reserve(deps: LlmDeps, tier: Tier): Promise<boolean> {
  const day = isoOf(deps.now()).slice(0, 10), cap = capFor(tier, deps.env);
  for (let i = 0; i < 3; i++) {
    const cur = await getDoc(deps.ctx, USAGE.collection, USAGE.id);
    const base = cur && cur.data?.day === day ? cur.data : { day, haiku: 0, sonnet: 0, failed: 0 };
    if (Number(base[tier] ?? 0) >= cap) return false;
    const data = { ...base, [tier]: Number(base[tier] ?? 0) + 1, last: isoOf(deps.now()) };
    try {
      await writeDoc(deps.ctx, cur ? { op: 'update', collection: USAGE.collection, id: USAGE.id, data, ifVersion: cur.version } : { op: 'add', collection: USAGE.collection, id: USAGE.id, data });
      return true;
    } catch (e) { if (!isCode(e, 'version_conflict', 'exists')) throw e; }
  }
  return false;
}
const noteFailed = async (deps: LlmDeps) => {
  try { const cur = await getDoc(deps.ctx, USAGE.collection, USAGE.id); if (cur) await writeDoc(deps.ctx, { op: 'update', collection: USAGE.collection, id: USAGE.id, ifVersion: cur.version, data: { failed: Number(cur.data.failed ?? 0) + 1 } }); } catch { /* best effort */ }
};

export const llmAvailable = (env: Record<string, string | undefined>) => !!env.ANTHROPIC_API_KEY;

/** One forced tool call. Returns the tool's input, or null on any failure. */
export async function callTool<T = any>(deps: LlmDeps, tier: Tier, a: { system: string; user: string; tool: Tool; maxTokens?: number }): Promise<T | null> {
  const key = deps.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  let model: string;
  try { model = modelFor(tier, deps.env); } catch { return null; }
  try { if (!(await reserve(deps, tier))) return null; } catch { return null; }
  try {
    const r = await deps.fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: a.maxTokens ?? 3000, system: a.system, messages: [{ role: 'user', content: a.user }], tools: [a.tool], tool_choice: { type: 'tool', name: a.tool.name } }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!r.ok) { await noteFailed(deps); console.error('[silly-work] llm', tier, `http_${r.status}`); return null; }
    const data: any = await r.json();
    const block = (data.content ?? []).find((b: any) => b.type === 'tool_use' && b.name === a.tool.name);
    if (!block?.input || typeof block.input !== 'object') { await noteFailed(deps); return null; }
    return block.input as T;
  } catch (e: any) { await noteFailed(deps); console.error('[silly-work] llm', tier, String(e?.name || 'error')); return null; }
}
