// One-time, READ-ONLY extraction from the old relay (claude-relay-ronniem339, Turso aws-eu-west-1).
//
//   OLD_RELAY_TOKEN=... node scripts/extract-relay.mjs
//
// Only SELECTs are sent. Writes:
//   scripts/retail-summary/gen.py      meta/retail_summary_docx.code  (version-controlled, reviewed before commit)
//   migration-seed/relay-seed.json     open asks, untaken todo, status, meta docs  (GITIGNORED: live data, Stage 2 import)
// The token is read from the environment only and is never printed or written.
import fs from 'node:fs';
import path from 'node:path';

const token = process.env.OLD_RELAY_TOKEN;
if (!token) { console.error('OLD_RELAY_TOKEN is not set: nothing extracted.'); process.exit(2); }
const URL_ = process.env.OLD_RELAY_URL || 'https://claude-relay-ronniem339.aws-eu-west-1.turso.io/v2/pipeline';

async function select(sql) {
  if (!/^\s*select\b/i.test(sql)) throw new Error('read-only: SELECT only');
  const r = await fetch(URL_, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ requests: [{ type: 'execute', stmt: { sql } }, { type: 'close' }] }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`relay said ${r.status}`);
  const j = await r.json();
  const res = j.results?.[0];
  if (res?.type === 'error') throw new Error(`relay error: ${res.error?.message}`);
  const out = res.response.result;
  const cols = out.cols.map(c => c.name);
  return out.rows.map(row => Object.fromEntries(row.map((v, i) => [cols[i], v?.type === 'null' ? null : v?.value])));
}

const tables = (await select("SELECT name FROM sqlite_master WHERE type = 'table'")).map(r => r.name);
console.error('tables:', tables.join(', '));
const seed = { extracted_at: new Date().toISOString(), tables };

if (tables.includes('asks')) seed.asks = await select('SELECT * FROM asks WHERE closed IS NULL');
if (tables.includes('todo')) seed.todo = await select('SELECT * FROM todo WHERE taken IS NULL');
if (tables.includes('status')) seed.status = await select('SELECT * FROM status');
if (tables.includes('meta')) seed.meta = await select('SELECT * FROM meta');
else console.error('no meta table: meta docs not extracted (check the relay schema)');

// meta/retail_summary_docx.code -> scripts/retail-summary/gen.py. The meta table's column names are not documented,
// so find the row by any column equal to 'retail_summary_docx' and take its `code` field (or a JSON `code` inside data/value).
function codeOf(row) {
  if (typeof row.code === 'string') return row.code;
  for (const k of ['data', 'value', 'body']) {
    if (typeof row[k] !== 'string') continue;
    try { const j = JSON.parse(row[k]); if (typeof j.code === 'string') return j.code; } catch { /* not JSON */ }
  }
  return null;
}
const hit = (seed.meta || []).find(r => Object.values(r).some(v => v === 'retail_summary_docx' || v === 'meta/retail_summary_docx'));
const code = hit ? codeOf(hit) : null;
if (code) {
  fs.mkdirSync('scripts/retail-summary', { recursive: true });
  fs.writeFileSync('scripts/retail-summary/gen.py', code.endsWith('\n') ? code : code + '\n');
  console.error('wrote scripts/retail-summary/gen.py (review it, then commit it)');
} else console.error('retail_summary_docx.code not found: gen.py NOT written');

fs.mkdirSync('migration-seed', { recursive: true });
fs.writeFileSync(path.join('migration-seed', 'relay-seed.json'), JSON.stringify(seed, null, 2));
console.error('wrote migration-seed/relay-seed.json (gitignored)');
