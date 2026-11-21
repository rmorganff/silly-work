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

## Scheduled jobs (Slice 3)

Netlify cron is UTC only. A job that must run at a fixed London time all year is scheduled on both UTC hours it could land on, and each run checks the Europe/London time first (`src/lib/london.ts`, the `slot` in `src/lib/job-defs.ts`), exiting at once on the wrong one. A test keeps each function file’s cron in step with its definition and proves each fires its London time exactly once a day across a whole year, including both clock changes.

Jobs that need more than a scheduled function’s 30 seconds (anything reading Slack, monday.com or the model) are started by their scheduled function, which only calls the job’s Netlify background function (up to 15 minutes) with `x-silly-trigger-secret`.

| Job (`_triggers` id) | London time | What it does |
|---|---|---|
| `trig_answerwatch` | every 15 minutes | An inbox card answered after the watcher’s baseline (`meta/answer-watch.since`, set on its first run) and not being acted on gets one task `t-answer-<card>` and a `hold`. Reports stalled running tasks and failed runs on one "Runs needing attention" card (push). Never writes to `rows`, never changes an answer, never touches cards answered before the baseline. No model. |
| `trig_healthcheck` | daily 09:20 | Digests gone stale, this site’s jobs missed or failed, the Monday brief card missing on a Monday morning, answered cards nobody is on, queued or silent tasks, secret-like field names in `meta`. Writes `audit/health-<date>`; a serious fault raises one card and a push. No model. |
| `trig_calendar` | daily 06:50 | The calendar feed (`calendar-daily`): reads the two iCal addresses in `WORK_CAL_ICAL_URLS` (comma or newline separated: first the main Work calendar, second the Training team holidays) and writes `digest/calendar` as `{updated, items}`: first "Off this week" (initials and dates from the holidays calendar), then the next 7 days of the Work calendar (at most 15). Only title, time and location are read; names become initials, personal matters show as "(private)", links and passcodes are dropped. If the Work calendar fails the previous digest stays with a "Calendar not read" item in front. No model. |
| `trig_weekbrief` (background) | Mondays 07:45 | The Monday brief: Team week from Slack (initials, silence, unanswered questions, Sonnet themes), Vacancies and Loss prevention from monday.com. One card `work-brief-<date>`, a push. Read-only everywhere; no item names except Retail shops. |
| `trig_chase` (background) | weekdays 09:30, 13:30 | Chases open questions in `meta/questions` in their Slack thread with each item’s own `chase_text` (3 working hours apart, 08:30 to 17:00), records answers (Haiku judges), follows `on_answer` within strict limits, lapses an item with one card. The only words posted are `chase_text` and one fixed thank-you. |
| `trig_fridayreview` (background) | Fridays 15:45 | Acts on last week’s answered Proposal/Idea cards, raises one "Work week review" card, saves up to 3 kudos drafts in `slack_drafts` (Sonnet) and raises one proposal card. |

Model calls: direct Anthropic API, a daily cap per tier in `meta/llm-usage` (Haiku 200, Sonnet 30; `WORK_HAIKU_DAILY_CAP`, `WORK_SONNET_DAILY_CAP`), and a guard that refuses Fable and Mythos. No key, a spent cap or any failure means the job carries on without the model.

Run records: `_trigger_runs/<id>` holds when each job last fired and how it ended (error code only). Switch a job off or on: `POST /api/trigger {tool: "update_trigger", args: {trigger_id, enabled}}`; start one now: `fire_trigger`.

`POST /api/smoke` (bearer token) is a read-only check of Slack (auth, scopes, each watched channel), monday.com (auth, boards) and the model key and background settings. It answers booleans, scope names and error codes, never a secret. `{"llm": true}` adds one tiny Haiku call.

Kudos drafts are saved in `slack_drafts`, not on the board. `GET /api/slack-drafts` lists them; `POST {id, action: "send" | "dismiss"}` sends one into its thread (once), from a device whose token label is in `SLACK_SEND_ACTORS` (default `phone,chrome`).
