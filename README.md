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
| `POST /api/trigger` | `list_triggers` / `fire_trigger` / `update_trigger` for this site’s own scheduled jobs (`src/lib/job-defs.ts`) |
| `public/claude-shim.js` | drop-in `window.claude.use('db' \| 'mcp')` for the Work Board and `desk-bridge.js` |
| `scripts/extract-relay.mjs` | one-time, read-only copy out of the old relay (needs `OLD_RELAY_TOKEN`) |

Env var names are in `.env.example`. `npm test` runs everything against a throwaway local libsql file; `npm run typecheck` checks types; `npm run migrate` applies migrations to `TURSO_DATABASE_URL`.

Deleted docs stay as tombstones (`data IS NULL`) so pollers hear about them; the daily purge removes them after 30 days, along with expired `slack_drafts` (7 days after sent or dismissed) and old idempotency keys.

The shim reads the per-device token from `window.SILLY_WORK_TOKEN`, `localStorage.silly_work_token` or `claude.setToken()`.

## Scheduled jobs (Slice 3, PR A: no new secrets)

Netlify cron is UTC only. A job that must run at a fixed London time all year is scheduled on both UTC hours it could land on, and each run checks the Europe/London time first (`src/lib/london.ts`, the `slot` in `job-defs.ts`), exiting at once on the wrong one. A test keeps each function file’s cron in step with its definition.

| Job (`_triggers` id) | London time | What it does |
|---|---|---|
| `trig_answerwatch` | every 15 minutes | An inbox card answered after the watcher’s baseline (`meta/answer-watch.since`, set on its first run) and not being acted on gets one task `t-answer-<card>` and a `hold`. Reports stalled running tasks and failed runs on one "Runs needing attention" card (push). Never writes to `rows`, never changes an answer, never touches cards answered before the baseline. No model. |
| `trig_healthcheck` | daily 09:20 | Digests gone stale (`digest/live`, `slack`, `monday`, `calendar`), this site’s jobs missed or failed, the Monday brief card missing on a Monday morning, answered cards nobody is on, queued or silent tasks, secret-like field names in `meta`. Writes `audit/health-<date>` and `audit/health-latest`; a serious fault raises one card and a push. No model. |
| `trig_fridayreview` | Fridays 15:50 | Acts on last week’s answered Proposal/Idea cards (A on an idea queues a task, B drops it, C drops it for later) and raises one "Work week review" card from the week’s numbers. Seeded **dormant**: switch it on with `update_trigger` when the claude.ai routine is retired. The kudos drafts and the weekly proposal need a model and stay on claude.ai. |

Run records: `_trigger_runs/<id>` holds when each job last fired and how it ended (error code only). Switch a job off or on: `POST /api/trigger {tool: "update_trigger", args: {trigger_id, enabled}}`. Env vars: none new (pushes use `WORK_NTFY_URL` and `WORK_NTFY_KEY`).
