import type { Config } from '@netlify/functions';
import { runScheduled } from '../../src/lib/scheduled';

/**
 * Weekdays 09:30 and 13:30 Europe/London all year (08:30 and 12:30 UTC in summer, 09:30 and 13:30 UTC in winter; the wrong pair exits at once). Starts chase-background.
 */
export default async () => { await runScheduled('trig_chase'); };

export const config: Config = { schedule: '30 8,9,12,13 * * 1-5' };
