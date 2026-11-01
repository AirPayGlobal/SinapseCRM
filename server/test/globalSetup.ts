import pg from 'pg';

export default async function setup() {
  const url = new URL(process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/sinapse_test');
  const dbName = url.pathname.slice(1);
  const admin = new pg.Client({ connectionString: `${url.protocol}//${url.username}${url.password ? ':' + url.password : ''}@${url.host}/postgres` });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  process.env.DATABASE_URL = url.toString();
  const { migrate } = await import('../src/db/migrate.js');
  await migrate(url.toString(), () => undefined);
  const { withSystem, pool } = await import('../src/db/pool.js');
  const { seedReference, seedDemo } = await import('../src/db/seed.js');
  await withSystem(seedReference);
  await withSystem(seedDemo);
  await pool.end();
}
