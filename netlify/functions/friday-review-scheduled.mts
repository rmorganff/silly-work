import type { Config } from '@netlify/functions';
import { runScheduled } from '../../src/lib/scheduled';

/**
 * Fridays 15:50 Europe/London all year (14:50 UTC in summer, 15:50 UTC in winter; the wrong one exits at once). Seeded dormant:
 * it does nothing until `update_trigger {trigger_id: 'trig_fridayreview', enabled: true}` switches it on.
 */
export default async () => { await runScheduled('trig_fridayreview'); };

export const config: Config = { schedule: '50 14,15 * * 5' };
