// npm run migrate : applies migrations/*.sql to TURSO_DATABASE_URL (idempotent).
import { getClient, migrate } from '../src/lib/db';
const files = await migrate(getClient());
console.log('applied', files.join(', '));
