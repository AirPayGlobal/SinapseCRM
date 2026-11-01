import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { many, one, type Tx, inSequence } from '../db/pool.js';
import { audit, diff } from '../lib/audit.js';
import { systemCtx, type Ctx } from '../lib/context.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { mask, maskAll } from '../lib/masking.js';
import { similarity } from '../lib/text.js';
import { validateCustomFields } from './customFields.js';
import { emit } from './events.js';
import { notify, usersWithRole } from './notifications.js';

/** Customer & Company Hub (CCP-01 .. CCP-01.5). */

export const normalizeRegNo = (s: string) => (s ?? '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();

/** Duplicate detection at the point of company creation: registration number and trading name. */
export async function findDuplicateCompanies(tx: Tx, registrationNo: string, name: string, tradingNames: string[] = [], excludeId?: string) {
  const exact = await many(
    tx,
    `SELECT id, name, registration_no, status FROM companies
      WHERE lower(regexp_replace(registration_no, '[^A-Za-z0-9]', '', 'g')) = $1 AND ($2::uuid IS NULL OR id <> $2)`,
    [normalizeRegNo(registrationNo), excludeId ?? null],
  );
  const names = [name, ...tradingNames].filter(Boolean);
  const candidates = await many(
    tx,
    `SELECT id, name, registration_no, trading_names, status FROM companies
      WHERE ($2::uuid IS NULL OR id <> $2)
        AND EXISTS (SELECT 1 FROM unnest(array_append(trading_names, name)) n, unnest($1::text[]) m
                     WHERE lower(n) = lower(m) OR lower(n) LIKE '%' || lower(split_part(m, ' ', 1)) || '%')`,
    [names, excludeId ?? null],
  );
  const strip = (s: string) => s.toLowerCase().replace(/\b(pty|ltd|limited|cc|inc|\(pty\)|namibia)\b/g, '').replace(/[^a-z0-9 ]/g, ' ').trim();
  const similar = candidates
    .map((c) => ({ ...c, score: Math.max(...[c.name, ...(c.trading_names ?? [])].flatMap((n: string) => names.map((m) => similarity(strip(n), strip(m))))) }))
    .filter((c) => c.score >= 0.7 && !exact.some((e) => e.id === c.id))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  return { exact, similar };
}

export interface CompanyInput {
  registration_no: string;
  name: string;
  trading_names?: string[];
  company_type?: string;
  ports_served?: string[];
  account_tier?: 'standard' | 'priority' | 'top10';
  service_agreement_ref?: string;
  sap_customer_id?: string;
  custom_fields?: Record<string, unknown>;
}

export async function createCompany(tx: Tx, ctx: Ctx, input: CompanyInput, opts: { force?: boolean; channel?: string; status?: string } = {}) {
  if (!input.registration_no?.trim() || !input.name?.trim()) throw badRequest('Registration number and name are required');
  const dups = await findDuplicateCompanies(tx, input.registration_no, input.name, input.trading_names);
  if (dups.exact.length) throw conflict(`A company with registration number ${input.registration_no} already exists`, dups);
  if (dups.similar.length && !opts.force) throw conflict('Possible duplicate company — confirm to create anyway', dups);
  const cf = await validateCustomFields(tx, 'company', input.custom_fields ?? {}, { actor: ctx });
  const c = await one(
    tx,
    `INSERT INTO companies (registration_no, name, trading_names, company_type, ports_served, account_tier, service_agreement_ref, sap_customer_id,
                            status, custom_fields, created_by_channel, approved_by, approved_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [input.registration_no.trim(), input.name.trim(), input.trading_names ?? [], input.company_type ?? null, input.ports_served ?? ['WB'],
     input.account_tier ?? 'standard', input.service_agreement_ref ?? null, input.sap_customer_id ?? null, opts.status ?? 'active',
     JSON.stringify(cf), opts.channel ?? 'staff', opts.status === 'pending' ? null : ctx.actorId, opts.status === 'pending' ? null : new Date()],
  );
  await audit(tx, ctx, 'company.created', 'company', c.id, undefined, c);
  return c;
}

const COMPANY_FIELDS = ['name', 'trading_names', 'company_type', 'ports_served', 'account_tier', 'service_agreement_ref', 'sap_customer_id', 'registration_no'] as const;
const CUSTOMER_EDITABLE = new Set(['name', 'trading_names', 'company_type', 'ports_served']);

export async function updateCompany(tx: Tx, ctx: Ctx, id: string, patch: Record<string, any>) {
  const c = await one(tx, 'SELECT * FROM companies WHERE id = $1 FOR UPDATE', [id]);
  if (!c) throw notFound('Company not found');
  if (ctx.actorType === 'contact') {
    const m = ctx.customer?.companies.find((x) => x.companyId === id);
    if (!m?.isPortalAdmin) throw forbidden('Only your company administrator can change company details');
  }
  const next: Record<string, any> = {};
  for (const k of COMPANY_FIELDS) {
    if (!(k in patch)) continue;
    if (ctx.actorType === 'contact' && !CUSTOMER_EDITABLE.has(k)) continue;
    next[k] = patch[k];
  }
  if (next.registration_no) {
    const d = await findDuplicateCompanies(tx, next.registration_no, c.name, [], id);
    if (d.exact.length) throw conflict('Registration number already in use', d);
  }
  if (patch.custom_fields) next.custom_fields = { ...c.custom_fields, ...(await validateCustomFields(tx, 'company', patch.custom_fields, { partial: true, actor: ctx })) };
  const d = diff(c, next);
  if (!d.changed) return c;
  const keys = Object.keys(d.after);
  await tx.query(
    `UPDATE companies SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`,
    [id, ...keys.map((k) => (k === 'custom_fields' ? JSON.stringify(d.after[k]) : d.after[k]))],
  );
  if ('account_tier' in d.after) {
    // Tier drives SLA targets and the escalation path; open cases pick up the new targets
    const { recomputeClock } = await import('./sla.js');
    for (const q of await many(tx, `SELECT id FROM queries WHERE company_id = $1 AND resolved_at IS NULL AND state NOT IN ('merged','filtered','closed')`, [id])) await recomputeClock(tx, q.id);
  }
  await audit(tx, ctx, 'company.updated', 'company', id, d.before, d.after);
  return one(tx, 'SELECT * FROM companies WHERE id = $1', [id]);
}

export async function listCompanies(tx: Tx, ctx: Ctx, f: { q?: string; status?: string; tier?: string; port?: string; limit?: number; offset?: number }) {
  const where: string[] = [];
  const p: unknown[] = [];
  if (f.q) { p.push(f.q); where.push(`(c.search @@ websearch_to_tsquery('english', $${p.length}) OR c.name ILIKE '%' || $${p.length} || '%' OR c.registration_no ILIKE '%' || $${p.length} || '%' OR EXISTS (SELECT 1 FROM unnest(c.trading_names) t WHERE t ILIKE '%' || $${p.length} || '%'))`); }
  if (f.status) { p.push(f.status); where.push(`c.status = $${p.length}`); }
  if (f.tier) { p.push(f.tier); where.push(`c.account_tier = $${p.length}`); }
  if (f.port) { p.push(f.port); where.push(`$${p.length} = ANY (c.ports_served)`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = await many(
    tx,
    `SELECT c.*, (SELECT count(*)::int FROM company_contacts cc WHERE cc.company_id = c.id AND cc.status = 'active') AS contact_count,
            (SELECT count(*)::int FROM queries q WHERE q.company_id = c.id AND q.state NOT IN ('resolved','closed','merged','filtered')) AS open_cases
       FROM companies c ${w} ORDER BY c.account_tier = 'top10' DESC, c.name LIMIT ${Math.min(Number(f.limit ?? 50), 200)} OFFSET ${Number(f.offset ?? 0)}`,
    p,
  );
  const total = await one<{ n: number }>(tx, `SELECT count(*)::int AS n FROM companies c ${w}`, p);
  return { items: maskAll('company', rows.map(({ search, ...r }) => r), ctx), total: total?.n ?? 0 };
}

export async function getCompany(tx: Tx, ctx: Ctx, id: string) {
  const c = await one(tx, 'SELECT * FROM companies WHERE id = $1', [id]);
  if (!c) throw notFound('Company not found');
  delete c.search;
  const contacts = await many(
    tx,
    `SELECT ct.id, ct.name, ct.email, ct.phone, ct.position, ct.status, cc.role, cc.is_portal_admin, cc.permissions, cc.status AS link_status,
            (SELECT array_agg(co.name) FROM company_contacts x JOIN companies co ON co.id = x.company_id WHERE x.contact_id = ct.id AND x.company_id <> $1 AND x.status='active') AS other_companies
       FROM company_contacts cc JOIN contacts ct ON ct.id = cc.contact_id
      WHERE cc.company_id = $1 ORDER BY cc.status, cc.role = 'primary' DESC, ct.name`,
    [id],
  );
  const timeline = await companyTimeline(tx, ctx, id);
  // Reads of sensitive customer records are logged as well as writes (CM01.3, SA-01.3)
  await audit(tx, ctx, 'company.read', 'company', id);
  return { ...mask('company', c, ctx), contacts: maskAll('contact', contacts, ctx), timeline };
}

/** CCP-01.5 — immutable chronological timeline per company across every channel. */
export async function companyTimeline(tx: Tx, ctx: Ctx, companyId: string, limit = 200) {
  const isCustomer = ctx.actorType === 'contact';
  return many(
    tx,
    `SELECT * FROM (
       SELECT i.id, 'interaction' AS kind, i.channel, i.direction, i.visibility, i.subject, left(i.body, 600) AS body, i.actor_name,
              i.occurred_at, q.reference, q.id AS query_id
         FROM interactions i LEFT JOIN queries q ON q.id = i.query_id
        WHERE (i.company_id = $1 OR q.company_id = $1) ${isCustomer ? `AND i.visibility = 'public'` : ''}
       UNION ALL
       SELECT a.id, 'document', 'document', 'inbound', a.visibility, a.filename, NULL, NULL, a.created_at, q.reference, q.id
         FROM attachments a LEFT JOIN queries q ON q.id = a.query_id
        WHERE (a.company_id = $1 OR q.company_id = $1) AND a.interaction_id IS NULL ${isCustomer ? `AND a.visibility = 'public'` : ''}
     ) t ORDER BY occurred_at DESC LIMIT ${limit}`,
    [companyId],
  );
}

// ---------------------------------------------------------------------------
// Contacts and the company–contact relationship (many-to-many with a role)
// ---------------------------------------------------------------------------

export async function createContact(tx: Tx, ctx: Ctx, input: { email: string; name: string; phone?: string; position?: string; custom_fields?: Record<string, unknown> }) {
  if (!input.email?.includes('@') || !input.name?.trim()) throw badRequest('Name and a valid email are required');
  const existing = await one(tx, 'SELECT * FROM contacts WHERE lower(email) = lower($1)', [input.email]);
  if (existing) return { contact: existing, existed: true };
  const cf = await validateCustomFields(tx, 'contact', input.custom_fields ?? {}, { actor: ctx });
  const c = await one(
    tx,
    `INSERT INTO contacts (email, name, phone, position, custom_fields, status) VALUES ($1,$2,$3,$4,$5,'active') RETURNING id, email, name, phone, position, status, created_at`,
    [input.email.trim().toLowerCase(), input.name.trim(), input.phone ?? null, input.position ?? null, JSON.stringify(cf)],
  );
  await audit(tx, ctx, 'contact.created', 'contact', c.id, undefined, c);
  return { contact: c, existed: false };
}

export async function getContact(tx: Tx, ctx: Ctx, id: string) {
  const c = await one(tx, `SELECT id, email, name, phone, position, status, email_verified, mfa_enabled, notification_preferences, custom_fields, created_at FROM contacts WHERE id = $1`, [id]);
  if (!c) throw notFound('Contact not found');
  const companies = await many(
    tx,
    `SELECT co.id, co.name, co.account_tier, cc.role, cc.is_portal_admin, cc.status FROM company_contacts cc JOIN companies co ON co.id = cc.company_id WHERE cc.contact_id = $1`,
    [id],
  );
  const timeline = await many(
    tx,
    `SELECT i.id, i.channel, i.direction, i.visibility, i.subject, left(i.body, 600) AS body, i.actor_name, i.occurred_at, q.reference, q.id AS query_id
       FROM interactions i LEFT JOIN queries q ON q.id = i.query_id
      WHERE i.contact_id = $1 OR q.contact_id = $1 ORDER BY i.occurred_at DESC LIMIT 200`,
    [id],
  );
  await audit(tx, ctx, 'contact.read', 'contact', id);
  return { ...mask('contact', c, ctx), companies, timeline };
}

export async function updateContact(tx: Tx, ctx: Ctx, id: string, patch: Record<string, any>) {
  const c = await one(tx, 'SELECT * FROM contacts WHERE id = $1 FOR UPDATE', [id]);
  if (!c) throw notFound('Contact not found');
  if (ctx.actorType === 'contact' && ctx.actorId !== id) throw forbidden('You can only update your own details');
  const next: Record<string, any> = {};
  for (const k of ['name', 'phone', 'position', 'notification_preferences', ...(ctx.actorType === 'user' ? ['email', 'status'] : [])]) if (k in patch) next[k] = patch[k];
  if (patch.custom_fields) next.custom_fields = { ...c.custom_fields, ...(await validateCustomFields(tx, 'contact', patch.custom_fields, { partial: true, actor: ctx })) };
  const d = diff(c, next);
  if (!d.changed) return c;
  const keys = Object.keys(d.after);
  await tx.query(
    `UPDATE contacts SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`,
    [id, ...keys.map((k) => (['custom_fields', 'notification_preferences'].includes(k) ? JSON.stringify(d.after[k]) : d.after[k]))],
  );
  await audit(tx, ctx, 'contact.updated', 'contact', id, d.before, d.after);
  await emit(tx, 'contact.updated', { id, fields: keys });
  return one(tx, 'SELECT id, email, name, phone, position, status, notification_preferences FROM contacts WHERE id = $1', [id]);
}

const ROLES = ['primary', 'operations', 'finance', 'escalation'];

export async function linkContact(tx: Tx, ctx: Ctx, companyId: string, contactId: string, opts: { role?: string; is_portal_admin?: boolean; permissions?: string[] }) {
  if (opts.role && !ROLES.includes(opts.role)) throw badRequest('Invalid relationship role');
  assertCompanyAdmin(ctx, companyId);
  const r = await one(
    tx,
    `INSERT INTO company_contacts (company_id, contact_id, role, is_portal_admin, permissions, status)
     VALUES ($1,$2,$3,$4,coalesce($5, '{log_query,view_company_queries}'::text[]),'active')
     ON CONFLICT (company_id, contact_id) DO UPDATE SET role = EXCLUDED.role, is_portal_admin = EXCLUDED.is_portal_admin,
            permissions = coalesce($5, company_contacts.permissions), status = 'active'
     RETURNING *`,
    [companyId, contactId, opts.role ?? 'operations', opts.is_portal_admin ?? false, opts.permissions ?? null],
  );
  await audit(tx, ctx, 'company_contact.linked', 'company', companyId, undefined, r);
  return r;
}

export async function unlinkContact(tx: Tx, ctx: Ctx, companyId: string, contactId: string) {
  assertCompanyAdmin(ctx, companyId);
  if (ctx.actorType === 'contact' && ctx.actorId === contactId) {
    const admins = await one<{ n: number }>(tx, `SELECT count(*)::int AS n FROM company_contacts WHERE company_id = $1 AND is_portal_admin AND status = 'active'`, [companyId]);
    if ((admins?.n ?? 0) <= 1) throw badRequest('Appoint another company administrator before removing yourself');
  }
  const r = await tx.query(`UPDATE company_contacts SET status = 'removed', is_portal_admin = false WHERE company_id = $1 AND contact_id = $2`, [companyId, contactId]);
  if (!r.rowCount) throw notFound('That person is not linked to this company');
  await audit(tx, ctx, 'company_contact.removed', 'company', companyId, { contact_id: contactId, status: 'active' }, { status: 'removed' });
}

function assertCompanyAdmin(ctx: Ctx, companyId: string) {
  if (ctx.actorType !== 'contact') return;
  const m = ctx.customer?.companies.find((x) => x.companyId === companyId);
  if (!m?.isPortalAdmin) throw forbidden('Only your company administrator can manage colleagues');
}

/** Company administrators add their own colleagues — Namport no longer keys users. */
export async function inviteColleague(tx: Tx, ctx: Ctx, companyId: string, input: { email: string; name: string; role?: string; is_portal_admin?: boolean; phone?: string; position?: string }) {
  assertCompanyAdmin(ctx, companyId);
  const sys = systemCtx('portal');
  const { contact, existed } = await createContact(tx, { ...sys, actorType: ctx.actorType, actorId: ctx.actorId, actorName: ctx.actorName }, input);
  const link = await linkContact(tx, ctx, companyId, contact.id, { role: input.role, is_portal_admin: input.is_portal_admin });
  let token: string | null = null;
  if (!existed) {
    token = crypto.randomBytes(24).toString('base64url');
    await tx.query('UPDATE contacts SET verification_token = $2 WHERE id = $1', [contact.id, token]);
  }
  const company = await one(tx, 'SELECT name FROM companies WHERE id = $1', [companyId]);
  await notify(tx, {
    template: 'colleague_invited', to: { type: 'contact', id: contact.id },
    vars: { contact: { name: contact.name }, company: { name: company?.name }, inviter: ctx.actorName,
            link: token ? `${process.env.PUBLIC_URL ?? 'http://localhost:5173'}/portal/activate?token=${token}` : `${process.env.PUBLIC_URL ?? 'http://localhost:5173'}/portal/login` },
    channels: ['email'],
  });
  return { contact, link, invited: !existed };
}

// ---------------------------------------------------------------------------
// Self-service registration (CCP-01.4) — customers register; Namport approves, it does not key.
// ---------------------------------------------------------------------------

export interface RegistrationInput {
  company: CompanyInput;
  contact: { email: string; name: string; phone?: string; position?: string; password: string };
}

export async function register(tx: Tx, input: RegistrationInput, meta: { ip?: string; userAgent?: string } = {}) {
  const ctx = { ...systemCtx('portal-registration'), ...meta };
  if (!input.contact?.password || input.contact.password.length < 10) throw badRequest('Password must be at least 10 characters');
  const existingContact = await one(tx, 'SELECT id FROM contacts WHERE lower(email) = lower($1)', [input.contact.email]);
  if (existingContact) throw conflict('An account with this email already exists — sign in or reset your password');

  const dups = await findDuplicateCompanies(tx, input.company.registration_no, input.company.name, input.company.trading_names);
  const token = crypto.randomBytes(24).toString('base64url');
  const contact = await one(
    tx,
    `INSERT INTO contacts (email, name, phone, position, password_hash, verification_token, status) VALUES ($1,$2,$3,$4,$5,$6,'pending')
     RETURNING id, email, name`,
    [input.contact.email.trim().toLowerCase(), input.contact.name.trim(), input.contact.phone ?? null, input.contact.position ?? null,
     await bcrypt.hash(input.contact.password, 10), token],
  );

  let company: any;
  let joinRequest = false;
  if (dups.exact.length) {
    // The company already exists: this becomes a request to join it, approved by its administrator or Namport.
    company = dups.exact[0];
    joinRequest = true;
    await tx.query(`INSERT INTO company_contacts (company_id, contact_id, role, is_portal_admin, status) VALUES ($1,$2,'operations',false,'removed')`, [company.id, contact.id]);
  } else {
    company = await createCompany(tx, ctx, { ...input.company, account_tier: 'standard' }, { force: true, channel: 'portal', status: 'pending' });
    await tx.query(`INSERT INTO company_contacts (company_id, contact_id, role, is_portal_admin) VALUES ($1,$2,'primary',true)`, [company.id, contact.id]);
  }
  await audit(tx, ctx, 'registration.submitted', 'company', company.id, undefined, { contact_id: contact.id, join_request: joinRequest, similar: dups.similar.map((s) => s.id) });
  await notify(tx, {
    template: 'verify_email', to: { type: 'contact', id: contact.id },
    vars: { contact, link: `${process.env.PUBLIC_URL ?? 'http://localhost:5173'}/portal/verify?token=${token}` }, channels: ['email'],
  });
  await emit(tx, 'company.registered', { company_id: company.id, contact_id: contact.id, join_request: joinRequest });
  return { contact_id: contact.id, company_id: company.id, join_request: joinRequest, similar_companies: dups.similar.length, verification_token: token };
}

export async function verifyEmail(tx: Tx, token: string, password?: string) {
  const c = await one(tx, 'SELECT id, status, password_hash FROM contacts WHERE verification_token = $1', [token]);
  if (!c) throw notFound('This verification link is invalid or has already been used');
  if (!c.password_hash && (!password || password.length < 10)) throw badRequest('Choose a password of at least 10 characters');
  await tx.query(
    `UPDATE contacts SET email_verified = true, verification_token = NULL, status = 'active', password_hash = coalesce($2, password_hash) WHERE id = $1`,
    [c.id, password ? await bcrypt.hash(password, 10) : null],
  );
  await audit(tx, systemCtx('portal'), 'contact.email_verified', 'contact', c.id);
  // Notify approvers once the registrant has proven their address
  const pending = await many(tx, `SELECT co.id, co.name FROM companies co JOIN company_contacts cc ON cc.company_id = co.id WHERE cc.contact_id = $1 AND co.status = 'pending'`, [c.id]);
  for (const p of pending) {
    for (const u of await usersWithRole(tx, 'supervisor')) {
      await notify(tx, { template: 'registration_pending', to: { type: 'user', id: u.id }, vars: { company: p }, channels: ['in_app'] });
    }
  }
  return { verified: true };
}

export async function registrationQueue(tx: Tx, ctx: Ctx) {
  const rows = await many(
    tx,
    `SELECT co.*, json_agg(json_build_object('id', ct.id, 'name', ct.name, 'email', ct.email, 'email_verified', ct.email_verified, 'phone', ct.phone)) AS contacts
       FROM companies co JOIN company_contacts cc ON cc.company_id = co.id JOIN contacts ct ON ct.id = cc.contact_id
      WHERE co.status = 'pending' GROUP BY co.id ORDER BY co.created_at`,
  );
  const out = [];
  for (const r of rows) {
    delete r.search;
    const d = await findDuplicateCompanies(tx, r.registration_no, r.name, r.trading_names, r.id);
    out.push({ ...mask('company', r, ctx), duplicate_check: d });
  }
  const joins = await many(
    tx,
    `SELECT cc.company_id, co.name AS company_name, ct.id AS contact_id, ct.name, ct.email, ct.email_verified, cc.created_at
       FROM company_contacts cc JOIN companies co ON co.id = cc.company_id JOIN contacts ct ON ct.id = cc.contact_id
      WHERE cc.status = 'removed' AND ct.status IN ('active','pending') AND co.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM event_log e WHERE e.entity = 'company' AND e.entity_id = cc.company_id::text AND e.action = 'company_contact.removed' AND e.before->>'contact_id' = ct.id::text)
      ORDER BY cc.created_at`,
  );
  return { registrations: out, join_requests: joins };
}

export async function decideRegistration(tx: Tx, ctx: Ctx, companyId: string, decision: 'approve' | 'reject', opts: { reason?: string; merge_into?: string } = {}) {
  const c = await one(tx, 'SELECT * FROM companies WHERE id = $1 FOR UPDATE', [companyId]);
  if (!c) throw notFound();
  if (c.status !== 'pending') throw conflict('Registration already decided');
  const contacts = await many(tx, `SELECT contact_id FROM company_contacts WHERE company_id = $1`, [companyId]);
  if (decision === 'approve' && opts.merge_into) {
    // Registrant's company is a duplicate of an existing profile: attach them to it instead.
    for (const ct of contacts) {
      await tx.query(`INSERT INTO company_contacts (company_id, contact_id, role, is_portal_admin) VALUES ($1,$2,'operations',false) ON CONFLICT DO NOTHING`, [opts.merge_into, ct.contact_id]);
    }
    await tx.query(`UPDATE companies SET status = 'rejected', updated_at = now() WHERE id = $1`, [companyId]);
    await audit(tx, ctx, 'registration.merged', 'company', companyId, { status: 'pending' }, { status: 'rejected', merged_into: opts.merge_into });
  } else {
    await tx.query(
      `UPDATE companies SET status = $2, approved_by = $3, approved_at = now(), updated_at = now() WHERE id = $1`,
      [companyId, decision === 'approve' ? 'active' : 'rejected', ctx.actorId],
    );
    await audit(tx, ctx, `registration.${decision}d`, 'company', companyId, { status: 'pending' }, { status: decision === 'approve' ? 'active' : 'rejected', reason: opts.reason });
  }
  for (const ct of contacts) {
    await notify(tx, { template: decision === 'approve' ? 'registration_approved' : 'registration_rejected', to: { type: 'contact', id: ct.contact_id },
      vars: { company: c, reason: opts.reason ?? '', portal_url: process.env.PUBLIC_URL ?? 'http://localhost:5173' }, channels: ['email'] });
  }
  if (decision === 'approve') await emit(tx, 'company.approved', { company_id: opts.merge_into ?? companyId });
  return { decision };
}

export async function decideJoinRequest(tx: Tx, ctx: Ctx, companyId: string, contactId: string, decision: 'approve' | 'reject') {
  assertCompanyAdmin(ctx, companyId);
  if (decision === 'approve') {
    await tx.query(`UPDATE company_contacts SET status = 'active' WHERE company_id = $1 AND contact_id = $2`, [companyId, contactId]);
    await audit(tx, ctx, 'company_contact.join_approved', 'company', companyId, undefined, { contact_id: contactId });
  } else {
    await tx.query(`DELETE FROM company_contacts WHERE company_id = $1 AND contact_id = $2 AND status = 'removed'`, [companyId, contactId]);
    await audit(tx, ctx, 'company_contact.join_rejected', 'company', companyId, undefined, { contact_id: contactId });
  }
}

// ---------------------------------------------------------------------------
// Global search (CCP-01.3, UE-01.3) — companies, contacts, queries, correspondence and documents.
// ---------------------------------------------------------------------------

export async function globalSearch(tx: Tx, ctx: Ctx, q: string, facets: { port?: string; tier?: string; status?: string; from?: string; to?: string } = {}) {
  if (!q?.trim()) return { companies: [], contacts: [], queries: [], correspondence: [], documents: [] };
  const like = `%${q.trim()}%`;
  const [companies, contacts, queries, correspondence, documents] = await inSequence([
    () => many(tx, `SELECT id, name, registration_no, account_tier, ports_served, status FROM companies
               WHERE (search @@ websearch_to_tsquery('english', $1) OR name ILIKE $2 OR registration_no ILIKE $2 OR EXISTS (SELECT 1 FROM unnest(trading_names) t WHERE t ILIKE $2))
                 AND ($3::text IS NULL OR $3 = ANY(ports_served)) AND ($4::text IS NULL OR account_tier = $4)
               ORDER BY ts_rank(search, websearch_to_tsquery('english', $1)) DESC, name LIMIT 10`, [q, like, facets.port ?? null, facets.tier ?? null]),
    () => many(tx, `SELECT id, name, email, phone, position FROM contacts WHERE search @@ websearch_to_tsquery('simple', $1) OR name ILIKE $2 OR email ILIKE $2 OR phone ILIKE $2 ORDER BY name LIMIT 10`, [q, like]),
    () => many(tx, `SELECT q.id, q.reference, q.subject, q.state, q.port_code, q.created_at, co.name AS company_name
                FROM queries q LEFT JOIN companies co ON co.id = q.company_id
               WHERE (q.search @@ websearch_to_tsquery('english', $1) OR q.reference ILIKE $2)
                 AND ($3::text IS NULL OR q.port_code = $3) AND ($4::text IS NULL OR q.state = $4)
                 AND ($5::timestamptz IS NULL OR q.created_at >= $5) AND ($6::timestamptz IS NULL OR q.created_at < $6)
               ORDER BY ts_rank(q.search, websearch_to_tsquery('english', $1)) DESC, q.created_at DESC LIMIT 15`,
      [q, like, facets.port ?? null, facets.status ?? null, facets.from ?? null, facets.to ?? null]),
    () => many(tx, `SELECT i.id, i.query_id, q.reference, i.channel, i.subject, ts_headline('english', i.body, websearch_to_tsquery('english', $1), 'MaxWords=25,MinWords=10') AS snippet, i.occurred_at
                FROM interactions i JOIN queries q ON q.id = i.query_id
               WHERE i.search @@ websearch_to_tsquery('english', $1) ORDER BY i.occurred_at DESC LIMIT 10`, [q]),
    () => many(tx, `SELECT a.id, a.query_id, q.reference, a.filename, ts_headline('english', coalesce(a.indexed_text,''), websearch_to_tsquery('english', $1), 'MaxWords=25,MinWords=10') AS snippet
                FROM attachments a LEFT JOIN queries q ON q.id = a.query_id
               WHERE a.search @@ websearch_to_tsquery('english', $1) ORDER BY a.created_at DESC LIMIT 10`, [q]),
  ]);
  return { companies: maskAll('company', companies, ctx), contacts: maskAll('contact', contacts, ctx), queries, correspondence, documents };
}
