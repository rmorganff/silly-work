import type { Config } from '@netlify/functions';
import { runScheduled } from '../../src/lib/scheduled';

/**
 * Mondays 07:45 Europe/London all year (06:45 UTC in summer, 07:45 UTC in winter; the wrong one exits at once). Starts week-brief-background.
 */
export default async () => { await runScheduled('trig_weekbrief'); };

export const config: Config = { schedule: '45 6,7 * * 1' };
