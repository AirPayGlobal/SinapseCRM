import type { Tx } from '../db/pool.js';

/** Domain events that may be pushed to subscribing systems through outbound webhooks. */
export const WEBHOOK_EVENTS = [
  'query.created', 'query.assigned', 'query.state_changed', 'query.resolved', 'query.closed',
  'query.merged', 'query.escalated', 'query.breached', 'company.registered', 'company.approved',
  'contact.updated', 'finding.created', 'finding.closed', 'satisfaction.received', 'notice.sent',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export async function emit(tx: Tx, event: WebhookEvent, payload: Record<string, unknown>) {
  await tx.query(
    `INSERT INTO webhook_deliveries (webhook_id, event, payload)
     SELECT id, $1, $2 FROM webhooks WHERE active AND $1 = ANY (events)`,
    [event, JSON.stringify({ event, occurred_at: new Date().toISOString(), data: payload })],
  );
}
