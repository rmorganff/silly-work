# silly-work

Work-side board backend for Silly: Netlify Functions + Turso (Work account, aws-eu-west-1). Replaces the claude.ai Work Board artifact's storage and the Personal-account Work shift's plumbing. Stage 1: scaffold and tests only. Nothing here touches the live boards.

| Path | What |
|---|---|
| `migrations/0001_init.sql` | `docs` (+ `seq_counter`), `idempotency_keys`, `slack_drafts`, `audit_log` |
| `POST /api/db` (`GET ?since_seq=N`) | get, list, set, update, add, delete, changes. `ifVersion` CAS, `silly_wid` idempotency |
| `src/lib/approval.ts` | inbox guard: `silly-approval-v1`, four refusal codes |
| `src/lib/scrub.ts` | PII, losjefes and Auror scrubber, runs before every docs write |
| `POST /api/carry/:card_id` | carries a signed fix answer to the LMS (was `silly-decision.mjs`) |
| `POST /api/push` | AES-GCM ntfy push, board W |
| `POST /api/trigger` | stub for `fire_trigger` / `list_triggers` until Stage 3 |
| `public/claude-shim.js` | drop-in `window.claude.use('db' \| 'mcp')` for the Work Board and `desk-bridge.js` |
| `scripts/extract-relay.mjs` | one-time, read-only copy out of the old relay (needs `OLD_RELAY_TOKEN`) |

Env var names are in `.env.example`. `npm test` runs everything against a throwaway local libsql file; `npm run typecheck` checks types; `npm run migrate` applies migrations to `TURSO_DATABASE_URL`.

Deleted docs stay as tombstones (`data IS NULL`) so pollers hear about them; the daily purge removes them after 30 days, along with expired `slack_drafts` (7 days after sent or dismissed) and old idempotency keys.

The shim reads the per-device token from `window.SILLY_WORK_TOKEN`, `localStorage.silly_work_token` or `claude.setToken()`.
