/**
 * Server-side guard for Work Board `inbox` writes that answer a card needing a signed approval.
 * Mirrors the `silly-approval-v1` check in farmfoodslearn/src/server/silly-approval.ts (ECDSA P-256, SHA-256,
 * signed text = the six lines joined by \n) and the bridge's own refusals in Silly's desk-bridge.js (approvalFor).
 *
 * Exactly four refusal codes are ever returned:
 *   needs_signature    an approve card is answered with no approval in the same write
 *   bad_signature      the approval is malformed, for a different letter, from an unknown/wrong/old key, or does not verify
 *   approve_changed    the card's subject or options are not what was signed
 *   approve_unreadable the card's own `approve` cannot be read, so it is never answered here
 *
 * `approve` and `approval` are stored exactly as received: no trimming, no re-casing, no key reordering.
 * The board letter is always 'W' on this side.
 */
import crypto from 'node:crypto';

export const WORK_BOARD_ID = 'W';
export type RefusalCode = 'needs_signature' | 'bad_signature' | 'approve_changed' | 'approve_unreadable';
export class Refusal extends Error {
  constructor(public code: RefusalCode) { super(code); }
}

export const ACTIONS = ['fix', 'deploy', 'tablet'] as const;
type Action = typeof ACTIONS[number];
export const DEVICES = ['phone', 'phone_unlock', 'chrome'] as const;
type Device = typeof DEVICES[number];
/** Which key classes may sign which action (same table as the LMS). */
export const DEVICES_FOR: Record<Action, Device[]> = { fix: ['phone', 'chrome'], deploy: ['phone_unlock'], tablet: ['phone_unlock'] };
export const MAX_AGE_MS: Record<Action, number> = { fix: 7 * 24 * 3600_000, deploy: 15 * 60_000, tablet: 15 * 60_000 };
export const CLOCK_SKEW_MS = 5 * 60_000;

const HEX64 = /^[0-9a-f]{64}$/;
const KEY_ID = /^[0-9a-f]{16}$/;
const ISO = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;
const SIG = /^[A-Za-z0-9+/]{86}==$/;
const APPROVAL_FIELDS = ['v', 'key_id', 'signed_at', 'option', 'subject', 'sig'];

export interface EnrolledKey { id: string; device: Device; key: crypto.KeyObject }

export const keyIdOf = (spkiDer: Buffer) => crypto.createHash('sha256').update(spkiDer).digest('hex').slice(0, 16);

/** SILLY_APPROVAL_KEYS: JSON array of {device, spki (base64 DER), user_id, label}. Unreadable entries are left out. */
export function parseKeys(raw: string | undefined | null, warn: (m: string) => void = () => {}): EnrolledKey[] {
  if (!raw || !String(raw).trim()) return [];
  let list: any;
  try { list = JSON.parse(String(raw)); } catch { warn('SILLY_APPROVAL_KEYS is not JSON'); return []; }
  if (!Array.isArray(list)) { warn('SILLY_APPROVAL_KEYS is not a list'); return []; }
  const out: EnrolledKey[] = [];
  list.forEach((k, i) => {
    try {
      if (!(DEVICES as readonly string[]).includes(k?.device)) throw new Error('bad device');
      const der = Buffer.from(String(k.spki || ''), 'base64');
      const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
      if (key.asymmetricKeyType !== 'ec' || (key.asymmetricKeyDetails as any)?.namedCurve !== 'prime256v1') throw new Error('not P-256');
      out.push({ id: keyIdOf(der), device: k.device, key });
    } catch (e: any) { warn(`SILLY_APPROVAL_KEYS entry ${i} left out: ${e?.message}`); }
  });
  return out;
}

/** The exact text Silly signs. */
export const signedText = (a: { board: string; card_id: string; subject: string; option: string; signed_at: string }) =>
  ['silly-approval-v1', a.board, a.card_id, a.subject, a.option, a.signed_at].join('\n');

/** null: not an approve card. bad: it has an approve that cannot be read. */
export function approveOf(card: any): { action: Action; subject: string } | { bad: true } | null {
  const a = card?.approve;
  if (a == null || a === false || a === '') return null;
  if (typeof a !== 'object' || Array.isArray(a)) return { bad: true };
  const action = String(a.action ?? ''), subject = String(a.subject ?? '');
  if (!(ACTIONS as readonly string[]).includes(action) || !HEX64.test(subject)) return { bad: true };
  return { action: action as Action, subject };
}

export const optionLetter = (o: unknown): string | null => {
  const m = /^([A-Z])\s*[:.)-]/.exec(String(o ?? '').trim());
  return m ? m[1] : null;
};

const isEmptyAnswer = (a: unknown) => a === null || a === undefined || String(a).trim() === '';

export interface GuardInput {
  collection: string;
  docId: string;
  /** the card as stored now, or null if it does not exist */
  existing: Record<string, any> | null;
  /** the fields this write sets (update) or the whole document (set) */
  incoming: Record<string, any>;
  keys: EnrolledKey[];
  now?: Date;
  /** true for `set` (the whole document is replaced): a missing field then means the field is gone */
  replace?: boolean;
}

export interface GuardResult {
  /** fields to write: incoming, with `approval` made exactly right for this write */
  data: Record<string, any>;
}

const deepEqual = (a: any, b: any): boolean => {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
};

/**
 * Applies the approval rules to a write on `inbox/<id>`. Throws Refusal; otherwise returns the data to write.
 * Writes that touch neither `answer`, `approval` nor `approve` pass through untouched.
 */
export function guardInboxWrite(g: GuardInput): GuardResult {
  const inc = g.incoming;
  const stored = g.existing ?? {};
  let touchesAnswer = 'answer' in inc, touchesApproval = 'approval' in inc, touchesApprove = 'approve' in inc;
  if (g.replace && g.existing) {
    // A replacement that leaves `approve` out would turn an approval card into a plain one.
    if (stored.approve != null && stored.approve !== false && !touchesApprove) throw new Refusal('approve_changed');
    touchesAnswer = true; // a replaced document with no answer is an answer cleared
  }
  if (!touchesAnswer && !touchesApproval && !touchesApprove) return { data: inc };

  // `approve` belongs to the card as the LMS wrote it. A write that carries a different one is refused,
  // so a session cannot turn an approval card into a plain one (or the reverse) to get an answer through.
  const need = approveOf(stored);
  if (touchesApprove && g.existing && !deepEqual(inc.approve, stored.approve)) throw new Refusal('approve_changed');

  // Not an approve card: anything sent as an approval is dropped, the rest passes as it is.
  if (!need) {
    if (!touchesApproval) return { data: inc };
    const { approval: _drop, ...rest } = inc;
    return { data: rest };
  }
  if ('bad' in need) {
    // Unreadable approve: it is never answered here. Clearing an answer is still allowed (undo).
    if (touchesAnswer && !isEmptyAnswer(inc.answer)) throw new Refusal('approve_unreadable');
    if (touchesApproval && inc.approval != null) throw new Refusal('approve_unreadable');
  }

  // Undo (answer cleared): the approval goes with it, in the same write.
  if (touchesAnswer && isEmptyAnswer(inc.answer)) {
    return { data: { ...inc, approval: null } };
  }
  // An approval with no answer in the same write is never stored on its own.
  if (touchesApproval && !touchesAnswer) {
    if (inc.approval == null) return { data: inc };
    throw new Refusal('needs_signature');
  }
  if (!touchesAnswer) return { data: inc };

  // ---- an answer is being set on an approve card ----
  if ('bad' in need) throw new Refusal('approve_unreadable'); // (defensive; handled above)
  const ap = inc.approval;
  if (ap == null || typeof ap !== 'object' || Array.isArray(ap)) throw new Refusal('needs_signature');

  const extra = Object.keys(ap).some(k => !APPROVAL_FIELDS.includes(k));
  if (extra || ap.v !== 1 || typeof ap.key_id !== 'string' || !KEY_ID.test(ap.key_id) || typeof ap.signed_at !== 'string' || !ISO.test(ap.signed_at)
    || typeof ap.option !== 'string' || !/^[A-Z]$/.test(ap.option) || typeof ap.sig !== 'string' || !SIG.test(ap.sig) || typeof ap.subject !== 'string') {
    throw new Refusal('bad_signature');
  }
  // Signed for what the card said then: if its subject or options moved since, he reads it and signs again.
  if (ap.subject !== need.subject) throw new Refusal('approve_changed');
  const answer = String(inc.answer ?? '').trim();
  if (optionLetter(answer) !== ap.option) throw new Refusal('bad_signature');
  const options = Array.isArray(stored.options) ? stored.options : [];
  if (!options.some((x: unknown) => String(x).trim() === answer)) throw new Refusal('approve_changed');

  // The signature itself: the right enrolled key, for this action, fresh, over the exact text.
  const key = g.keys.find(k => k.id === ap.key_id);
  if (!key || !DEVICES_FOR[need.action].includes(key.device)) throw new Refusal('bad_signature');
  const at = new Date(ap.signed_at).getTime(), now = (g.now ?? new Date()).getTime();
  if (Number.isNaN(at) || at > now + CLOCK_SKEW_MS || now - at > MAX_AGE_MS[need.action]) throw new Refusal('bad_signature');
  const sig = Buffer.from(ap.sig, 'base64');
  const text = Buffer.from(signedText({ board: WORK_BOARD_ID, card_id: g.docId, subject: ap.subject, option: ap.option, signed_at: ap.signed_at }), 'utf8');
  let good = false;
  try { good = crypto.verify('sha256', text, { key: key.key, dsaEncoding: sig.length === 64 ? 'ieee-p1363' : 'der' }, sig); } catch { good = false; }
  if (!good) throw new Refusal('bad_signature');

  // Stored exactly as received (answer text and approval object untouched).
  return { data: inc };
}
