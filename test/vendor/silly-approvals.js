// Silly for Chrome: signed approvals (11 Nov 2026, docs/silly-approvals.md, contract v1). Pure logic and WebCrypto, so
// node's tests cover it; panel/panel.js draws the card and panel/approvalkeys.js the Approval keys screen.
//
// This browser has one ECDSA P-256 key pair, made here by WebCrypto as not extractable and kept in the extension's own
// IndexedDB (a CryptoKey survives the structured clone, still not extractable). The private key is never exported, never
// put in a message and never put in chrome.storage: only its public key (SPKI, base64) and key id leave this module.
// Chrome signs `fix` approvals only. A deploy or a tablet push is approved on the phone, with its unlock: sign() below
// throws for them, whatever the caller asks.

export const V = 1;
export const ACTIONS = ['fix', 'deploy', 'tablet'];
/** What this browser may sign. Deploys and tablet pushes need the phone's unlock (phone_unlock). */
export const CHROME_SIGNS = Object.freeze(['fix']);
export const DEVICE = 'chrome';
const HEX64 = /^[0-9a-f]{64}$/;
const KEY_ID = /^[0-9a-f]{16}$/;
const ISO = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;
const SIG = /^[A-Za-z0-9+/]{86}==$/;
const ALG = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN_ALG = { name: 'ECDSA', hash: 'SHA-256' };
const subtleOf = (s) => s || globalThis.crypto.subtle;
const str = (v) => (v == null ? '' : String(v));

// --- Bytes ---

export function b64(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
}
export function unb64(text) {
  const s = atob(str(text)), u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}
const hex = (bytes) => [...new Uint8Array(bytes)].map((x) => x.toString(16).padStart(2, '0')).join('');

/** The key id: the first 16 hex characters of SHA-256 over the SPKI DER bytes. */
export async function keyId(spkiBytes, subtle) {
  return hex(await subtleOf(subtle).digest('SHA-256', spkiBytes instanceof Uint8Array ? spkiBytes : new Uint8Array(spkiBytes))).slice(0, 16);
}

// --- The text signed ---

/** UTC to the second, with Z: 2026-11-11T08:00:00Z. */
export const isoNow = (ms = Date.now()) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** The six lines signed, joined by \n, no trailing newline (the contract's signing text). */
export function signingText(board, cardId, subject, letter, iso) {
  return ['silly-approval-v1', board, cardId, subject, letter, iso].join('\n');
}

// --- The card ---

/** The card's approve as the bridge reads it: null (not an approve card), {action, subject}, or {.., bad: true} (never answered here). */
export function approveOf(item) {
  const a = item && item.approve;
  if (a == null || a === false) return null;
  const o = typeof a === 'object' ? a : {};
  const action = str(o.action), subject = str(o.subject);
  if (o.bad === true || !ACTIONS.includes(action) || !HEX64.test(subject)) return { action: action.slice(0, 20), subject: subject.slice(0, 64), bad: true };
  return { action, subject };
}
/** What the board says was signed (the bridge's slim copy, never the signature): {key_id, signed_at, option} or null. */
export function approvalOf(item) {
  const a = item && item.approval;
  if (!a || typeof a !== 'object') return null;
  return { key_id: str(a.key_id).slice(0, 16), signed_at: str(a.signed_at).slice(0, 40), option: str(a.option).slice(0, 1) };
}
export const chromeSigns = (ap) => !!ap && !ap.bad && CHROME_SIGNS.includes(ap.action);

/** The approval the worker passes on with an answer: exactly the six fields, or nothing (anything else is dropped). */
export function cleanApproval(a) {
  if (!a || typeof a !== 'object') return null;
  const o = { v: a.v, key_id: str(a.key_id), signed_at: str(a.signed_at), option: str(a.option), subject: str(a.subject), sig: str(a.sig) };
  return o.v === V && KEY_ID.test(o.key_id) && ISO.test(o.signed_at) && /^[A-Z]$/.test(o.option) && HEX64.test(o.subject) && SIG.test(o.sig) ? o : null;
}
/** The answer command the panel sends for a card: with its approval in the same command, when there is one. */
export function answerCmd(item, answer, approval) {
  const ap = cleanApproval(approval);
  return { cmd: 'answer', board: item.board, id: item.id, answer: String(answer), ...(ap ? { approval: ap } : {}) };
}

/** What the worker queues for a signed answer (sw.js): the board's answer command with its approval, nothing else. */
export function signedAnswer(m) {
  const ap = cleanApproval(m && m.approval);
  return { cmd: 'answer', id: String(m.id), answer: String(m.answer), ...(ap ? { approval: ap } : {}) };
}

// --- The key: kept in the extension's IndexedDB (idbStore), or in memory for the tests (memoryStore) ---

/** A store holds one record {privateKey, publicKey, spki (base64), key_id, made (ISO)}: get(), put(rec), clear(). */
export function memoryStore() {
  let rec = null;
  return { get: async () => rec, put: async (r) => { rec = r; }, clear: async () => { rec = null; } };
}
export const IDB_NAME = 'silly-approvals', IDB_STORE = 'keys', IDB_KEY = 'chrome';
/** The real store: the extension's IndexedDB. The CryptoKeys go in as they are (structured clone), never exported. */
export function idbStore(idb = globalThis.indexedDB) {
  const open = () => new Promise((ok, no) => {
    const r = idb.open(IDB_NAME, 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(IDB_STORE)) r.result.createObjectStore(IDB_STORE); };
    r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
  });
  const run = async (mode, f) => {
    const db = await open();
    try {
      return await new Promise((ok, no) => {
        const t = db.transaction(IDB_STORE, mode), q = f(t.objectStore(IDB_STORE));
        let out; q.onsuccess = () => { out = q.result; };
        t.oncomplete = () => ok(out); t.onerror = () => no(t.error); t.onabort = () => no(t.error);
      });
    } finally { db.close(); }
  };
  return {
    get: async () => (await run('readonly', (s) => s.get(IDB_KEY))) || null,
    put: (rec) => run('readwrite', (s) => s.put(rec, IDB_KEY)),
    clear: () => run('readwrite', (s) => s.delete(IDB_KEY)),
  };
}

/** Makes this browser's key (a new one replaces the old) and keeps it: its private half not extractable. */
export async function makeKey(store, { subtle, now = Date.now() } = {}) {
  const sb = subtleOf(subtle);
  const pair = await sb.generateKey(ALG, false /* not extractable */, ['sign']);
  const spki = new Uint8Array(await sb.exportKey('spki', pair.publicKey));
  const rec = { privateKey: pair.privateKey, publicKey: pair.publicKey, spki: b64(spki), key_id: await keyId(spki, sb), made: isoNow(now) };
  await store.put(rec);
  return info(rec);
}
const info = (rec) => (rec && rec.privateKey && KEY_ID.test(str(rec.key_id)) ? { key_id: rec.key_id, spki: rec.spki, made: rec.made || null } : null);
/** This browser's key as the screen shows it: {key_id, spki, made}, or null when none has been made. Public parts only. */
export async function keyInfo(store) { try { return info(await store.get()); } catch (e) { return null; } }
/** What goes to meta/approval-keys on the Work Board: this browser's public key only. */
export const keysCmd = (k) => ({ cmd: 'approvalKeys', board: 'W', keys: [{ device: DEVICE, key_id: k.key_id, spki: k.spki }] });

/** A refusal: thrown as {code}, as the bridge's are, so the panel says it in plain words (refusalWords). */
const refuse = (code) => { throw { code }; };

/**
 * Signs his click on a lettered option of an approve card, at that moment: {v, key_id, signed_at, option, subject, sig}.
 * board: 'W' or 'P'; item: the card as he read it ({id, approve}); letter: the option's letter.
 * Throws for a deploy or tablet card (phone only), an approve Silly can't read, or no key yet.
 */
export async function sign({ store, board, item, letter, now = Date.now(), subtle }) {
  const ap = approveOf(item);
  if (!ap) refuse('not_approve');
  if (ap.bad) refuse('approve_unreadable');
  // Never a deploy or a tablet push from here: those need the phone's unlock at the moment of signing.
  if (!CHROME_SIGNS.includes(ap.action)) refuse('phone_only');
  if (board !== 'W' && board !== 'P') refuse('bad_board');
  if (!/^[A-Z]$/.test(str(letter))) refuse('no_letter');
  const id = str(item.id);
  if (!id) refuse('no_card');
  const rec = await store.get();
  if (!rec || !rec.privateKey) refuse('no_key');
  const at = isoNow(now);
  const text = signingText(board, id, ap.subject, letter, at);
  const sig = new Uint8Array(await subtleOf(subtle).sign(SIGN_ALG, rec.privateKey, new TextEncoder().encode(text)));
  return { v: V, key_id: rec.key_id, signed_at: at, option: letter, subject: ap.subject, sig: b64(sig) };
}

/** Checks a signature against a public key (SPKI base64) over the rebuilt text: for the tests and the screen. */
export async function verify(spki, board, cardId, approval, subtle) {
  const sb = subtleOf(subtle);
  const key = await sb.importKey('spki', unb64(spki), ALG, false, ['verify']);
  const text = signingText(board, cardId, approval.subject, approval.option, approval.signed_at);
  return sb.verify(SIGN_ALG, key, unb64(approval.sig), new TextEncoder().encode(text));
}

// --- Every word the panel shows ---

export const KIND_WORDS = { fix: 'Approves a fix to the LMS', deploy: 'Approves a deploy of the LMS', tablet: 'Approves a push to the LMS tablets' };
export const SIGNED_HERE = (id) => `Your click is signed with this browser's key (${id}).`;
export const NO_KEY = "This browser has no approval key yet: make it in Approval keys, then answer.";
export const FINGERPRINT = 'Fingerprint of what you approve';
export const PHONE_ONLY = 'Approve this one on your phone';
export const PHONE_ONLY_LINE = 'Deploys and tablet pushes are approved on the phone only, with its unlock.';
export const CANT_SIGN = "Silly can't sign this one: answer it on the board";
export const SIGNING = 'Signing…';
export const OPEN_KEYS = 'Approval keys';
export const fingerprint = (subject) => str(subject).slice(0, 12);

/** The plain panel before the options: what kind of approval, whose key signs, the fingerprint; or why it can't be answered here. */
export function approveView(ap, myKey) {
  if (!ap) return null;
  if (ap.bad) return { bad: true, kind: null, line: CANT_SIGN, keyLine: null, fingerprint: null, canSign: false, phoneOnly: false, needsKey: false };
  const kind = KIND_WORDS[ap.action];
  if (!CHROME_SIGNS.includes(ap.action)) return { bad: false, kind, line: PHONE_ONLY, sub: PHONE_ONLY_LINE, keyLine: null, fingerprint: fingerprint(ap.subject), canSign: false, phoneOnly: true, needsKey: false };
  return { bad: false, kind, line: null, keyLine: myKey ? SIGNED_HERE(myKey.key_id) : NO_KEY, fingerprint: fingerprint(ap.subject), canSign: !!myKey, phoneOnly: false, needsKey: !myKey };
}

/** After answering: "Signed with this browser's key at 08:00" (only when the key id is this browser's), else the key id. */
export function signedLine(approval, myKeyId, hm) {
  if (!approval || !KEY_ID.test(str(approval.key_id))) return null;
  const t = Date.parse(approval.signed_at);
  const who = myKeyId && approval.key_id === myKeyId ? "this browser's key" : `key ${approval.key_id}`;
  return `Signed with ${who}${isNaN(t) ? '' : ` at ${hm(t)}`}`;
}

/** The bridge's refusals and this module's, in plain words. */
export const REFUSALS = {
  needs_signature: 'This card needs a signed answer and none went with it, so nothing was written. Answer it again.',
  bad_signature: "The signature didn't fit this answer, so nothing was written. Answer it again.",
  approve_changed: 'This card changed after you read it. Read it again and answer.',
  approve_unreadable: CANT_SIGN + '.',
  phone_only: PHONE_ONLY + '.',
  no_key: NO_KEY,
  not_approve: 'This card needs no signature.',
  sign_failed: "This browser couldn't sign it. Try again.",
};
export const refusalWords = (code) => (code && Object.prototype.hasOwnProperty.call(REFUSALS, code) ? REFUSALS[code] : null);

// --- The Approval keys screen ---

export const KEYS_TITLE = 'Approval keys';
export const KEYS_ENROL = 'Enrol each key in the LMS yourself; check the key id here against what the LMS shows.';
export const KEYS_PHONE_ONLY = 'Deploys and tablet pushes are approved on the phone only.';
export const THIS_KEY = "This browser's key";
export const NOT_MADE = 'Not made yet';
export const MAKE = 'Make the key';
export const MAKE_NEW = 'Make a new key';
export const MAKE_NEW_WARN = 'A new key replaces this one for good: enrol the new key in the LMS and send it to the Work Board again. Tap again to make it.';
export const COPY_PUBLIC = 'Copy public key';
export const SEND_KEY = 'Send the public key to the Work Board';
export const SEND_AGAIN = 'Send it again';
export const BOARD_COPY = "The Work Board's copy of the phone's keys";
export const BOARD_COPY_LINE = 'What the Work Board has, not read from the phone itself: check each key id on the phone too.';
export const PHONE_DEVICES = [['phone', 'Phone (fixes)'], ['phone_unlock', 'Phone with unlock (deploys and tablet pushes)']];

/** A device's key as the Work Board has it (meta/approval-keys, flat fields from the bridge): {key_id, spki, updated} or null. */
export function boardKey(doc, device) {
  if (!doc || typeof doc !== 'object') return null;
  const id = str(doc[device + '.key_id']), spki = str(doc[device + '.spki']);
  return KEY_ID.test(id) ? { key_id: id, spki: spki || null, updated: str(doc[device + '.updated']) || null } : null;
}

/**
 * Send the public key: its true state beside the button. mine: this browser's key (or null); doc: the Work Board's
 * meta/approval-keys (flat), undefined while the Work Board hasn't sent it; live: the Work Board is loaded; sent: what
 * this browser last sent ({key_id, at, ok}) from chrome.storage.local. -> {line, tone, button (words or null)}.
 */
export function sendState(mine, doc, live, sent) {
  if (!mine) return { line: 'Make the key first.', tone: 'faint', button: null };
  const mineSent = sent && sent.key_id === mine.key_id && sent.ok ? sent : null;
  const was = mineSent ? ` You sent it at ${str(mineSent.at).slice(11, 16)} UTC on ${str(mineSent.at).slice(0, 10)}.` : ' Never sent from this browser.';
  if (!live || doc === undefined) return { line: "The Work Board isn't loaded, so Silly can't see what it has." + was, tone: 'amber', button: SEND_KEY, needsBoard: true };
  const on = boardKey(doc, DEVICE);
  if (on && on.key_id === mine.key_id) return { line: `On the Work Board, matching this key.${mineSent ? was : ''}`, tone: 'ok', button: SEND_AGAIN };
  if (on) return { line: `The Work Board has a different Chrome key (${on.key_id}), not this one.${was}`, tone: 'amber', button: SEND_KEY };
  return { line: `Not on the Work Board.${was}`, tone: 'amber', button: SEND_KEY };
}
/** What Send said, in plain words. */
export function sendSaid(r) {
  if (r && r.ok) return 'Sent. The Work Board has it once the line above says it matches.';
  const c = r && r.code;
  if (c === 'not_live') return "The Work Board isn't loaded. Open the boards, then send it.";
  if (c === 'bad_key') return "The Work Board didn't take that key. Make a new key and send that.";
  return `Not sent (${c || 'error'}). Try again.`;
}
