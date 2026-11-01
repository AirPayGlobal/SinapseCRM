import { one, withScope, withSystem, type Tx } from '../src/db/pool.js';
import type { Ctx } from '../src/lib/context.js';
import { customerCtx, loadCustomer, loadStaff, staffCtx } from '../src/services/auth.js';

export const sys = withSystem;

export async function staffByEmail(email: string): Promise<Ctx> {
  return withSystem(async (tx) => {
    const u = await one(tx, 'SELECT id FROM users WHERE email = $1', [email]);
    return staffCtx((await loadStaff(tx, u.id))!);
  });
}

export async function customerByEmail(email: string): Promise<Ctx> {
  return withSystem(async (tx) => {
    const c = await one(tx, 'SELECT id FROM contacts WHERE email = $1', [email]);
    return customerCtx((await loadCustomer(tx, c.id))!);
  });
}

export const as = <T>(ctx: Ctx, fn: (tx: Tx) => Promise<T>) => withScope(ctx.scope, fn);

let n = 0;
export const uniq = (p = 'x') => `${p}-${Date.now().toString(36)}-${(n++).toString(36)}`;
