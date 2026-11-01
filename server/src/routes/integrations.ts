import { Router } from 'express';
import { withSystem } from '../db/pool.js';
import { systemCtx } from '../lib/context.js';
import { badRequest } from '../lib/errors.js';
import { ah, staff } from '../lib/http.js';
import { intake } from '../services/intake.js';
import { logIntegration } from '../integrations/fabric.js';
import { htmlToText, stripQuoted } from '../integrations/graph.js';
import { pollMailbox, syncCalendars } from '../jobs/integrationJobs.js';

/**
 * Inbound integration endpoints. Mail normally arrives by the scheduled Graph delta poll; this
 * endpoint accepts the same normalised message from a Graph change-notification relay, a mail
 * gateway, or a test harness. Idempotent on internetMessageId.
 */
export const integrationsRouter = Router();

integrationsRouter.post('/mail/inbound', staff('integration.manage'), ah(async (req, res) => {
  const m = req.body ?? {};
  const id = m.internetMessageId ?? m.message_id;
  const from = m.from?.emailAddress?.address ?? m.from;
  if (!id || !from) throw badRequest('internetMessageId and from are required');
  const body = stripQuoted(m.body?.contentType === 'html' ? htmlToText(m.body.content) : (m.body?.content ?? m.text ?? ''));
  const r = await withSystem((tx) => intake(tx, systemCtx('graph-mail'), {
    channel: 'email', subject: m.subject ?? '(no subject)', body, externalMessageId: id, threadId: m.conversationId,
    from: { email: from, name: m.from?.emailAddress?.name ?? m.from_name },
  }));
  await logIntegration(null, { connector: 'graph_mail', direction: 'inbound', operation: 'message', status: r.outcome === 'duplicate_message' ? 'duplicate' : 'success', correlationId: id, payload: { subject: m.subject, from, outcome: r.outcome, reference: r.query?.reference } });
  res.status(r.outcome === 'duplicate_message' ? 200 : 201).json({ outcome: r.outcome, reference: r.query?.reference ?? null });
}));

integrationsRouter.post('/mail/poll', staff('integration.manage'), ah(async (_req, res) => res.json(await pollMailbox())));
integrationsRouter.post('/calendar/sync', staff('integration.manage'), ah(async (_req, res) => res.json(await syncCalendars())));
