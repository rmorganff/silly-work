/**
 * Replaces the laptop-only scripts/silly-decision.mjs (farmfoodslearn). Carries Ronnie's signed answer on a
 * Work Board fix card (inbox/lms-fix-<report id>) to the LMS, which alone decides whether the approval counts.
 * This decides nothing: it carries. Carrying twice is harmless (the LMS says SILLY_APPROVAL_USED, and a card
 * already carried with the same answer is not sent again). It never sets `actioned`: that stays the shift's call.
 * Writes `carried_answer` and `result` on the card.
 */
import type { StoreCtx } from './store';
import { handleDb } from './store';

export interface CarryEnv { TRIAGE_NOTIFY_TOKEN?: string; TRIAGE_NOTIFY_BASE?: string }
export interface CarryOut { status: number; body: Record<string, unknown> }

export async function carry(c: StoreCtx, cardId: string, env: CarryEnv = process.env, fetchFn: typeof fetch = fetch): Promise<CarryOut> {
  const m = /^lms-fix-(.+)$/.exec(cardId);
  if (!m) return { status: 400, body: { code: 'NOT_A_FIX_CARD', reason: `${cardId} is not an LMS fix card.` } };
  const reportId = m[1];
  const got = await handleDb(c, { op: 'get', collection: 'inbox', doc_id: cardId });
  if (!got.body.exists) return { status: 404, body: { code: 'NOT_FOUND', report: reportId } };
  const card = got.body.data as Record<string, any>;
  const version = got.body.version as number;

  if (!card.approval) return { status: 409, body: { report: reportId, recorded: false, code: 'NOT_SIGNED', reason: 'The card was answered without a Silly signature, so it is not a decision.' } };
  const answered = /^\s*([A-Z])(?![A-Za-z])/.exec(String(card.answer ?? ''))?.[1];
  if (!answered || answered !== card.approval.option) {
    return { status: 409, body: { report: reportId, recorded: false, code: 'ANSWER_MISMATCH', reason: `The card's answer (${card.answer ?? 'none'}) is not the signed option (${card.approval.option}).` } };
  }
  // Already carried with this very answer and recorded: done, nothing sent.
  if (card.carried_answer === card.answer && card.result?.recorded === true) {
    return { status: 200, body: { report: reportId, recorded: true, already: true } };
  }

  const token = env.TRIAGE_NOTIFY_TOKEN;
  if (!token) return { status: 503, body: { report: reportId, recorded: false, code: 'NOT_SET_UP', reason: 'TRIAGE_NOTIFY_TOKEN is not set.' } };
  const url = `${env.TRIAGE_NOTIFY_BASE || 'https://learn.farmfoods.co.uk'}/api/triage/silly-decision`;

  let result: Record<string, unknown>, status = 200;
  try {
    const r = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-triage-token': token },
      body: JSON.stringify({ report_id: reportId, approval: card.approval }),
      signal: AbortSignal.timeout(20_000),
    });
    const body: any = await r.json().catch(() => ({}));
    if (r.ok) result = { report: reportId, recorded: true, status: body.status ?? null };
    else if (body.code === 'SILLY_APPROVAL_USED') result = { report: reportId, recorded: true, already: true };
    else { result = { report: reportId, recorded: false, code: body.code || r.status, reason: body.error || '' }; status = 422; }
  } catch (e: any) {
    return { status: 502, body: { report: reportId, recorded: false, code: 'LMS_UNREACHABLE', reason: String(e?.message ?? e).slice(0, 200) } };
  }

  // carried_answer and result only: the answer/approval pair is not touched, so the inbox guard has nothing to check.
  const w = await handleDb(c, {
    op: 'update', collection: 'inbox', doc_id: cardId, ifVersion: version,
    data: { carried_answer: card.answer, result: { ...result, at: (c.now ? c.now() : new Date()).toISOString() } },
  });
  if (w.status === 409) return { status: 409, body: { ...result, code: 'CARD_CHANGED', reason: 'The card changed while it was carried; read it again.' } };
  return { status, body: result };
}
