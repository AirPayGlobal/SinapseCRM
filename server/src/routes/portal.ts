import { Router } from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { asSystem, many, one, PUBLIC, withScope, withSystem } from '../db/pool.js';
import { assistCtx } from '../lib/context.js';
import { badRequest, forbidden } from '../lib/errors.js';
import { ah, customer, db, qp } from '../lib/http.js';
import { converse, feedback } from '../services/assist.js';
import { storeAttachment } from '../services/attachments.js';
import { beginMfaEnrolment, confirmMfaEnrolment, customerLogin, requestPasswordReset } from '../services/auth.js';
import {
  companyTimeline, decideJoinRequest, getCompany, inviteColleague, linkContact, register, unlinkContact, updateCompany, updateContact, verifyEmail,
} from '../services/companies.js';
import { fieldDefs } from '../services/customFields.js';
import { intake } from '../services/intake.js';
import { customerMessage, getQueryDetail, listQueries } from '../services/queries.js';
import { listNotices } from '../services/port.js';
import { recordSatisfaction } from '../services/satisfaction.js';
import { transition } from '../services/workflow.js';

/**
 * Customer self-service portal (CCP-01.4, CCP-01.5) and the public endpoints behind the website
 * widget and Sinapse Assist. Everything a customer reads runs under their own data scope.
 */
export const portalRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadBytes } });
const meta = (req: any) => ({ requestId: req.ctx.requestId, ip: req.ctx.ip, userAgent: req.ctx.userAgent });

// ---- public -----------------------------------------------------------------
portalRouter.post('/register', ah(async (req, res) => {
  const b = req.body ?? {};
  if (!b.company?.registration_no || !b.company?.name || !b.contact?.email || !b.contact?.name) throw badRequest('Company registration number, company name, your name and email are required');
  const r = await withSystem((tx) => register(tx, b, meta(req)));
  // the verification token is emailed; it is only returned outside production to make local testing possible
  const { verification_token, ...rest } = r;
  res.status(201).json(process.env.NODE_ENV === 'production' ? rest : r);
}));
portalRouter.post('/verify', ah(async (req, res) => res.json(await withSystem((tx) => verifyEmail(tx, req.body?.token, req.body?.password)))));
portalRouter.post('/login', ah(async (req, res) => res.json(await customerLogin(req.body?.email ?? '', req.body?.password ?? '', req.body?.code, meta(req)))));
portalRouter.post('/password-reset', ah(async (req, res) => { await requestPasswordReset(req.body?.email ?? ''); res.json({ ok: true }); }));
portalRouter.get('/survey/:token', ah(async (req, res) => {
  const s = await withSystem((tx) => one(tx, `SELECT s.score, s.responded_at, q.reference, q.subject FROM satisfaction_responses s JOIN queries q ON q.id = s.query_id WHERE s.token = $1`, [req.params.token]));
  if (!s) throw badRequest('Survey not found');
  res.json(s);
}));
portalRouter.post('/survey/:token', ah(async (req, res) => res.json(await withSystem((tx) => recordSatisfaction(tx, req.params.token, Number(req.body?.score), req.body?.comment)))));
portalRouter.get('/query-types', ah(async (_req, res) => {
  res.json(await withSystem(async (tx) => ({
    types: await many(tx, `SELECT key, name FROM query_types WHERE active AND assist_routable ORDER BY name`),
    custom_fields: (await fieldDefs(tx, 'query')).filter((d) => d.customer_visible),
  })));
}));

/** Sinapse Assist: anonymous on the website (answers only), authenticated in the portal (answers and acts). */
portalRouter.post('/assist', ah(async (req, res) => {
  const b = req.body ?? {};
  const isCustomer = req.ctx.actorType === 'contact';
  const ctx = { ...assistCtx(isCustomer ? req.ctx.customer : undefined), ...meta(req) };
  const visitor = !isCustomer && b.visitor?.email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.visitor.email) ? b.visitor : undefined;
  const scope = isCustomer ? req.ctx.scope : PUBLIC;
  const r = await withScope(scope, (tx) => converse(tx, ctx, { session_id: b.session_id, message: b.message, channel: isCustomer ? (b.channel ?? 'portal') : 'website', visitor }));
  res.json(r);
}));
portalRouter.post('/assist/:sessionId/feedback', ah(async (req, res) => res.json(await withSystem((tx) => feedback(tx, req.params.sessionId, Boolean(req.body?.helpful))))));

/** Website widget query form (namport.com.na): a visitor logs a query with their email. */
portalRouter.post('/widget/query', ah(async (req, res) => {
  const b = req.body ?? {};
  if (!b.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email)) throw badRequest('A valid email address is required');
  if (b.website) return res.status(201).json({ ok: true }); // honeypot field — bots fill it, people do not
  const r = await withSystem((tx) => intake(tx, { actorType: 'system', actorId: null, actorName: b.name ?? b.email, scope: { kind: 'system' }, ...meta(req) }, {
    channel: 'widget', subject: b.subject, body: b.message ?? '', from: { email: b.email, name: b.name, phone: b.phone }, port: b.port,
  }));
  res.status(201).json({ reference: r.outcome === 'filtered' ? null : r.query.reference, outcome: r.outcome === 'filtered' ? 'received' : r.outcome });
}));

// ---- authenticated customer ---------------------------------------------------
portalRouter.use(customer);

portalRouter.get('/me', ah(async (req, res) => {
  res.json(await db(req, async (tx) => ({
    contact: await one(tx, 'SELECT id, email, name, phone, position, mfa_enabled, notification_preferences FROM contacts WHERE id = $1', [req.ctx.actorId]),
    companies: await many(tx, `SELECT co.id, co.name, co.registration_no, co.status, co.account_tier, cc.role, cc.is_portal_admin FROM company_contacts cc JOIN companies co ON co.id = cc.company_id
                                WHERE cc.contact_id = $1 AND cc.status = 'active'`, [req.ctx.actorId]),
    unread: (await one(tx, `SELECT count(*)::int AS n FROM notifications WHERE recipient_type = 'contact' AND recipient_id = $1 AND channel = 'portal' AND read_at IS NULL`, [req.ctx.actorId]))?.n ?? 0,
  })));
}));
portalRouter.patch('/me', ah(async (req, res) => res.json(await db(req, (tx) => updateContact(tx, req.ctx, req.ctx.actorId!, req.body ?? {})))));
portalRouter.post('/me/mfa', ah(async (req, res) => res.json(await db(req, (tx) => beginMfaEnrolment(tx, req.ctx)))));
portalRouter.post('/me/mfa/confirm', ah(async (req, res) => res.json(await db(req, (tx) => confirmMfaEnrolment(tx, req.ctx, req.body?.code ?? '')))));
portalRouter.get('/notifications', ah(async (req, res) => {
  res.json(await db(req, (tx) => many(tx, `SELECT id, subject, body, query_id, created_at, read_at FROM notifications WHERE recipient_type = 'contact' AND recipient_id = $1 AND channel = 'portal' ORDER BY created_at DESC LIMIT 50`, [req.ctx.actorId])));
}));
portalRouter.post('/notifications/read', ah(async (req, res) => {
  await db(req, (tx) => tx.query(`UPDATE notifications SET read_at = now() WHERE recipient_type = 'contact' AND recipient_id = $1 AND read_at IS NULL`, [req.ctx.actorId]));
  res.status(204).end();
}));
portalRouter.get('/notices', ah(async (req, res) => res.json(await db(req, (tx) => listNotices(tx, req.ctx.actorId!)))));

portalRouter.get('/queries', ah(async (req, res) => {
  const f = qp(req);
  res.json(await db(req, async (tx) => {
    const r = await listQueries(tx, req.ctx, { state: f.state, q: f.q, company_id: f.company_id, sort: 'created', limit: 100 });
    const labels = await many(tx, `SELECT DISTINCT ON (s->>'key') s->>'key' AS key, coalesce(s->>'customer_label', s->>'label') AS label FROM workflow_definitions w, jsonb_array_elements(w.definition->'states') s`);
    const map = Object.fromEntries(labels.map((l) => [l.key, l.label]));
    return { total: r.total, items: r.items.filter((q: any) => q.state !== 'filtered').map((q: any) => ({ id: q.id, reference: q.reference, subject: q.subject, status: map[q.state] ?? q.state, state: q.state,
      query_type_name: q.query_type_name, company_name: q.company_name, contact_name: q.contact_name, created_at: q.created_at, updated_at: q.updated_at, resolved_at: q.resolved_at })) };
  }));
}));
portalRouter.post('/queries', ah(async (req, res) => {
  const b = req.body ?? {};
  const companyId = b.company_id ?? req.ctx.customer!.companies[0]?.companyId ?? null;
  if (companyId && !req.ctx.customer!.companies.some((c) => c.companyId === companyId)) throw forbidden('You are not linked to that company');
  const membership = req.ctx.customer!.companies.find((c) => c.companyId === companyId);
  if (membership && !membership.permissions.includes('log_query')) throw forbidden('Your company administrator has not given you permission to log queries');
  const r = await db(req, (tx) => intake(tx, req.ctx, {
    channel: 'portal', subject: b.subject, body: b.description ?? '', contactId: req.ctx.actorId, companyId, port: b.port_code,
    queryTypeKey: b.query_type_key, customFields: b.custom_fields,
  }));
  res.status(201).json({ id: r.query.id, reference: r.query.reference, outcome: r.outcome === 'filtered' ? 'created' : r.outcome, first_response_due_at: r.query.first_response_due_at });
}));
portalRouter.get('/queries/:id', ah(async (req, res) => res.json(await db(req, (tx) => getQueryDetail(tx, req.ctx, req.params.id)))));
portalRouter.post('/queries/:id/messages', ah(async (req, res) => {
  if (!req.body?.body?.trim()) throw badRequest('Message is empty');
  await db(req, async (tx) => {
    const q = await one(tx, 'SELECT id FROM queries WHERE id = $1', [req.params.id]); // RLS: must be theirs
    if (!q) throw badRequest('Case not found');
    return customerMessage(tx, req.ctx, req.params.id, req.body.body);
  });
  res.status(201).json(await db(req, (tx) => getQueryDetail(tx, req.ctx, req.params.id)));
}));
portalRouter.post('/queries/:id/dispute', ah(async (req, res) => {
  await db(req, async (tx) => {
    const q = await one(tx, 'SELECT id FROM queries WHERE id = $1', [req.params.id]);
    if (!q) throw badRequest('Case not found');
    await asSystem(tx, () => transition(tx, req.ctx, req.params.id, 'reopened', { reason: req.body?.reason ?? 'Customer disputed the outcome' }));
  });
  res.json(await db(req, (tx) => getQueryDetail(tx, req.ctx, req.params.id)));
}));
portalRouter.post('/queries/:id/attachments', upload.single('file') as any, ah(async (req, res) => {
  if (!req.file) throw badRequest('Attach a file');
  res.status(201).json(await db(req, (tx) => storeAttachment(tx, req.ctx, req.file!, { query_id: req.params.id, visibility: 'public' })));
}));

// company administration by the customer's own administrator
const member = (req: any) => {
  const m = req.ctx.customer.companies.find((c: any) => c.companyId === req.params.companyId);
  if (!m) throw forbidden('You are not linked to that company');
  return m;
};
portalRouter.get('/companies/:companyId', ah(async (req, res) => {
  member(req);
  res.json(await db(req, async (tx) => {
    const c = await getCompany(tx, req.ctx, req.params.companyId);
    const joins = await many(tx, `SELECT ct.id, ct.name, ct.email, cc.created_at FROM company_contacts cc JOIN contacts ct ON ct.id = cc.contact_id
                                   WHERE cc.company_id = $1 AND cc.status = 'removed' AND ct.email_verified`, [req.params.companyId]).catch(() => []);
    const { sap_customer_id, service_agreement_ref, custom_fields, approved_by, ...pub } = c as any;
    return { ...pub, join_requests: member(req).isPortalAdmin ? joins : [] };
  }));
}));
portalRouter.patch('/companies/:companyId', ah(async (req, res) => { member(req); res.json(await db(req, (tx) => updateCompany(tx, req.ctx, req.params.companyId, req.body ?? {}))); }));
portalRouter.get('/companies/:companyId/timeline', ah(async (req, res) => { member(req); res.json(await db(req, (tx) => companyTimeline(tx, req.ctx, req.params.companyId))); }));
portalRouter.post('/companies/:companyId/colleagues', ah(async (req, res) => {
  member(req);
  res.status(201).json(await db(req, (tx) => asSystem(tx, () => inviteColleague(tx, req.ctx, req.params.companyId, req.body ?? {}))));
}));
portalRouter.patch('/companies/:companyId/colleagues/:contactId', ah(async (req, res) => {
  member(req);
  const b = req.body ?? {};
  res.json(await db(req, (tx) => asSystem(tx, () => linkContact(tx, req.ctx, req.params.companyId, req.params.contactId, { role: b.role, is_portal_admin: b.is_portal_admin, permissions: b.permissions }))));
}));
portalRouter.delete('/companies/:companyId/colleagues/:contactId', ah(async (req, res) => {
  member(req);
  await db(req, (tx) => asSystem(tx, () => unlinkContact(tx, req.ctx, req.params.companyId, req.params.contactId)));
  res.status(204).end();
}));
portalRouter.post('/companies/:companyId/join-requests/:contactId', ah(async (req, res) => {
  member(req);
  await db(req, (tx) => asSystem(tx, () => decideJoinRequest(tx, req.ctx, req.params.companyId, req.params.contactId, req.body?.decision === 'approve' ? 'approve' : 'reject')));
  res.status(204).end();
}));
portalRouter.get('/companies/:companyId/documents', ah(async (req, res) => {
  member(req);
  res.json(await db(req, (tx) => many(tx, `SELECT a.id, a.filename, a.mime_type, a.size_bytes, a.created_at, q.reference FROM attachments a LEFT JOIN queries q ON q.id = a.query_id
                                            WHERE (a.company_id = $1 OR q.company_id = $1) AND a.visibility = 'public' AND a.scan_status = 'clean' ORDER BY a.created_at DESC`, [req.params.companyId])));
}));
portalRouter.post('/companies/:companyId/documents', upload.single('file') as any, ah(async (req, res) => {
  member(req);
  if (!req.file) throw badRequest('Attach a file');
  res.status(201).json(await db(req, (tx) => storeAttachment(tx, req.ctx, req.file!, { company_id: req.params.companyId, visibility: 'public' })));
}));
