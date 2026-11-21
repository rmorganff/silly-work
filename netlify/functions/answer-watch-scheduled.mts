import type { Config } from '@netlify/functions';
import { runScheduled } from '../../src/lib/scheduled';

/** Every 15 minutes, all year: answered cards nobody is acting on get a task and a hold; stalled tasks and failed runs are reported. */
export default async () => { await runScheduled('trig_answerwatch'); };

export const config: Config = { schedule: '*/15 * * * *' };
