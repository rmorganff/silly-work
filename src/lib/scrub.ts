/**
 * PII and `losjefes` scrubber: runs on every write to `docs`, before anything is stored.
 * Code-enforced exclusions from farmfoods-work-rules (20 Nov 2026):
 *  - initials or counts only on the board: no person's name, applicant names, subitems (board 1380722202)
 *  - losjefes (C0692KPGJUR): anything about an individual's performance, conduct, health or personal
 *    circumstances is dropped (the whole write is refused)
 *  - Auror (board 8247581349, channel C06MA3XB6M6): counts and locations only, no narratives
 *
 * This is a safety net of heuristics, not a proof: it catches the known shapes. Names that must travel go in
 * a Claude Doc with its link on the board. A refusal never echoes what matched, and never logs it.
 */

export type ScrubRule = 'person_name' | 'losjefes_individual' | 'auror_narrative' | 'personal_sensitive';
export class ScrubRejected extends Error {
  constructor(public rule: ScrubRule, public path: string) { super(`scrub_rejected:${rule}`); }
}
export interface ScrubResult { data: any; stripped: string[] }

export const LOSJEFES_ID = 'C0692KPGJUR';
export const AUROR_IDS = ['8247581349', 'C06MA3XB6M6'];
export const SUBITEMS_BOARD = '1380722202';

/** Keys whose whole value is a person or an applicant: removed, never stored. */
const PERSON_KEYS = new Set([
  'first_name', 'firstname', 'last_name', 'lastname', 'surname', 'forename', 'full_name', 'fullname',
  'applicant', 'applicant_name', 'applicants', 'candidate_name', 'employee_name', 'person_name',
  'subitems', 'subitem', 'subitem_name',
]);
/** Keys never scanned: signed or machine values that must stay byte-for-byte. */
const OPAQUE_KEYS = new Set(['approve', 'approval', 'sig', 'spki', 'key_id', 'subject', 'silly_wid', 'chat', 'url', 'link']);

/** Health, conduct and performance words: with a person pointer in the same string, rejected anywhere. */
export const TOPIC_CORE = /\b(performance|underperform\w*|capability|disciplinar\w*|grievance|misconduct|conduct|warning|dismiss\w*|sack\w*|resign\w*|absence|absent|sickness|sick|ill|illness|health|medical|doctor|hospital|surgery|diagnos\w*|mental|anxiety|depress\w*|maternity|pregnan\w*|bereave\w*|funeral|divorce|lazy|incompeten\w*)\b/i;
/** Wider personal-circumstances words: in a losjefes document these alone reject it. */
const TOPIC_LOSJEFES = /\b(stress\w*|family|personal|probation|late(?:ness)?|attitude|struggl\w*|separat\w*|home life|carer|caring)\b/i;
const PERSON_POINTER = /\b(he|she|him|her|his|hers|himself|herself)\b/i;

const NARRATIVE = /\b(stole\w*|steal\w*|theft|shoplift\w*|took|taken|caught|suspect\w*|offender|perpetrator|arrest\w*|assault\w*|abus\w*|threat\w*|violen\w*|cctv|footage|witness\w*|police|officer|then|after that|walked|ran|grabbed|pushed|said|told|claimed|admitted|described|wearing|wore)\b/i;

/** Unambiguous common UK first names. Capitalised whole words only; words that are also plain English are left out. */
export const FIRST_NAMES = new Set(`
Aaron Abigail Adam Adrian Alan Alex Alexander Alice Alison Amanda Amy Andrew Andy Angela Anna Anne Anthony Barry Beth Bethany Brian Callum Carl Carol Caroline Catherine Charlie Charlotte Chloe Chris Christine Christopher Claire Colin Craig Dale Daniel Darren David Dean Debbie Declan Denise Dominic Donna Douglas Edward Eleanor Elizabeth Ella Emily Emma Fiona Frank Gareth Gary Gemma George Gillian Gordon Graham Hannah Harry Heather Helen Henry Hollie Ian Imran Isabel Jack Jacob Jade James Jamie Jane Janet Jason Jennifer Jenny Jeremy Jessica Joanne Joe Joel John Jonathan Jordan Joseph Josh Joshua Julie Karen Kate Katherine Kathryn Katie Keith Kelly Ken Kerry Kevin Kieran Kim Kirsty Laura Lauren Lee Leanne Leon Lesley Liam Linda Lisa Louise Lucy Luke Lynn Marcus Margaret Maria Marie Mark Martin Mary Matthew Megan Melanie Michael Michelle Mohammed Mohammad Muhammad Naomi Natalie Neil Nicholas Nick Nicola Nigel Olivia Oliver Owen Pamela Patricia Patrick Paul Paula Peter Philip Phillip Rachel Raj Rebecca Richard Rob Robert Robin Rosie Ross Roy Ruth Ryan Sally Sam Samantha Samuel Sandra Sarah Scott Sean Shaun Sheila Simon Sophie Stephanie Stephen Steve Steven Stuart Susan Suzanne Tariq Terry Thomas Tim Timothy Tina Toby Tom Tony Tracey Tracy Vicky Victoria Wayne William Yasmin Zoe
`.split(/\s+/).filter(Boolean));

const HONORIFIC = /\b(?:Mr|Mrs|Ms|Miss|Mx|Dr)\.?\s+[A-Z][a-z]{2,}/;
const NAME_THEN_INITIAL = /\b[A-Z][a-z]{2,}\s+[A-Z]\.(?=\s|$|[,;)])/;

function listEnv(name: string): string[] {
  return String(process.env[name] ?? '').split(',').map(s => s.trim()).filter(Boolean);
}
function escapeRe(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function hasName(text: string): boolean {
  if (HONORIFIC.test(text) || NAME_THEN_INITIAL.test(text)) return true;
  for (const w of text.match(/\b[A-Z][a-z]{2,}\b/g) ?? []) if (FIRST_NAMES.has(w)) return true;
  const deny = listEnv('PII_NAME_DENYLIST');
  return deny.some(n => new RegExp(`\\b${escapeRe(n)}\\b`, 'i').test(text));
}

type Ctx = { losjefes: boolean; auror: boolean };

function contextOf(collection: string, docId: string, data: any): Ctx {
  const hay = JSON.stringify([collection, docId, data]);
  return {
    losjefes: hay.includes(LOSJEFES_ID) || /\blosjefes\b/i.test(hay),
    auror: AUROR_IDS.some(i => hay.includes(i)) || /\bauror\b/i.test(hay),
  };
}

function scanString(s: string, ctx: Ctx, path: string) {
  if (hasName(s)) throw new ScrubRejected('person_name', path);
  const core = TOPIC_CORE.test(s);
  if (ctx.losjefes && (core || TOPIC_LOSJEFES.test(s))) throw new ScrubRejected('losjefes_individual', path);
  if (core && PERSON_POINTER.test(s)) throw new ScrubRejected('personal_sensitive', path);
  if (ctx.auror && (s.length > 120 || NARRATIVE.test(s))) throw new ScrubRejected('auror_narrative', path);
}

function walk(v: any, ctx: Ctx, path: string, stripped: string[]): any {
  if (typeof v === 'string') { scanString(v, ctx, path); return v; }
  if (Array.isArray(v)) return v.map((x, i) => walk(x, ctx, `${path}[${i}]`, stripped));
  if (v && typeof v === 'object') {
    const out: Record<string, any> = {};
    for (const [k, val] of Object.entries(v)) {
      const lk = k.toLowerCase();
      if (PERSON_KEYS.has(lk)) { stripped.push(`${path}.${k}`); continue; }
      out[k] = OPAQUE_KEYS.has(lk) ? val : walk(val, ctx, `${path}.${k}`, stripped);
    }
    return out;
  }
  return v;
}

/**
 * Cleans one document. Person/applicant/subitem keys are stripped (and listed in `stripped`);
 * any string that carries a name, an individual's sensitive circumstances, or an Auror narrative
 * rejects the whole write (ScrubRejected). `PII_ALLOW_DOCS` (comma list of collection/doc_id) opts a
 * document out entirely, for the few that must carry names (e.g. a reviewer id list).
 */
export function scrubDoc(collection: string, docId: string, data: any): ScrubResult {
  if (listEnv('PII_ALLOW_DOCS').includes(`${collection}/${docId}`)) return { data, stripped: [] };
  const stripped: string[] = [];
  const ctx = contextOf(collection, docId, data);
  const clean = walk(data, ctx, '$', stripped);
  return { data: clean, stripped };
}
