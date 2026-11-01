import pg from 'pg';
import { config } from '../config.js';

// Return numerics/bigints as JS numbers (values here are counts and small decimals)
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 20 });
export const analyticsPool =
  config.analyticsDatabaseUrl === config.databaseUrl
    ? pool
    : new pg.Pool({ connectionString: config.analyticsDatabaseUrl, max: 10 });

export type Tx = pg.PoolClient;

/**
 * The data scope under which a unit of work runs. It is turned into session settings that
 * the row-level-security policies read, so that access control is evaluated inside every query.
 */
export interface Scope {
  kind: 'system' | 'staff' | 'customer' | 'public';
  ports?: string[] | '*';
  departments?: string[] | '*';
  companies?: string[];
  contactId?: string;
}

export const SYSTEM: Scope = { kind: 'system' };
export const PUBLIC: Scope = { kind: 'public' };

async function applyScope(client: pg.PoolClient, scope: Scope) {
  if (config.dbAppRole) await client.query(`SET LOCAL ROLE ${config.dbAppRole}`);
  const list = (v: string[] | '*' | undefined) => (v === '*' ? '*' : (v ?? []).join(','));
  await client.query(
    `SELECT set_config('app.scope', $1, true), set_config('app.ports', $2, true),
            set_config('app.departments', $3, true), set_config('app.companies', $4, true),
            set_config('app.contact', $5, true)`,
    [scope.kind, list(scope.ports), list(scope.departments), (scope.companies ?? []).join(','), scope.contactId ?? ''],
  );
}

/** Run `fn` in a transaction under the given data scope. */
export async function withScope<T>(scope: Scope, fn: (tx: Tx) => Promise<T>, p: pg.Pool = pool): Promise<T> {
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    await applyScope(client, scope);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export const withSystem = <T>(fn: (tx: Tx) => Promise<T>) => withScope(SYSTEM, fn);

/** Read-only work against the analytics replica, still under the caller's scope. */
export const withAnalytics = <T>(scope: Scope, fn: (tx: Tx) => Promise<T>) => withScope(scope, fn, analyticsPool);

export async function one<T = any>(tx: Tx, sql: string, params: unknown[] = []): Promise<T | null> {
  const r = await tx.query(sql, params);
  return (r.rows[0] as T) ?? null;
}

export async function many<T = any>(tx: Tx, sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await tx.query(sql, params);
  return r.rows as T[];
}

/**
 * Run an engine step (assignment, intake pipeline, SLA evaluation) with system scope inside the
 * caller's transaction, then restore the caller's scope. Engines need whole-system visibility —
 * an agent's weighted load counts all of their open work — while everything the caller reads
 * remains subject to their own scope.
 */
export async function asSystem<T>(tx: Tx, fn: () => Promise<T>): Promise<T> {
  const prev = (await tx.query(`SELECT current_setting('app.scope', true) AS s`)).rows[0]?.s ?? '';
  if (prev === 'system') return fn();
  await tx.query(`SELECT set_config('app.scope', 'system', true)`);
  try {
    return await fn();
  } finally {
    await tx.query(`SELECT set_config('app.scope', $1, true)`, [prev]).catch(() => undefined);
  }
}

/** Run several queries on one connection one after another (a client cannot pipeline them). */
export async function inSequence<T extends readonly (() => unknown)[]>(fns: T): Promise<{ [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  const out: unknown[] = [];
  for (const f of fns) out.push(await f());
  return out as any;
}
