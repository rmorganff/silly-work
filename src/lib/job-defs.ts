/**
 * What each scheduled job on this site is: its id, name, schedule and expected rhythm. No code runs from here, so the
 * health check can read it without importing the jobs themselves. The schedule strings are for display; the real cron
 * lives in each function file's `config.schedule` (UTC), and `slot` is the London time the run guard checks.
 */
import type { LondonSlot } from './london';

export interface JobMeta {
  id: string;
  name: string;
  /** Netlify function file that holds its schedule, for display and for the tests that keep the two in step. */
  function: string;
  /** What the schedule means, in London time. */
  cron_expression: string;
  /** The UTC cron the function file declares. A job with a `slot` lists both UTC hours it can land on. */
  netlify_cron: string;
  /** The London time a scheduled run is allowed to proceed at; other hours exit early. Absent = every run proceeds. */
  slot?: LondonSlot;
  /** How often it should run. The health check calls it missed after three of these. */
  every_ms: number;
  /** Seeded enabled, or dormant until switched on with update_trigger. */
  default_enabled: boolean;
  /** Minimum time between two fires through /api/trigger. */
  cooldown_ms: number;
  /** The label its writes carry in the audit log. */
  actor: string;
}

const MIN = 60_000, DAY = 86_400_000;

export const JOB_DEFS: JobMeta[] = [
  {
    id: 'trig_answerwatch', name: 'Answer watch', function: 'answer-watch-scheduled', cron_expression: 'every 15 minutes', netlify_cron: '*/15 * * * *',
    every_ms: 15 * MIN, default_enabled: true, cooldown_ms: 2 * MIN, actor: 'answer-watch',
  },
  {
    id: 'trig_healthcheck', name: 'Health check', function: 'health-check-scheduled', cron_expression: 'daily 09:20 London', netlify_cron: '20 8,9 * * *',
    slot: { hour: 9 }, every_ms: DAY, default_enabled: true, cooldown_ms: 10 * MIN, actor: 'health-check',
  },
  {
    id: 'trig_fridayreview', name: 'Friday review', function: 'friday-review-scheduled', cron_expression: 'Fridays 15:50 London', netlify_cron: '50 14,15 * * 5',
    slot: { hour: 15, weekday: 5 }, every_ms: 7 * DAY, default_enabled: false, cooldown_ms: 10 * MIN, actor: 'friday-review',
  },
];
export const jobMeta = (id: string): JobMeta | undefined => JOB_DEFS.find((j) => j.id === id);
