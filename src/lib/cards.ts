/**
 * Raising a card on the Work Board's inbox, and the push that tells the phone. A card carries the fields the board's own
 * cards carry (n, title, text, options, source, row, details, created, answered, answer, actioned). Its number is the
 * highest on the inbox plus one; the id is fixed by the caller, so a retry never makes a second card.
 */
import type { StoreCtx } from './store';
import { getDoc, writeDoc, maxCardNumber, isCode } from './board';
import { sendPush, type PushCard } from './push';
import { isoOf, type Now } from './board-health';

export const clip = (s: unknown, n: number): string => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length <= n ? t : t.slice(0, n - 1).trimEnd() + '…'; };
const lettered = (options: string[]) => options.map((o, i) => (/^[A-Z]\s*[:.)-]/.test(o) ? o : `${String.fromCharCode(65 + i)}: ${o}`)).map(o => clip(o, 40));

export type NewCard = {
  id: string; title: string; text: string; options: string[]; source: string;
  details?: { h?: string; text?: string; numbered?: boolean; lines?: string[] }[];
  /** Extra fields written as given (a hold, a link ...). They never replace the card's own. */
  extra?: Record<string, any>;
};

export async function raiseCard(c: StoreCtx, card: NewCard, now: Now = new Date()): Promise<{ existed: boolean; id: string; n: number | null; options: string[]; title: string }> {
  const title = clip(card.title, 45), options = lettered(card.options);
  const have = await getDoc(c, 'inbox', card.id);
  if (have) return { existed: true, id: card.id, n: have.data.n ?? null, options, title };
  for (let i = 0; i < 3; i++) {
    const n = (await maxCardNumber(c)) + 1;
    const data: Record<string, any> = {
      ...(card.extra ?? {}), id: card.id, n, title, text: clip(card.text, 1500), options, source: card.source, row: 'work', created: isoOf(now),
      answered: null, answer: null, actioned: null,
    };
    if (card.details?.length) data.details = card.details;
    try { await writeDoc(c, { op: 'add', collection: 'inbox', id: card.id, data }); return { existed: false, id: card.id, n, options, title }; }
    catch (e) { if (!isCode(e, 'exists')) throw e; const again = await getDoc(c, 'inbox', card.id); if (again) return { existed: true, id: card.id, n: again.data.n ?? null, options, title }; }
  }
  throw new Error('card_number_busy');
}

/** Tells the phone about a card. Never throws: a push that fails must not fail the job that raised the card. */
export async function pushCard(card: PushCard, env: Record<string, string | undefined> = process.env, fetchImpl: typeof fetch = fetch): Promise<{ sent: boolean; error?: string }> {
  try {
    const r = await sendPush(card, env as any, fetchImpl);
    return r.ok ? { sent: true } : { sent: false, error: r.code };
  } catch (e: any) { return { sent: false, error: String(e?.message || e).slice(0, 120) }; }
}
