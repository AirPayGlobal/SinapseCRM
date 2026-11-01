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

/**
 * Bootstrap or recover an administrator without shell access: when ADMIN_EMAIL and ADMIN_PASSWORD
 * are set, that account is created (or re-activated with the given password) on start.
 */
async function ensureAdmin() {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) return;
  if (password.length < 10) {
    console.warn('[auth] ADMIN_PASSWORD must be at least 10 characters; administrator not created');
    return;
  }
  const bcrypt = (await import('bcryptjs')).default;
  const hash = await bcrypt.hash(password, 10);
  await withSystem(async (tx) => {
    const u = await tx.query(
      `INSERT INTO users (email, name, role_key, password_hash, active) VALUES ($1, 'Administrator', 'admin', $2, true)
       ON CONFLICT ((lower(email))) DO UPDATE SET role_key = 'admin', password_hash = EXCLUDED.password_hash, active = true, updated_at = now()
       RETURNING id`,
      [email, hash],
    );
    await tx.query('INSERT INTO agent_availability (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [u.rows[0].id]);
    await tx.query(
      `INSERT INTO event_log (actor_type, actor_name, action, entity, entity_id, after) VALUES ('system', 'start-up', 'user.admin_bootstrapped', 'user', $1, $2)`,
      [u.rows[0].id, JSON.stringify({ email })],
    );
  });
  console.log(`[auth] administrator ${email} is ready — remove ADMIN_PASSWORD from the environment once you have signed in`);
}

/** Load the reference configuration (idempotent) and, when SEED_DEMO=true, the demonstration data. */
async function seedOnStart() {
  if (process.env.SEED_ON_START === 'false') return;
  const { seedReference, seedDemo, seedDemoQueries } = await import('./db/seed.js');
  await withSystem(seedReference);
  if (process.env.SEED_DEMO === 'true' && (await withSystem(seedDemo))) {
    await seedDemoQueries();
    console.log(`[seed] demo data created (demo accounts use ${process.env.DEMO_PASSWORD ? 'DEMO_PASSWORD' : 'the default password from the README'})`);
  }
}

async function main() {
  if (process.env.MIGRATE_ON_START !== 'false') await migrate(config.databaseUrl, () => undefined);
  await detectAppRole();
  await ensureJwtSecret();
  await seedOnStart();
  await ensureAdmin();
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
