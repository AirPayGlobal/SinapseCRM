import crypto from 'node:crypto';
import { one, type Tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { systemCtx } from '../lib/context.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { emit } from './events.js';
import { notify } from './notifications.js';
import { getSetting } from './settings.js';

export async function requestSatisfaction(tx: Tx, q: any, vars: Record<string, any>) {
  const token = crypto.randomBytes(18).toString('base64url');
  const r = await one(
    tx,
    `INSERT INTO satisfaction_responses (query_id, contact_id, token) VALUES ($1,$2,$3)
     ON CONFLICT (query_id) DO NOTHING RETURNING token`,
    [q.id, q.contact_id, token],
  );
  if (r) {
    await notify(tx, { template: 'satisfaction_request', to: { type: 'contact', id: q.contact_id }, vars: { ...vars, survey_url: `${vars.portal_url}/survey/${r.token}` }, queryId: q.id });
  }
}

/**
 * Satisfaction capture with follow-up: a poor score opens a follow-up case automatically rather
 * than sitting in a report.
 */
export async function recordSatisfaction(tx: Tx, token: string, score: number, comment?: string) {
  if (!Number.isInteger(score) || score < 1 || score > 5) throw badRequest('Score must be 1 to 5');
  const s = await one(tx, 'SELECT * FROM satisfaction_responses WHERE token = $1 FOR UPDATE', [token]);
  if (!s) throw notFound('Survey not found');
  if (s.responded_at) throw conflict('This survey has already been answered');
  await tx.query('UPDATE satisfaction_responses SET score = $2, comment = $3, responded_at = now() WHERE id = $1', [s.id, score, comment ?? null]);
  const q = await one(tx, 'SELECT * FROM queries WHERE id = $1', [s.query_id]);
  const ctx = systemCtx('satisfaction');
  await audit(tx, ctx, 'satisfaction.recorded', 'query', s.query_id, undefined, { score });
  await emit(tx, 'satisfaction.received', { query_id: s.query_id, reference: q.reference, score });
  let followup: any = null;
  if (score <= (await getSetting<number>(tx, 'satisfaction.followup_max_score'))) {
    const { intake } = await import('./intake.js');
    const r = await intake(tx, ctx, {
      channel: 'staff',
      subject: `Follow-up: low satisfaction score (${score}/5) on ${q.reference}`,
      body: `The customer rated the handling of ${q.reference} "${q.subject}" ${score}/5.${comment ? `\n\nCustomer comment: ${comment}` : ''}\n\nPlease contact the customer to understand and recover the experience.`,
      contactId: q.contact_id, companyId: q.company_id, port: q.port_code,
      queryTypeKey: 'service_recovery', urgency: 'high',
    });
    followup = r.query;
    await tx.query('UPDATE satisfaction_responses SET followup_query_id = $2 WHERE id = $1', [s.id, followup.id]);
  }
  return { score, followup_reference: followup?.reference ?? null };
}
