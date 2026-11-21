import { handleBackground } from '../../src/lib/scheduled';

/** Netlify background function (up to 15 minutes): the Monday brief. Started by its scheduled function or /api/trigger with x-silly-trigger-secret. */
export default async (req: Request) => handleBackground(req, 'trig_weekbrief');
