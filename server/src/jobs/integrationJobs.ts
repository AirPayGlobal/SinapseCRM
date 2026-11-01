import { withSystem } from '../db/pool.js';
import { systemCtx } from '../lib/context.js';
import { intake } from '../services/intake.js';
import { getSetting, setSetting } from '../services/settings.js';
import { connectorEnabled, logIntegration } from '../integrations/fabric.js';
import { availabilityFor, fetchInboxDelta, graphConfigured, htmlToText, stripQuoted } from '../integrations/graph.js';

/** Ingest the shared customer-care mailbox through a Graph delta query. Idempotent on internetMessageId. */
export async function pollMailbox() {
  if (!graphConfigured() || !(await connectorEnabled('graph_mail'))) return { skipped: 'graph mail not configured' };
  const delta = await withSystem((tx) => getSetting<string | null>(tx, 'graph.mail_delta_link').catch(() => null));
  let result;
  try {
    result = await fetchInboxDelta(delta ?? null);
  } catch (e) {
    await logIntegration(null, { connector: 'graph_mail', direction: 'inbound', operation: 'delta', status: 'failed', error: (e as Error).message });
    throw e;
  }
  let created = 0, threaded = 0, duplicates = 0;
  for (const m of result.messages) {
    if (!m.internetMessageId || !m.from?.emailAddress?.address) continue;
    try {
      const body = stripQuoted(m.body?.contentType === 'html' ? htmlToText(m.body.content) : m.body?.content ?? m.bodyPreview ?? '');
      const r = await withSystem((tx) => intake(tx, systemCtx('graph-mail'), {
        channel: 'email', subject: m.subject ?? '(no subject)', body, externalMessageId: m.internetMessageId, threadId: m.conversationId,
        from: { email: m.from!.emailAddress.address, name: m.from!.emailAddress.name },
      }));
      if (r.outcome === 'duplicate_message') duplicates++; else if (r.outcome === 'threaded') threaded++; else created++;
      await logIntegration(null, { connector: 'graph_mail', direction: 'inbound', operation: 'message', status: r.outcome === 'duplicate_message' ? 'duplicate' : 'success', correlationId: m.internetMessageId, payload: { subject: m.subject, outcome: r.outcome, reference: r.query?.reference } });
    } catch (e) {
      await logIntegration(null, { connector: 'graph_mail', direction: 'inbound', operation: 'message', status: 'failed', correlationId: m.internetMessageId, error: (e as Error).message });
    }
  }
  if (result.deltaLink) await withSystem((tx) => setSetting(tx, 'graph.mail_delta_link', result.deltaLink));
  return { received: result.messages.length, created, threaded, duplicates };
}

/** Read out-of-office, leave and working hours from Outlook calendars into agent availability (TA-01.3). */
export async function syncCalendars() {
  if (!graphConfigured() || !(await connectorEnabled('graph_calendar'))) return { skipped: 'graph calendar not configured' };
  const users = await withSystem((tx) => tx.query(`SELECT id, email FROM users WHERE active AND role_key IN ('agent','supervisor')`).then((r) => r.rows));
  const from = new Date(), to = new Date(Date.now() + 14 * 86_400_000);
  let synced = 0;
  for (const u of users) {
    try {
      const a = await availabilityFor(u.email, from, to);
      await withSystem(async (tx) => {
        await tx.query(
          `INSERT INTO agent_availability (user_id, out_of_office, ooo_from, ooo_until, ooo_message, source, synced_at)
           VALUES ($1,$2,$3,$4,$5,'graph',now())
           ON CONFLICT (user_id) DO UPDATE SET out_of_office = $2, ooo_from = $3, ooo_until = $4, ooo_message = $5, source = 'graph', synced_at = now()`,
          [u.id, a.outOfOffice, a.oooFrom, a.oooUntil, a.oooMessage]);
        for (const ab of a.absences) {
          await tx.query(`INSERT INTO leave_periods (user_id, starts_at, ends_at, source, external_id) VALUES ($1,$2,$3,'graph',$4)
                          ON CONFLICT (user_id, external_id) DO UPDATE SET starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at`, [u.id, ab.starts_at, ab.ends_at, ab.id]);
        }
        await tx.query(`DELETE FROM leave_periods WHERE user_id = $1 AND source = 'graph' AND starts_at > now() AND NOT (external_id = ANY($2))`, [u.id, a.absences.map((x: { id: string }) => x.id)]);
      });
      synced++;
    } catch (e) {
      await logIntegration(null, { connector: 'graph_calendar', direction: 'inbound', operation: 'availability', status: 'failed', correlationId: u.email, error: (e as Error).message });
    }
  }
  if (synced) await logIntegration(null, { connector: 'graph_calendar', direction: 'inbound', operation: 'availability', status: 'success', payload: { synced } });
  return { users: users.length, synced };
}

