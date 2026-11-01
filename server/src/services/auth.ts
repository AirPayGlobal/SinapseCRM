import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { many, one, withSystem, type Tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { customerScope, staffScope, systemCtx, type Ctx, type CustomerPrincipal, type StaffPrincipal } from '../lib/context.js';
import { badRequest, forbidden, HttpError, unauthorized } from '../lib/errors.js';
import { newTotpSecret, verifyTotp } from '../lib/totp.js';

/**
 * Two identity realms (SA-01.4): Namport staff through Microsoft Entra ID (with a local fallback that
 * can be disabled), external customers in a separate realm with email verification and optional MFA.
 * Principals are reloaded on every request, so a SCIM deprovisioning takes effect immediately.
 */

export interface TokenClaims { sub: string; realm: 'staff' | 'customer'; mfa?: boolean }

export const signToken = (c: TokenClaims, ttl = c.realm === 'staff' ? '10h' : '12h') =>
  jwt.sign(c, config.jwtSecret, { expiresIn: ttl as any, audience: `sinapse-${c.realm}`, issuer: 'sinapse-crm' });

export function verifyToken(token: string): TokenClaims {
  try {
    const decoded = jwt.verify(token, config.jwtSecret, { issuer: 'sinapse-crm' }) as any;
    if (decoded.aud !== `sinapse-${decoded.realm}`) throw new Error('realm mismatch');
    return decoded;
  } catch {
    throw unauthorized('Your session has expired — please sign in again');
  }
}

export async function loadStaff(tx: Tx, userId: string): Promise<StaffPrincipal | null> {
  const u = await one(tx,
    `SELECT u.id, u.email, u.name, u.role_key, u.port_code, u.department_id, u.active, r.permissions, r.field_masks, r.port_scope, r.dept_scope
       FROM users u JOIN roles r ON r.key = u.role_key WHERE u.id = $1`, [userId]);
  if (!u?.active) return null;
  return { id: u.id, email: u.email, name: u.name, roleKey: u.role_key, portCode: u.port_code, departmentId: u.department_id,
           permissions: u.permissions, fieldMasks: u.field_masks, portScope: u.port_scope, deptScope: u.dept_scope };
}

export async function loadCustomer(tx: Tx, contactId: string): Promise<CustomerPrincipal | null> {
  const c = await one(tx, `SELECT id, email, name, status FROM contacts WHERE id = $1`, [contactId]);
  if (!c || c.status === 'disabled') return null;
  const companies = await many(tx,
    `SELECT cc.company_id, cc.role, cc.is_portal_admin, cc.permissions FROM company_contacts cc JOIN companies co ON co.id = cc.company_id
      WHERE cc.contact_id = $1 AND cc.status = 'active' AND co.status IN ('active','pending')`, [contactId]);
  return { id: c.id, email: c.email, name: c.name, companies: companies.map((x) => ({ companyId: x.company_id, role: x.role, isPortalAdmin: x.is_portal_admin, permissions: x.permissions })) };
}

export function staffCtx(s: StaffPrincipal, meta: Partial<Ctx> = {}): Ctx {
  return { actorType: 'user', actorId: s.id, actorName: s.name, staff: s, scope: staffScope(s), ...meta };
}

export function customerCtx(c: CustomerPrincipal, meta: Partial<Ctx> = {}): Ctx {
  return { actorType: 'contact', actorId: c.id, actorName: c.name, customer: c, scope: customerScope(c), ...meta };
}

/** Throttle repeated failures per identity (simple in-memory window; front by the WAF in production). */
const failures = new Map<string, { n: number; until: number }>();
function checkThrottle(key: string) {
  const f = failures.get(key);
  if (f && f.n >= 5 && f.until > Date.now()) throw new HttpError(429, 'Too many attempts — try again in a few minutes');
}
function recordFailure(key: string) {
  const f = failures.get(key) ?? { n: 0, until: 0 };
  failures.set(key, { n: f.n + 1, until: Date.now() + 10 * 60_000 });
}

export async function staffPasswordLogin(email: string, password: string, meta: Partial<Ctx>) {
  if (!config.allowLocalPasswordLogin) throw forbidden('Sign in with your Namport Microsoft account');
  const key = `staff:${email.toLowerCase()}`;
  checkThrottle(key);
  return withSystem(async (tx) => {
    const u = await one(tx, 'SELECT id, password_hash, active FROM users WHERE lower(email) = lower($1)', [email]);
    if (!u?.active || !u.password_hash || !(await bcrypt.compare(password, u.password_hash))) {
      recordFailure(key);
      await audit(tx, { ...systemCtx('auth'), ...meta }, 'auth.login_failed', 'user', u?.id ?? null, undefined, { email, realm: 'staff' });
      throw unauthorized('Email or password is incorrect');
    }
    failures.delete(key);
    const s = (await loadStaff(tx, u.id))!;
    await audit(tx, staffCtx(s, meta), 'auth.login', 'user', s.id, undefined, { method: 'password' });
    return { token: signToken({ sub: s.id, realm: 'staff' }), user: s };
  });
}

export async function staffSsoLogin(identity: { oid: string; email: string; name: string }, meta: Partial<Ctx>) {
  return withSystem(async (tx) => {
    let u = await one(tx, 'SELECT id, active FROM users WHERE identity_subject = $1', [identity.oid]);
    if (!u) {
      // first sign-in of a SCIM-provisioned user: bind the Entra object id to the email
      u = await one(tx, `UPDATE users SET identity_subject = $1 WHERE lower(email) = lower($2) AND identity_subject IS NULL RETURNING id, active`, [identity.oid, identity.email]);
    }
    if (!u?.active) {
      await audit(tx, { ...systemCtx('auth'), ...meta }, 'auth.login_denied', 'user', u?.id ?? null, undefined, { email: identity.email, reason: 'not provisioned or inactive' });
      throw forbidden('Your Microsoft account is not provisioned for Sinapse CRM. Ask Namport ICT to add you to the CRM group.');
    }
    const s = (await loadStaff(tx, u.id))!;
    await audit(tx, staffCtx(s, meta), 'auth.login', 'user', s.id, undefined, { method: 'entra_sso' });
    return { token: signToken({ sub: s.id, realm: 'staff' }), user: s };
  });
}

export async function customerLogin(email: string, password: string, code: string | undefined, meta: Partial<Ctx>) {
  const key = `customer:${email.toLowerCase()}`;
  checkThrottle(key);
  return withSystem(async (tx) => {
    const c = await one(tx, 'SELECT id, password_hash, status, email_verified, mfa_enabled, mfa_secret FROM contacts WHERE lower(email) = lower($1)', [email]);
    if (!c?.password_hash || !(await bcrypt.compare(password, c.password_hash))) {
      recordFailure(key);
      await audit(tx, { ...systemCtx('auth'), ...meta }, 'auth.login_failed', 'contact', c?.id ?? null, undefined, { realm: 'customer' });
      throw unauthorized('Email or password is incorrect');
    }
    if (!c.email_verified) throw forbidden('Please verify your email address first — check your inbox for the link');
    if (c.status === 'disabled') throw forbidden('This account has been disabled by your company administrator');
    if (c.mfa_enabled) {
      if (!code) return { mfa_required: true as const };
      if (!verifyTotp(c.mfa_secret, code)) { recordFailure(key); throw unauthorized('The verification code is incorrect'); }
    }
    failures.delete(key);
    const p = (await loadCustomer(tx, c.id))!;
    await audit(tx, customerCtx(p, meta), 'auth.login', 'contact', c.id, undefined, { mfa: c.mfa_enabled });
    return { token: signToken({ sub: c.id, realm: 'customer', mfa: c.mfa_enabled }), customer: p };
  });
}

export async function beginMfaEnrolment(tx: Tx, ctx: Ctx) {
  const secret = newTotpSecret();
  await tx.query('UPDATE contacts SET mfa_secret = $2, mfa_enabled = false WHERE id = $1', [ctx.actorId, secret]);
  const label = encodeURIComponent(`Namport:${ctx.customer?.email}`);
  return { secret, otpauth_url: `otpauth://totp/${label}?secret=${secret}&issuer=Namport%20Sinapse` };
}

export async function confirmMfaEnrolment(tx: Tx, ctx: Ctx, code: string) {
  const c = await one(tx, 'SELECT mfa_secret FROM contacts WHERE id = $1', [ctx.actorId]);
  if (!c?.mfa_secret || !verifyTotp(c.mfa_secret, code)) throw badRequest('The verification code is incorrect');
  await tx.query('UPDATE contacts SET mfa_enabled = true WHERE id = $1', [ctx.actorId]);
  await audit(tx, ctx, 'auth.mfa_enabled', 'contact', ctx.actorId);
  return { mfa_enabled: true };
}

export async function requestPasswordReset(email: string) {
  return withSystem(async (tx) => {
    const c = await one(tx, 'SELECT id, name FROM contacts WHERE lower(email) = lower($1) AND status <> $2', [email, 'disabled']);
    if (!c) return; // do not reveal whether an account exists
    const token = crypto.randomBytes(24).toString('base64url');
    await tx.query('UPDATE contacts SET verification_token = $2 WHERE id = $1', [c.id, token]);
    const { notify } = await import('./notifications.js');
    await notify(tx, { template: 'password_reset', to: { type: 'contact', id: c.id }, vars: { contact: c, link: `${config.publicUrl}/portal/activate?token=${token}` }, channels: ['email'] });
  });
}

export async function apiClientPrincipal(tx: Tx, key: string): Promise<StaffPrincipal | null> {
  const hash = crypto.createHash('sha256').update(key).digest('hex');
  const c = await one(tx, `SELECT a.id, a.name, a.role_key, r.permissions, r.field_masks FROM api_clients a JOIN roles r ON r.key = a.role_key WHERE a.key_hash = $1 AND a.active`, [hash]);
  if (!c) return null;
  return { id: c.id, email: `${c.name}@api`, name: `API: ${c.name}`, roleKey: c.role_key, portCode: null, departmentId: null,
           permissions: c.permissions, fieldMasks: c.field_masks, portScope: 'all', deptScope: 'all' };
}

export async function createApiClient(tx: Tx, ctx: Ctx, name: string, roleKey: string) {
  const key = `snp_${crypto.randomBytes(24).toString('base64url')}`;
  const hash = crypto.createHash('sha256').update(key).digest('hex');
  const c = await one(tx, 'INSERT INTO api_clients (name, key_hash, role_key) VALUES ($1,$2,$3) RETURNING id, name, role_key, created_at', [name, hash, roleKey]);
  await audit(tx, ctx, 'api_client.created', 'api_client', c.id, undefined, { name, role_key: roleKey });
  return { ...c, api_key: key };
}
