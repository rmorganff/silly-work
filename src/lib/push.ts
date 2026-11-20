/**
 * Work-only ntfy push, ported from scripts/silly-push.py (ronnie-launcher): the card message is sealed with
 * AES-256-GCM (12-byte IV, 128-bit tag; wire = base64(IV + ciphertext + tag), key = base64 of 32 bytes) and POSTed as
 * text/plain to the phone's UnifiedPush endpoint. The board is always 'W'. Only the card's id, number, title, options
 * and (optionally) text/details travel; nothing about where the phone or Ronnie is. Initials and counts only: the
 * caller writes the card, and the scrubber has already looked at it.
 */
import crypto from 'node:crypto';
import { ACTIONS } from './approval';

export interface PushCard {
  id: string; title: string; n?: number; options?: string[]; questions?: boolean; text?: string;
  details?: { h?: string | null; text?: string; lines?: string[] }[]; kind?: string; silent?: boolean; urgent?: boolean;
  approve?: 'fix' | 'deploy' | 'tablet';
}

export const PUSH_KINDS = ['cards', 'social', 'trips', 'filed', 'runs', 'errors', 'laptop_cards', 'back_at_laptop'];

export function validateCard(c: any): string | null {
  if (!c || typeof c !== 'object') return 'card_required';
  if (typeof c.id !== 'string' || !c.id.trim() || c.id.length > 200) return 'bad_id';
  if (typeof c.title !== 'string' || !c.title.trim()) return 'bad_title';
  if (c.n !== undefined && !Number.isInteger(c.n)) return 'bad_n';
  if (c.options !== undefined && !(Array.isArray(c.options) && c.options.every((o: unknown) => typeof o === 'string'))) return 'bad_options';
  if (c.approve !== undefined && !(ACTIONS as readonly string[]).includes(c.approve)) return 'bad_approve';
  if (c.kind !== undefined && !PUSH_KINDS.includes(c.kind)) return 'bad_kind';
  return null;
}

/** The card message as relay/RelayModel.kt reads it (same field order and names as payload() in silly-push.py). */
export function payload(c: PushCard, at = new Date()): string {
  const o: Record<string, unknown> = {
    type: 'card', board: 'W', id: c.id.trim(), n: c.n ?? null, title: c.title.trim(),
    at: at.toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
  const opts = (c.options ?? []).map(s => s.trim()).filter(Boolean);
  if (opts.length) o.options = opts;
  if (c.questions) o.questions = true;
  if (c.text?.trim()) o.text = c.text.trim();
  if (c.details?.length) o.details = c.details;
  if (c.kind) o.kind = c.kind;
  if (c.silent) o.silent = true;
  if (c.urgent) o.urgent = true;
  if (c.approve) o.approve = c.approve;
  return JSON.stringify(o);
}

export function keyBytes(b64: string): Buffer {
  const k = Buffer.from(String(b64 ?? '').trim(), 'base64');
  if (k.length !== 32) throw new Error('WORK_NTFY_KEY must be base64 of 32 bytes');
  return k;
}

/** base64(IV + ciphertext + tag), as RelayCrypto.encrypt makes it. `iv` is for tests. */
export function seal(keyB64: string, plain: string, iv: Buffer = crypto.randomBytes(12)): string {
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes(keyB64), iv, { authTagLength: 16 });
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, ct, cipher.getAuthTag()]).toString('base64');
}
export function open(keyB64: string, wire: string): string {
  const raw = Buffer.from(wire, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', keyBytes(keyB64), raw.subarray(0, 12), { authTagLength: 16 });
  d.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString('utf8');
}

export async function sendPush(card: PushCard, env = process.env, fetchFn: typeof fetch = fetch): Promise<{ ok: boolean; status: number; code?: string }> {
  const url = env.WORK_NTFY_URL, key = env.WORK_NTFY_KEY;
  if (!url || !key) return { ok: false, status: 503, code: 'push_not_configured' };
  if (!url.startsWith('https://')) return { ok: false, status: 503, code: 'push_endpoint_not_https' };
  let wire: string;
  try { wire = seal(key, payload(card)); } catch { return { ok: false, status: 503, code: 'push_key_invalid' }; }
  try {
    const r = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'text/plain; charset=utf-8' }, body: wire, signal: AbortSignal.timeout(10_000) });
    return r.ok ? { ok: true, status: r.status } : { ok: false, status: 502, code: `push_server_${r.status}` };
  } catch { return { ok: false, status: 502, code: 'push_unreachable' }; }
}
