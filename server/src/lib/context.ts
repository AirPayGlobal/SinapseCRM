import type { Scope } from '../db/pool.js';

export type ActorType = 'user' | 'contact' | 'assist' | 'system' | 'api' | 'scim';

export interface StaffPrincipal {
  id: string;
  email: string;
  name: string;
  roleKey: string;
  portCode: string | null;
  departmentId: string | null;
  permissions: string[];
  fieldMasks: string[];
  portScope: 'own' | 'all';
  deptScope: 'own' | 'all';
}

export interface CustomerPrincipal {
  id: string;
  email: string;
  name: string;
  companies: { companyId: string; role: string; isPortalAdmin: boolean; permissions: string[] }[];
}

/** Who is acting, under which data scope, and the request metadata the audit log needs. */
export interface Ctx {
  actorType: ActorType;
  actorId: string | null;
  actorName: string;
  staff?: StaffPrincipal;
  customer?: CustomerPrincipal;
  scope: Scope;
  requestId?: string;
  ip?: string;
  userAgent?: string;
}

export const systemCtx = (name = 'system'): Ctx => ({
  actorType: 'system', actorId: null, actorName: name, scope: { kind: 'system' },
});

export const assistCtx = (customer?: CustomerPrincipal): Ctx => ({
  actorType: 'assist', actorId: null, actorName: 'Sinapse Assist', customer,
  scope: customer ? customerScope(customer) : { kind: 'public' },
});

export function staffScope(s: StaffPrincipal): Scope {
  return {
    kind: 'staff',
    ports: s.portScope === 'all' || !s.portCode ? '*' : [s.portCode],
    departments: s.deptScope === 'all' || !s.departmentId ? '*' : [s.departmentId],
  };
}

export function customerScope(c: CustomerPrincipal): Scope {
  return { kind: 'customer', companies: c.companies.map((x) => x.companyId), contactId: c.id };
}

export const can = (ctx: Ctx, permission: string) =>
  ctx.actorType === 'system' || Boolean(ctx.staff?.permissions.includes(permission) || ctx.staff?.permissions.includes('*'));
