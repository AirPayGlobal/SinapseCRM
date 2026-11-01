import { Router } from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { many } from '../db/pool.js';
import { badRequest } from '../lib/errors.js';
import { ah, db, qp, staff } from '../lib/http.js';
import { storeAttachment } from '../services/attachments.js';
import {
  createCompany, createContact, decideJoinRequest, decideRegistration, findDuplicateCompanies, getCompany, getContact, globalSearch,
  linkContact, listCompanies, registrationQueue, unlinkContact, updateCompany, updateContact,
} from '../services/companies.js';
import { customerSummary, listQueries } from '../services/queries.js';
import { alignCompany, sapConfigured, searchPartners } from '../integrations/sap.js';

export const customersRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadBytes } });

customersRouter.get('/search', staff('customer.read', 'query.read'), ah(async (req, res) => {
  const f = qp(req);
  res.json(await db(req, (tx) => globalSearch(tx, req.ctx, f.q ?? '', { port: f.port, tier: f.tier, status: f.status, from: f.from, to: f.to })));
}));

customersRouter.get('/companies', staff('customer.read'), ah(async (req, res) => {
  res.json(await db(req, (tx) => listCompanies(tx, req.ctx, qp(req))));
}));

customersRouter.post('/companies/check-duplicates', staff('customer.write'), ah(async (req, res) => {
  res.json(await db(req, (tx) => findDuplicateCompanies(tx, req.body?.registration_no ?? '', req.body?.name ?? '', req.body?.trading_names ?? [])));
}));

customersRouter.post('/companies', staff('customer.write'), ah(async (req, res) => {
  res.status(201).json(await db(req, (tx) => createCompany(tx, req.ctx, req.body ?? {}, { force: req.body?.force === true })));
}));

customersRouter.get('/companies/:id', staff('customer.read'), ah(async (req, res) => {
  res.json(await db(req, async (tx) => ({
    ...(await getCompany(tx, req.ctx, req.params.id)),
    summary: await customerSummary(tx, req.params.id, null),
    queries: (await listQueries(tx, req.ctx, { company_id: req.params.id, sort: 'created', limit: 50 })).items,
  })));
}));

customersRouter.patch('/companies/:id', staff('customer.write'), ah(async (req, res) => {
  res.json(await db(req, (tx) => updateCompany(tx, req.ctx, req.params.id, req.body ?? {})));
}));

customersRouter.post('/companies/:id/contacts', staff('customer.write'), ah(async (req, res) => {
  const b = req.body ?? {};
  res.status(201).json(await db(req, async (tx) => {
    const contactId = b.contact_id ?? (await createContact(tx, req.ctx, b)).contact.id;
    return linkContact(tx, req.ctx, req.params.id, contactId, { role: b.role, is_portal_admin: b.is_portal_admin, permissions: b.permissions });
  }));
}));

customersRouter.delete('/companies/:id/contacts/:contactId', staff('customer.write'), ah(async (req, res) => {
  await db(req, (tx) => unlinkContact(tx, req.ctx, req.params.id, req.params.contactId));
  res.status(204).end();
}));

customersRouter.post('/companies/:id/documents', staff('customer.write'), upload.single('file') as any, ah(async (req, res) => {
  if (!req.file) throw badRequest('Attach a file');
  res.status(201).json(await db(req, (tx) => storeAttachment(tx, req.ctx, req.file!, { company_id: req.params.id, visibility: req.body?.visibility === 'internal' ? 'internal' : 'public' })));
}));

customersRouter.get('/companies/:id/documents', staff('customer.read'), ah(async (req, res) => {
  res.json(await db(req, (tx) => many(tx, `SELECT id, filename, mime_type, size_bytes, scan_status, visibility, created_at, query_id FROM attachments WHERE company_id = $1 ORDER BY created_at DESC`, [req.params.id])));
}));

customersRouter.post('/companies/:id/sap-align', staff('customer.write'), ah(async (req, res) => {
  if (!sapConfigured()) throw badRequest('The SAP S/4HANA connector is not configured');
  res.json(await alignCompany(req.params.id));
}));

customersRouter.get('/sap/partners', staff('customer.write'), ah(async (req, res) => {
  if (!sapConfigured()) throw badRequest('The SAP S/4HANA connector is not configured');
  res.json(await searchPartners(String(qp(req).q ?? '')));
}));

customersRouter.get('/contacts', staff('customer.read'), ah(async (req, res) => {
  const q = String(qp(req).q ?? '');
  res.json(await db(req, (tx) => many(tx,
    `SELECT c.id, c.name, c.email, c.phone, c.position, c.status,
            (SELECT json_agg(json_build_object('id', co.id, 'name', co.name, 'role', cc.role)) FROM company_contacts cc JOIN companies co ON co.id = cc.company_id
              WHERE cc.contact_id = c.id AND cc.status = 'active') AS companies
       FROM contacts c WHERE $1 = '' OR c.search @@ websearch_to_tsquery('simple', $1) OR c.name ILIKE '%' || $1 || '%' OR c.email ILIKE '%' || $1 || '%' OR c.phone ILIKE '%' || $1 || '%'
      ORDER BY c.name LIMIT 50`, [q])));
}));

customersRouter.post('/contacts', staff('customer.write'), ah(async (req, res) => {
  res.status(201).json(await db(req, (tx) => createContact(tx, req.ctx, req.body ?? {})));
}));

customersRouter.get('/contacts/:id', staff('customer.read'), ah(async (req, res) => {
  res.json(await db(req, (tx) => getContact(tx, req.ctx, req.params.id)));
}));

customersRouter.patch('/contacts/:id', staff('customer.write'), ah(async (req, res) => {
  res.json(await db(req, (tx) => updateContact(tx, req.ctx, req.params.id, req.body ?? {})));
}));

customersRouter.get('/registrations', staff('registration.approve'), ah(async (req, res) => {
  res.json(await db(req, (tx) => registrationQueue(tx, req.ctx)));
}));

customersRouter.post('/registrations/:id/decision', staff('registration.approve'), ah(async (req, res) => {
  const { decision, reason, merge_into } = req.body ?? {};
  if (!['approve', 'reject'].includes(decision)) throw badRequest('Decision must be approve or reject');
  res.json(await db(req, (tx) => decideRegistration(tx, req.ctx, req.params.id, decision, { reason, merge_into })));
}));

customersRouter.post('/companies/:id/join-requests/:contactId', staff('registration.approve'), ah(async (req, res) => {
  await db(req, (tx) => decideJoinRequest(tx, req.ctx, req.params.id, req.params.contactId, req.body?.decision === 'approve' ? 'approve' : 'reject'));
  res.status(204).end();
}));
