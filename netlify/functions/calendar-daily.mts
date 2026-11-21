import type { Config } from '@netlify/functions';
import { runScheduled } from '../../src/lib/scheduled';

/**
 * 06:50 Europe/London all year. Netlify cron is UTC, so it is scheduled on both hours it can land on (05:50 UTC in summer,
 * 06:50 UTC in winter) and the run that lands on the wrong London hour exits at once (job-defs.ts: slot hour 6). It fetches the
 * two iCal addresses at once and finishes in a few seconds, so it needs no background function.
 */
export default async () => { await runScheduled('trig_calendar'); };

export const config: Config = { schedule: '50 5,6 * * *' };
