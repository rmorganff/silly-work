import { createClient, type Client } from '@libsql/client';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let shared: Client | null = null;

/** The Turso client for this function copy. Tests pass their own (file::memory:). */
export function getClient(): Client {
  if (shared) return shared;
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) throw new Error('TURSO_DATABASE_URL is not set');
  shared = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
  return shared;
}

export function migrationsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
}

/** Runs every migrations/*.sql in name order. All statements are IF NOT EXISTS / INSERT OR IGNORE, so it is safe to repeat. */
export async function migrate(client: Client, dir = migrationsDir()): Promise<string[]> {
  const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = readFileSync(join(dir, f), 'utf8');
    await client.executeMultiple(sql);
  }
  return files;
}
