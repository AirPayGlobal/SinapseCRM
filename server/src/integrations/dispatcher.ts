import crypto from 'node:crypto';
import { config } from '../config.js';
import { many, withSystem } from '../db/pool.js';
import { connectorEnabled, logIntegration, MAX_ATTEMPTS, retryDelayMs } from './fabric.js';
import { graphConfigured, sendMail } from './graph.js';
import { postToTeams, teamsConfigured } from './teams.js';

/**
 * Outbound delivery: email (Graph send-as the customer-care mailbox) and Teams notifications from
 * the outbox, and webhook events to subscribing systems with an HMAC signature, retry and dead letter.
 * When a transport is not configured, messages are recorded as delivered to the local outbox so
 * non-production environments behave identically without sending anything.
 */
export async function dispatchNotifications(limit = 100) {
  const pending = await withSystem((tx) => many(tx,
    `SELECT n.*, coalesce(n.recipient_address, u.email, c.email) AS address
       FROM notifications n LEFT JOIN users u ON n.recipient_type = 'user' AND u.id = n.recipient_id
       LEFT JOIN contacts c ON n.recipient_type = 'contact' AND c.id = n.recipient_id
      WHERE n.status = 'pending' AND n.attempts < $1 ORDER BY n.created_at LIMIT $2 FOR UPDATE OF n SKIP LOCKED`, [MAX_ATTEMPTS, limit]));
  let sent = 0;
  for (const n of pending) {
    try {
      if (n.channel === 'email') {
        if (graphConfigured() && (await connectorEnabled('graph_mail'))) {
          if (!n.address) throw new Error('no address');
          await sendMail(n.address, n.subject, n.body);
        }
      } else if (n.channel === 'teams') {
        if (teamsConfigured() && (await connectorEnabled('teams'))) await postToTeams(n.subject, n.body, n.query_id ? `${config.publicUrl}/cases/${n.query_id}` : undefined);
      }
      await withSystem((tx) => tx.query(`UPDATE notifications SET status = 'sent', sent_at = now(), attempts = attempts + 1 WHERE id = $1`, [n.id]));
      sent++;
    } catch (e) {
      const attempts = n.attempts + 1;
      await withSystem((tx) => tx.query(`UPDATE notifications SET attempts = $2, last_error = $3, status = CASE WHEN $2 >= $4 THEN 'failed' ELSE 'pending' END WHERE id = $1`,
        [n.id, attempts, (e as Error).message.slice(0, 500), MAX_ATTEMPTS]));
      await logIntegration(null, { connector: n.channel === 'teams' ? 'teams' : 'graph_mail', direction: 'outbound', operation: `notify.${n.channel}`,
        status: attempts >= MAX_ATTEMPTS ? 'dead_letter' : 'retrying', correlationId: n.id, error: (e as Error).message, attempts });
    }
  }
  return sent;
}

export const signPayload = (secret: string, timestamp: string, body: string) =>
  crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

export async function deliverWebhooks(limit = 50) {
  const due = await withSystem((tx) => many(tx,
    `SELECT d.*, w.url, w.secret FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id
      WHERE d.status = 'pending' AND d.next_attempt_at <= now() AND w.active
      ORDER BY d.created_at LIMIT $1 FOR UPDATE OF d SKIP LOCKED`, [limit]));
  let delivered = 0;
  for (const d of due) {
    const body = JSON.stringify(d.payload);
    const ts = String(Math.floor(Date.now() / 1000));
    let code: number | null = null;
    let error: string | null = null;
    try {
      const r = await fetch(d.url, {
        method: 'POST', body, signal: AbortSignal.timeout(10_000),
        headers: { 'Content-Type': 'application/json', 'X-Sinapse-Event': d.event, 'X-Sinapse-Delivery': d.id,
                   'X-Sinapse-Timestamp': ts, 'X-Sinapse-Signature': `sha256=${signPayload(d.secret, ts, body)}` },
      });
      code = r.status;
      if (!r.ok) error = `HTTP ${r.status}`;
    } catch (e) {
      error = (e as Error).message;
    }
    const attempts = d.attempts + 1;
    const status = !error ? 'delivered' : attempts >= MAX_ATTEMPTS ? 'dead_letter' : 'pending';
    await withSystem((tx) => tx.query(
      `UPDATE webhook_deliveries SET attempts = $2, status = $3, response_code = $4, last_error = $5, next_attempt_at = $6 WHERE id = $1`,
      [d.id, attempts, status, code, error, new Date(Date.now() + retryDelayMs(attempts))]));
    await logIntegration(null, { connector: 'webhooks', direction: 'outbound', operation: d.event, status: !error ? 'success' : status === 'dead_letter' ? 'dead_letter' : 'retrying',
      correlationId: d.id, error, attempts });
    if (!error) delivered++;
  }
  return delivered;
}
