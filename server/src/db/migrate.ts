import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from '../config.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * Hosted-Postgres hardening, re-applied after every migration run (idempotent):
 *
 *  - Supabase exposes the public schema through its Data API to the `anon` and `authenticated`
 *    roles, with default grants on every new table. Sinapse CRM never uses that API, so those
 *    roles lose all access to the schema.
 *  - Supabase can also switch row-level security on automatically for every new table. Tables
 *    that carry Sinapse's own policies keep them; any other table that has RLS on but no policy
 *    gets a single policy admitting only the application role, so it stays closed to everyone else.
 */
export const RECONCILE_SQL = `
DO $reconcile$
DECLARE
  r text;
  t record;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sinapse_app') THEN
    FOR t IN
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
         AND c.relname NOT IN ('app_secrets', 'schema_migrations')
         AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname)
    LOOP
      EXECUTE format('CREATE POLICY sinapse_app_access ON public.%I TO sinapse_app USING (true) WITH CHECK (true)', t.relname);
    END LOOP;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Sinapse RLS reconciliation skipped: %', SQLERRM;
END
$reconcile$;
`;

/** Apply pending SQL migrations in order. Runs as the schema owner, not the app role. */
export async function migrate(databaseUrl = config.databaseUrl, log = console.log) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
        await client.query('COMMIT');
        log(`migrated ${f}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${f} failed: ${(e as Error).message}`);
      }
    }
    await client.query(RECONCILE_SQL);
  } finally {
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  migrate().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
}
