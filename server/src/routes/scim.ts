import crypto from 'node:crypto';
import { Router, type Request } from 'express';
import { config } from '../config.js';
import { many, one, withSystem } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import type { Ctx } from '../lib/context.js';
import { ah } from '../lib/http.js';
import { logIntegration } from '../integrations/fabric.js';

/**
 * SCIM 2.0 provisioning endpoint for Microsoft Entra ID (joiners, movers, leavers). A leaver is
 * deactivated here and loses access on their next request — no separate administrative step.
 * Role, port and department are mapped from enterprise-extension attributes / Entra app roles.
 */
export const scimRouter = Router();
const SCHEMA_USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const SCHEMA_ENT = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';
const scimCtx = (req: Request): Ctx => ({ actorType: 'scim', actorId: null, actorName: 'Entra ID provisioning', scope: { kind: 'system' }, requestId: req.ctx?.requestId, ip: req.ctx?.ip });

scimRouter.use((req, res, next) => {
  const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  if (!config.scimToken || !token || token.length !== config.scimToken.length || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(config.scimToken))) {
    return res.status(401).json({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: '401', detail: 'Unauthorized' });
  }
  res.type('application/scim+json');
  next();
});

const toScim = (u: any) => ({
  schemas: [SCHEMA_USER, SCHEMA_ENT], id: u.id, externalId: u.scim_external_id, userName: u.email, active: u.active,
  name: { formatted: u.name }, displayName: u.name, emails: [{ value: u.email, primary: true, type: 'work' }],
  [SCHEMA_ENT]: { department: u.department_code ?? undefined }, roles: [{ value: u.role_key, primary: true }],
  meta: { resourceType: 'User', created: u.created_at, lastModified: u.updated_at, location: `/scim/v2/Users/${u.id}` },
});

const SELECT = `SELECT u.*, d.code AS department_code FROM users u LEFT JOIN departments d ON d.id = u.department_id`;

async function mapAttrs(tx: any, body: any) {
  const ent = body[SCHEMA_ENT] ?? {};
  const role = body.roles?.find((r: any) => r.primary)?.value ?? body.roles?.[0]?.value;
  const dept = ent.department ? await one(tx, 'SELECT id FROM departments WHERE lower(code) = lower($1) OR lower(name) = lower($1)', [ent.department]) : null;
  const validRole = role ? await one(tx, 'SELECT key FROM roles WHERE key = $1', [role]) : null;
  const port = /l(u|ü)deritz|^lz$/i.test(ent.division ?? body['urn:namport:port'] ?? '') ? 'LZ' : /walvis|^wb$/i.test(ent.division ?? body['urn:namport:port'] ?? '') ? 'WB' : undefined;
  return {
    email: (body.userName ?? body.emails?.[0]?.value ?? '').toLowerCase(),
    name: body.displayName ?? body.name?.formatted ?? [body.name?.givenName, body.name?.familyName].filter(Boolean).join(' '),
    active: body.active !== false,
    role_key: validRole?.key, department_id: dept?.id, port_code: port,
  };
}

scimRouter.get('/ServiceProviderConfig', (_req, res) => res.json({
  schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'], patch: { supported: true }, bulk: { supported: false },
  filter: { supported: true, maxResults: 200 }, changePassword: { supported: false }, sort: { supported: false }, etag: { supported: false },
  authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Bearer token', primary: true }],
}));

scimRouter.get('/Users', ah(async (req, res) => {
  const filter = String(req.query.filter ?? '');
  const m = filter.match(/(userName|externalId)\s+eq\s+"([^"]+)"/i);
  const rows = await withSystem((tx) => (m
    ? many(tx, `${SELECT} WHERE ${m[1].toLowerCase() === 'username' ? 'lower(u.email) = lower($1)' : 'u.scim_external_id = $1'}`, [m[2]])
    : many(tx, `${SELECT} ORDER BY u.created_at LIMIT 200`)));
  res.json({ schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'], totalResults: rows.length, startIndex: 1, itemsPerPage: rows.length, Resources: rows.map(toScim) });
}));

scimRouter.get('/Users/:id', ah(async (req, res) => {
  const u = await withSystem((tx) => one(tx, `${SELECT} WHERE u.id::text = $1`, [req.params.id]));
  if (!u) return res.status(404).json({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: '404' });
  res.json(toScim(u));
}));

scimRouter.post('/Users', ah(async (req, res) => {
  const u = await withSystem(async (tx) => {
    const a = await mapAttrs(tx, req.body ?? {});
    const existing = await one(tx, 'SELECT id FROM users WHERE lower(email) = $1', [a.email]);
    const row = existing
      ? await one(tx, `UPDATE users SET scim_external_id = $2, active = $3, name = coalesce(nullif($4,''), name), updated_at = now() WHERE id = $1 RETURNING id`, [existing.id, req.body.externalId ?? null, a.active, a.name])
      : await one(tx, `INSERT INTO users (email, name, role_key, port_code, department_id, active, scim_external_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [a.email, a.name || a.email, a.role_key ?? 'agent', a.port_code ?? null, a.department_id ?? null, a.active, req.body.externalId ?? null]);
    await tx.query('INSERT INTO agent_availability (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [row.id]);
    await audit(tx, scimCtx(req), 'scim.user_provisioned', 'user', row.id, undefined, a);
    return one(tx, `${SELECT} WHERE u.id = $1`, [row.id]);
  });
  await logIntegration(null, { connector: 'scim', direction: 'inbound', operation: 'Users.create', status: 'success', correlationId: u.email });
  res.status(201).json(toScim(u));
}));

async function applyChanges(req: Request, id: string, changes: Record<string, any>) {
  return withSystem(async (tx) => {
    const cur = await one(tx, 'SELECT * FROM users WHERE id::text = $1 FOR UPDATE', [id]);
    if (!cur) return null;
    const sets: string[] = [];
    const params: unknown[] = [cur.id];
    for (const [k, v] of Object.entries(changes)) if (v !== undefined && ['email', 'name', 'active', 'role_key', 'port_code', 'department_id'].includes(k)) { params.push(v); sets.push(`${k} = $${params.length}`); }
    if (sets.length) await tx.query(`UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
    await audit(tx, scimCtx(req), changes.active === false ? 'scim.user_deprovisioned' : 'scim.user_updated', 'user', cur.id,
      { active: cur.active, role_key: cur.role_key }, changes);
    if (changes.active === false) {
      // Leaver: their open cases return to the queue for reassignment
      await tx.query(`UPDATE queries SET assigned_to = NULL, assigned_at = NULL, state = 'triaged' WHERE assigned_to = $1 AND state IN ('assigned','in_progress')`, [cur.id]);
    }
    return one(tx, `${SELECT} WHERE u.id = $1`, [cur.id]);
  });
}

scimRouter.put('/Users/:id', ah(async (req, res) => {
  const a = await withSystem((tx) => mapAttrs(tx, req.body ?? {}));
  const u = await applyChanges(req, req.params.id, a);
  if (!u) return res.status(404).json({ status: '404' });
  res.json(toScim(u));
}));

scimRouter.patch('/Users/:id', ah(async (req, res) => {
  const changes: Record<string, any> = {};
  for (const op of req.body?.Operations ?? []) {
    const o = String(op.op).toLowerCase();
    if (o !== 'replace' && o !== 'add') continue;
    const vals = op.path ? { [op.path]: op.value } : op.value ?? {};
    for (const [p, v] of Object.entries(vals)) {
      if (p === 'active') changes.active = v === true || v === 'True' || v === 'true';
      if (p === 'userName') changes.email = String(v).toLowerCase();
      if (p === 'displayName' || p === 'name.formatted') changes.name = v;
      if (p === `${SCHEMA_ENT}:department`) {
        const d = await withSystem((tx) => one(tx, 'SELECT id FROM departments WHERE lower(code) = lower($1) OR lower(name) = lower($1)', [v]));
        if (d) changes.department_id = d.id;
      }
      if (p === 'roles' && Array.isArray(v) && v[0]?.value) changes.role_key = v[0].value;
    }
  }
  const u = await applyChanges(req, req.params.id, changes);
  if (!u) return res.status(404).json({ status: '404' });
  await logIntegration(null, { connector: 'scim', direction: 'inbound', operation: 'Users.patch', status: 'success', correlationId: u.email, payload: changes });
  res.json(toScim(u));
}));

scimRouter.delete('/Users/:id', ah(async (req, res) => {
  const u = await applyChanges(req, req.params.id, { active: false });
  if (!u) return res.status(404).json({ status: '404' });
  res.status(204).end();
}));
