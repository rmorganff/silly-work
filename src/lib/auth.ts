import crypto from 'node:crypto';

/**
 * SILLY_WORK_API_TOKEN holds one or more per-device bearer tokens, comma separated, each optionally "label=token".
 * The label is what audit_log records as the actor. Returns the actor label, or null when the request is not authorised.
 */
export function authorise(req: Request, raw = process.env.SILLY_WORK_API_TOKEN): string | null {
  const h = req.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  if (!m || !raw) return null;
  const given = Buffer.from(m[1]);
  let actor: string | null = null;
  String(raw).split(',').map(s => s.trim()).filter(Boolean).forEach((entry, i) => {
    const eq = entry.indexOf('=');
    const label = eq > 0 ? entry.slice(0, eq) : `device${i + 1}`;
    const tok = Buffer.from(eq > 0 ? entry.slice(eq + 1) : entry);
    // Compare every entry in constant time; no early exit on a match.
    const same = tok.length === given.length && crypto.timingSafeEqual(tok, given);
    if (same && actor === null) actor = label;
  });
  return actor;
}

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });

export const unauthorised = () => json(401, { error: 'unauthorised', code: 'unauthorised' }, { 'www-authenticate': 'Bearer' });
