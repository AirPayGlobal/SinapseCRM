import { createApp } from './app.js';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { startScheduler, stopScheduler } from './jobs/scheduler.js';
import { detectAppRole, pool } from './db/pool.js';

async function main() {
  if (process.env.MIGRATE_ON_START !== 'false') await migrate(config.databaseUrl, () => undefined);
  await detectAppRole();
  if (config.jwtSecret === 'dev-only-change-me' && process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET must be set in production');
  }
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
