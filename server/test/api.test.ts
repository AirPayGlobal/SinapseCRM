import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { one, pool, withSystem } from '../src/db/pool.js';
import { uniq } from './helpers.js';

const app = createApp();
const PW = 'Sinapse!2026';
let agent: string, sup: string, ict: string, exec: string;

const login = async (email: string) => (await request(app).post('/api/v1/auth/login').send({ email, password: PW }).expect(200)).body.token as string;
const portalLogin = async (email: string) => (await request(app).post('/api/v1/portal/login').send({ email, password: PW }).expect(200)).body.token as string;

beforeAll(async () => {
  [agent, sup, ict, exec] = await Promise.all(['t.shikongo@namport.com.na', 'k.kaapanda@namport.com.na', 'ict@namport.com.na', 'e.angula@namport.com.na'].map(login));
});
afterAll(() => pool.end());

describe('staff API', () => {
  it('rejects anonymous and bad credentials', async () => {
    await request(app).get('/api/v1/queries').expect(401);
    await request(app).post('/api/v1/auth/login').send({ email: 't.shikongo@namport.com.na', password: 'wrong' }).expect(401);
  });

  it('quick capture logs a telephone query, then the agent works it from one screen', async () => {
    const c = await request(app).post('/api/v1/queries').set('Authorization', `Bearer ${agent}`)
      .send({ subject: 'Caller asks about berth for MSC Nuria', description: 'Hileni called: which quay is MSC Nuria on?', query_type_key: 'berthing', call: { duration_seconds: 120 } })
      .expect(201);
    expect(c.body.query.reference).toMatch(/^NAM-WB-/);
    const id = c.body.query.id;
    const d = await request(app).get(`/api/v1/queries/${id}`).set('Authorization', `Bearer ${agent}`).expect(200);
    expect(d.body.port_context.vessel_call.vessel_name).toBe('MSC Nuria');
    expect(d.body.transitions.length).toBeGreaterThan(0);
    const assist = await request(app).get(`/api/v1/queries/${id}/assist`).set('Authorization', `Bearer ${agent}`).expect(200);
    expect(assist.body.sources.length).toBeGreaterThan(0);
  });

  it('lists my queue sorted by SLA and supports full-text search', async () => {
    const r = await request(app).get('/api/v1/queries?open=true&sort=sla&q=berth').set('Authorization', `Bearer ${sup}`).expect(200);
    expect(r.body.items.length).toBeGreaterThan(0);
    expect(r.body.items[0].sla).toBeDefined();
  });

  it('enforces permissions: an agent cannot open the audit log; ICT can and the chain is intact', async () => {
    await request(app).get('/api/v1/admin/audit').set('Authorization', `Bearer ${agent}`).expect(403);
    const v = await request(app).get('/api/v1/admin/audit/verify').set('Authorization', `Bearer ${ict}`).expect(200);
    expect(v.body.intact).toBe(true);
  });

  it('serves live dashboards and exports reports as CSV, Excel and PDF', async () => {
    const d = await request(app).get('/api/v1/reports/dashboard').set('Authorization', `Bearer ${exec}`).expect(200);
    expect(d.body.kpis.volume).toBeGreaterThan(0);
    const def = { dimensions: ['query_type'], metrics: ['count', 'sla_attainment'], period_days: 30 };
    const run = await request(app).post('/api/v1/reports/builder/run').set('Authorization', `Bearer ${exec}`).send(def).expect(200);
    expect(run.body.rows.length).toBeGreaterThan(0);
    for (const format of ['csv', 'xlsx', 'pdf']) {
      const e = await request(app).post('/api/v1/reports/builder/export').set('Authorization', `Bearer ${exec}`).send({ definition: def, format, title: 'Volumes' }).buffer(true).expect(200);
      expect(e.headers['content-type']).toMatch(format === 'pdf' ? /pdf/ : format === 'csv' ? /csv/ : /excel/);
      if (format === 'pdf') expect(Buffer.from(e.body).toString('latin1').startsWith('%PDF-1.4')).toBe(true);
    }
  });

  it('publishes the OpenAPI description', async () => {
    const r = await request(app).get('/api/v1/openapi.json').expect(200);
    expect(r.body.openapi).toBe('3.0.3');
    expect(Object.keys(r.body.paths).length).toBeGreaterThan(50);
  });

  it('knowledge must be published by a named approver other than its author', async () => {
    const a = await request(app).post('/api/v1/kb/articles').set('Authorization', `Bearer ${agent}`).send({ title: 'Reefer pre-trip inspection', body: 'Reefers are inspected before loading.' }).expect(201);
    await request(app).post(`/api/v1/kb/articles/${a.body.id}/state`).set('Authorization', `Bearer ${agent}`).send({ to: 'review' }).expect(200);
    await request(app).post(`/api/v1/kb/articles/${a.body.id}/state`).set('Authorization', `Bearer ${agent}`).send({ to: 'published' }).expect(403);
    const p = await request(app).post(`/api/v1/kb/articles/${a.body.id}/state`).set('Authorization', `Bearer ${sup}`).send({ to: 'published' }).expect(200);
    expect(p.body.approved_by_name).toBe('Kristofina Kaapanda');
  });
});

describe('customer portal and Sinapse Assist', () => {
  it('a customer registers, verifies, is approved and logs a query — Namport keys nothing', async () => {
    const email = `${uniq('reg')}@example.na`;
    const reg = await request(app).post('/api/v1/portal/register').send({
      company: { registration_no: uniq('REG'), name: `Test Cargo ${uniq()} (Pty) Ltd`, ports_served: ['WB'] },
      contact: { email, name: 'Test Person', password: 'a-strong-password' },
    }).expect(201);
    await request(app).post('/api/v1/portal/login').send({ email, password: 'a-strong-password' }).expect(403); // not verified yet
    await request(app).post('/api/v1/portal/verify').send({ token: reg.body.verification_token }).expect(200);
    const queue = await request(app).get('/api/v1/customers/registrations').set('Authorization', `Bearer ${sup}`).expect(200);
    expect(queue.body.registrations.some((r: any) => r.id === reg.body.company_id)).toBe(true);
    await request(app).post(`/api/v1/customers/registrations/${reg.body.company_id}/decision`).set('Authorization', `Bearer ${sup}`).send({ decision: 'approve' }).expect(200);
    const t = (await request(app).post('/api/v1/portal/login').send({ email, password: 'a-strong-password' }).expect(200)).body.token;
    const q = await request(app).post('/api/v1/portal/queries').set('Authorization', `Bearer ${t}`).send({ subject: 'Storage charges', description: 'Please explain the storage charges on our invoice' }).expect(201);
    expect(q.body.reference).toMatch(/^NAM-WB-/);
    const mine = await request(app).get('/api/v1/portal/queries').set('Authorization', `Bearer ${t}`).expect(200);
    expect(mine.body.items).toHaveLength(1);
  });

  it('rejects a duplicate company registration number at staff creation', async () => {
    await request(app).post('/api/v1/customers/companies').set('Authorization', `Bearer ${sup}`).send({ registration_no: 'CC 2011 0442', name: 'Another Name' }).expect(409);
  });

  it('a company administrator adds and removes a colleague without Namport', async () => {
    const t = await portalLogin('hileni@namibclearing.com.na');
    const me = (await request(app).get('/api/v1/portal/me').set('Authorization', `Bearer ${t}`).expect(200)).body;
    const company = me.companies.find((c: any) => c.is_portal_admin);
    const email = `${uniq('colleague')}@namibclearing.com.na`;
    const added = await request(app).post(`/api/v1/portal/companies/${company.id}/colleagues`).set('Authorization', `Bearer ${t}`).send({ email, name: 'New Colleague', role: 'operations' }).expect(201);
    await request(app).delete(`/api/v1/portal/companies/${company.id}/colleagues/${added.body.contact.id}`).set('Authorization', `Bearer ${t}`).expect(204);
    // a non-admin colleague cannot do this
    const g = await portalLogin('ops@namibclearing.com.na');
    await request(app).post(`/api/v1/portal/companies/${company.id}/colleagues`).set('Authorization', `Bearer ${g}`).send({ email: `${uniq()}@x.na`, name: 'X' }).expect(403);
  });

  it('Assist answers from approved knowledge with the source shown', async () => {
    const r = await request(app).post('/api/v1/portal/assist').send({ message: 'What are your customer care office hours?' }).expect(200);
    expect(r.body.intent).toBe('answered');
    expect(r.body.reply).toMatch(/Source: Port operating hours/);
  });

  it('Assist declines tariffs and offers to route to Commercial; on "yes" it opens a case', async () => {
    const t = await portalLogin('bookings@kalaharifreight.com');
    const first = await request(app).post('/api/v1/portal/assist').set('Authorization', `Bearer ${t}`).send({ message: 'How much is the tariff for transhipping machinery?' }).expect(200);
    expect(first.body.intent).toBe('declined_tariff');
    const yes = await request(app).post('/api/v1/portal/assist').set('Authorization', `Bearer ${t}`).send({ session_id: first.body.session_id, message: 'yes please' }).expect(200);
    expect(yes.body.action.type).toBe('case_created');
    const q = await withSystem((tx) => one(tx, `SELECT q.query_type_key, i.body FROM queries q JOIN interactions i ON i.query_id = q.id AND i.channel = 'assist' WHERE q.reference = $1 LIMIT 1`, [yes.body.action.reference]));
    expect(q.query_type_key).toBe('tariff');
    expect(q.body).toMatch(/Sinapse Assist conversation/);
  });

  it('Assist declines rather than guesses and records a knowledge gap', async () => {
    const r = await request(app).post('/api/v1/portal/assist').send({ message: 'Do you sell souvenir hats at the harbour museum?' }).expect(200);
    expect(r.body.intent).toBe('declined_no_grounding');
    const gap = await withSystem((tx) => one(tx, `SELECT ask_count FROM knowledge_gaps WHERE sample_question ILIKE '%souvenir%'`));
    expect(gap.ask_count).toBeGreaterThanOrEqual(1);
  });

  it('Assist hands over the moment the customer asks for a person, with the whole conversation', async () => {
    const t = await portalLogin('hileni@namibclearing.com.na');
    const r = await request(app).post('/api/v1/portal/assist').set('Authorization', `Bearer ${t}`).send({ message: 'I want to speak to a person about our reefer containers' }).expect(200);
    expect(r.body.action.type).toBe('handover');
    const note = await withSystem((tx) => one(tx, `SELECT i.body FROM interactions i JOIN queries q ON q.id = i.query_id WHERE q.reference = $1 AND i.visibility = 'internal'`, [r.body.action.reference]));
    expect(note.body).toMatch(/customer asked for a person/);
  });

  it('Assist will not reveal another company’s case', async () => {
    const own = await withSystem((tx) => one(tx, `SELECT q.reference FROM queries q JOIN companies c ON c.id = q.company_id WHERE c.name = 'Namib Clearing (Pty) Ltd' LIMIT 1`));
    const t = await portalLogin('bookings@kalaharifreight.com');
    const r = await request(app).post('/api/v1/portal/assist').set('Authorization', `Bearer ${t}`).send({ message: `What is the status of ${own.reference}?` }).expect(200);
    expect(r.body.intent).toBe('track_not_found');
  });

  it('the website widget logs a query from a visitor email', async () => {
    const r = await request(app).post('/api/v1/portal/widget/query').send({ email: `${uniq()}@visitor.na`, name: 'Visitor', subject: 'Port tour', message: 'Can schools visit the port?' }).expect(201);
    expect(r.body.reference).toMatch(/^NAM-/);
  });
});

describe('integration fabric', () => {
  it('ingests inbound mail idempotently', async () => {
    const id = `<${uniq()}@graph>`;
    const body = { internetMessageId: id, from: { emailAddress: { address: 'ops@atlanticshipping.na', name: 'Rui' } }, subject: 'Pilot booking', body: { contentType: 'text', content: 'Please book a pilot for tomorrow' } };
    const a = await request(app).post('/api/v1/integrations/mail/inbound').set('Authorization', `Bearer ${ict}`).send(body).expect(201);
    const b = await request(app).post('/api/v1/integrations/mail/inbound').set('Authorization', `Bearer ${ict}`).send(body).expect(200);
    expect(b.body.outcome).toBe('duplicate_message');
    expect(b.body.reference).toBe(a.body.reference);
  });

  it('SCIM provisions a joiner and a leaver loses access immediately', async () => {
    const email = `${uniq('scim')}@namport.com.na`;
    const scim = (r: request.Test) => r.set('Authorization', 'Bearer scim-test-token');
    const u = await scim(request(app).post('/scim/v2/Users')).send({ userName: email, displayName: 'SCIM User', active: true, externalId: uniq(), roles: [{ value: 'agent', primary: true }] }).expect(201);
    await withSystem((tx) => tx.query(`UPDATE users SET password_hash = (SELECT password_hash FROM users WHERE email = 't.shikongo@namport.com.na') WHERE id = $1`, [u.body.id]));
    const t = await login(email);
    await request(app).get('/api/v1/me').set('Authorization', `Bearer ${t}`).expect(200);
    await scim(request(app).patch(`/scim/v2/Users/${u.body.id}`)).send({ Operations: [{ op: 'replace', path: 'active', value: false }] }).expect(200);
    await request(app).get('/api/v1/me').set('Authorization', `Bearer ${t}`).expect(401);
    await request(app).post('/scim/v2/Users').send({}).expect(401);
  });

  it('webhooks are queued for subscribed events', async () => {
    const w = await request(app).post('/api/v1/admin/webhooks').set('Authorization', `Bearer ${ict}`).send({ name: 'test', url: 'https://example.invalid/hook', events: ['query.created'] }).expect(201);
    expect(w.body.secret).toMatch(/^whsec_/);
    await request(app).post('/api/v1/queries').set('Authorization', `Bearer ${agent}`).send({ subject: 'Webhook trigger', description: 'General', query_type_key: 'general' }).expect(201);
    const d = await withSystem((tx) => one(tx, `SELECT count(*)::int AS n FROM webhook_deliveries WHERE webhook_id = $1`, [w.body.id]));
    expect(d.n).toBe(1);
  });
});
