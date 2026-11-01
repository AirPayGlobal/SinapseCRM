import { createApp } from './app.js';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { startScheduler, stopScheduler } from './jobs/scheduler.js';
import crypto from 'node:crypto';
import { detectAppRole, pool, withSystem } from './db/pool.js';

/**
 * Use JWT_SECRET when provided; otherwise generate a strong secret once and keep it in the database,
 * so a deployment works without anyone generating a key by hand and sessions survive restarts.
 */
async function ensureJwtSecret() {
  if (process.env.JWT_SECRET) return;
  const candidate = crypto.randomBytes(48).toString('base64url');
  await pool.query(`INSERT INTO app_secrets (key, value) VALUES ('jwt_secret', $1) ON CONFLICT (key) DO NOTHING`, [candidate]);
  const r = await pool.query(`SELECT value FROM app_secrets WHERE key = 'jwt_secret'`);
  config.jwtSecret = r.rows[0].value;
  console.log('[auth] JWT_SECRET not set; using the generated secret stored in the database');
}

/** Load the reference configuration (idempotent) and, when SEED_DEMO=true, the demonstration data. */
async function seedOnStart() {
  if (process.env.SEED_ON_START === 'false') return;
  const { seedReference, seedDemo, seedDemoQueries } = await import('./db/seed.js');
  await withSystem(seedReference);
  if (process.env.SEED_DEMO === 'true' && (await withSystem(seedDemo))) {
    await seedDemoQueries();
    console.log('[seed] demo data created (demo accounts use the password Sinapse!2026)');
  }
}

async function main() {
  if (process.env.MIGRATE_ON_START !== 'false') await migrate(config.databaseUrl, () => undefined);
  await detectAppRole();
  await ensureJwtSecret();
  await seedOnStart();
  const server = createApp().listen(config.port, () => console.log(`Sinapse CRM API listening on :${config.port}`));
  startScheduler();
  const shutdown = () => {
    stopScheduler();
    server.close(() => pool.end().then(() => process.exit(0)));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
