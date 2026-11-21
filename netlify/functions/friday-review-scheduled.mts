import type { Config } from '@netlify/functions';
import { runScheduled } from '../../src/lib/scheduled';

/**
 * Fridays 15:45 Europe/London all year (14:45 UTC in summer, 15:45 UTC in winter; the wrong one exits at once). Starts friday-review-background.
 */
export default async () => { await runScheduled('trig_fridayreview'); };

export const config: Config = { schedule: '45 14,15 * * 5' };
