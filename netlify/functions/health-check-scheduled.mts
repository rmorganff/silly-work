import type { Config } from '@netlify/functions';
import { runScheduled } from '../../src/lib/scheduled';

/**
 * 09:20 Europe/London all year. Netlify cron is UTC, so it is scheduled on both hours it can land on (08:20 UTC in summer,
 * 09:20 UTC in winter) and the run that lands on the wrong London hour exits at once (job-defs.ts: slot hour 9).
 */
export default async () => { await runScheduled('trig_healthcheck'); };

export const config: Config = { schedule: '20 8,9 * * *' };
