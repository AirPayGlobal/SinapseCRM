import { pool, withSystem, type Tx } from '../db/pool.js';

/**
 * Integration fabric (Module 7). Every external connection terminates here: each call is logged in
 * a first-class, queryable integration log; each connector reports health; failures land in a
 * dead-letter state with a retry policy and an alert. Connectors can be revoked without a release.
 */

export type ConnectorKey = 'entra' | 'scim' | 'graph_mail' | 'graph_calendar' | 'teams' | 'sap' | 'website' | 'webhooks';

export async function logIntegration(
  tx: Tx | null,
  e: { connector: ConnectorKey; direction: 'inbound' | 'outbound'; operation: string; status: 'success' | 'failed' | 'retrying' | 'dead_letter' | 'duplicate';
       correlationId?: string | null; payload?: unknown; error?: string | null; attempts?: number; nextRetryAt?: Date | null },
) {
  const sql = `INSERT INTO integration_log (connector_key, direction, operation, status, correlation_id, payload, error, attempts, next_retry_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`;
  const params = [e.connector, e.direction, e.operation, e.status, e.correlationId ?? null, e.payload === undefined ? null : JSON.stringify(e.payload),
                  e.error ?? null, e.attempts ?? 1, e.nextRetryAt ?? null];
  if (tx) await tx.query(sql, params);
  else await pool.query(sql, params);
  await markHealth(tx, e.connector, e.status === 'success' || e.status === 'duplicate', e.error ?? null);
}

export async function markHealth(tx: Tx | null, connector: ConnectorKey, ok: boolean, error: string | null) {
  const sql = ok
    ? `UPDATE integration_connectors SET status = CASE WHEN status = 'revoked' THEN status ELSE 'healthy' END, last_success_at = now() WHERE key = $1`
    : `UPDATE integration_connectors SET status = CASE WHEN status = 'revoked' THEN status
            WHEN last_success_at IS NULL OR last_success_at < now() - interval '15 minutes' THEN 'down' ELSE 'degraded' END,
            last_error_at = now(), last_error = $2 WHERE key = $1`;
  const params = ok ? [connector] : [connector, error];
  if (tx) await tx.query(sql, params);
  else await pool.query(sql, params);
}

export async function connectorEnabled(connector: ConnectorKey) {
  const r = await pool.query(`SELECT enabled, status FROM integration_connectors WHERE key = $1`, [connector]);
  return Boolean(r.rows[0]?.enabled && r.rows[0]?.status !== 'revoked');
}

/** Exponential back-off with a dead letter after the last attempt. */
export const retryDelayMs = (attempt: number) => Math.min(60 * 60_000, 30_000 * 2 ** (attempt - 1));
export const MAX_ATTEMPTS = 6;

export async function connectorHealth() {
  return withSystem(async (tx) => {
    const r = await tx.query(
      `SELECT c.key, c.name, c.enabled, c.status, c.last_success_at, c.last_error_at, c.last_error,
              (SELECT count(*)::int FROM integration_log l WHERE l.connector_key = c.key AND l.created_at > now() - interval '24 hours') AS calls_24h,
              (SELECT count(*)::int FROM integration_log l WHERE l.connector_key = c.key AND l.status IN ('failed','dead_letter') AND l.created_at > now() - interval '24 hours') AS failures_24h,
              (SELECT count(*)::int FROM integration_log l WHERE l.connector_key = c.key AND l.status = 'dead_letter') AS dead_letters
         FROM integration_connectors c ORDER BY c.name`,
    );
    return r.rows;
  });
}
