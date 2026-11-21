/**
 * Netlify scheduled functions stop at 30 seconds; the Slack, monday.com and model work of the longer jobs needs more. So a
 * scheduled function (or /api/trigger) only STARTS the job's Netlify background function (up to 15 minutes), which answers 202
 * at once and does the work after. The start is authenticated with SILLY_WORK_TRIGGER_SECRET.
 */
import { timingSafeEqual } from 'node:crypto';
import type { JobMeta } from './job-defs';

/** The site address from SILLY_WORK_SITE_URL. A value pasted from a chat arrives as a markdown link, "[https://x](https://x)":
 *  the first http(s) address in it is used, without a trailing slash. Null when there is none. */
export function siteUrlFrom(raw: string | undefined | null): string | null {
  const m = /https?:\/\/[^\s\]\)\[\("'<>]+/i.exec(String(raw ?? ''));
  return m ? m[0].replace(/\/+$/, '') : null;
}

export async function startBackground(def: JobMeta, env: Record<string, string | undefined>, fetchImpl: typeof fetch, source: 'schedule' | 'fire'): Promise<{ started: boolean; reason: string }> {
  const base = siteUrlFrom(env.SILLY_WORK_SITE_URL), secret = env.SILLY_WORK_TRIGGER_SECRET;
  if (!def.background) return { started: false, reason: 'not_a_background_job' };
  if (!base || !secret) return { started: false, reason: 'background_not_configured' };
  try {
    const r = await fetchImpl(`${base}/.netlify/functions/${def.background}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-silly-trigger-secret': secret },
      body: JSON.stringify({ trigger_id: def.id, source }), signal: AbortSignal.timeout(10_000),
    });
    return r.status < 300 ? { started: true, reason: 'ok' } : { started: false, reason: `status_${r.status}` };
  } catch (e: any) { return { started: false, reason: e?.name === 'TimeoutError' ? 'timeout' : 'unreachable' }; }
}

export const sameSecret = (a: string, b: string): boolean => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
