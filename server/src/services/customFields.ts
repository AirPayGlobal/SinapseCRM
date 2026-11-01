import { many, type Tx } from '../db/pool.js';
import type { Ctx } from '../lib/context.js';
import { badRequest } from '../lib/errors.js';

/**
 * QMC-04 — metadata-driven field engine. Administrators define type, validation, default, help
 * text and visibility by role and query type; values are validated here and filtered for
 * visibility on the way out, so changes take effect immediately without a release.
 */
export interface FieldDef {
  key: string; label: string; field_type: string; required: boolean; options: string[];
  validation: { pattern?: string; min?: number; max?: number; maxLength?: number };
  default_value: unknown; visible_roles: string[]; query_types: string[]; customer_visible: boolean;
}

export async function fieldDefs(tx: Tx, entity: 'query' | 'company' | 'contact') {
  return many<FieldDef>(tx, 'SELECT * FROM custom_field_definitions WHERE entity = $1 AND active ORDER BY sort_order, label', [entity]);
}

export async function validateCustomFields(
  tx: Tx, entity: 'query' | 'company' | 'contact', values: Record<string, unknown>,
  opts: { queryType?: string | null; partial?: boolean; actor?: Ctx } = {},
) {
  const defs = (await fieldDefs(tx, entity)).filter((d) => !d.query_types.length || (opts.queryType && d.query_types.includes(opts.queryType)));
  const out: Record<string, unknown> = {};
  const errors: string[] = [];
  for (const d of defs) {
    let v = values[d.key];
    if ((v === undefined || v === '' || v === null) && !opts.partial && d.default_value != null) v = d.default_value;
    if (v === undefined || v === '' || v === null) {
      // required fields are enforced for staff capture; customers only see customer-visible fields
      if (d.required && !opts.partial && (opts.actor?.actorType === 'user' || d.customer_visible)) errors.push(`${d.label} is required`);
      continue;
    }
    switch (d.field_type) {
      case 'number': {
        const n = Number(v);
        if (Number.isNaN(n)) { errors.push(`${d.label} must be a number`); continue; }
        if (d.validation.min != null && n < d.validation.min) errors.push(`${d.label} must be at least ${d.validation.min}`);
        if (d.validation.max != null && n > d.validation.max) errors.push(`${d.label} must be at most ${d.validation.max}`);
        v = n; break;
      }
      case 'boolean': v = v === true || v === 'true'; break;
      case 'date': if (Number.isNaN(Date.parse(String(v)))) errors.push(`${d.label} must be a date`); break;
      case 'select': if (!d.options.includes(String(v))) errors.push(`${d.label} must be one of: ${d.options.join(', ')}`); break;
      case 'multiselect': {
        const arr = Array.isArray(v) ? v.map(String) : [String(v)];
        if (arr.some((x) => !d.options.includes(x))) errors.push(`${d.label} has an invalid option`);
        v = arr; break;
      }
      default: {
        const s = String(v);
        if (d.validation.pattern && !new RegExp(d.validation.pattern).test(s)) errors.push(`${d.label} is not in the expected format`);
        if (d.validation.maxLength && s.length > d.validation.maxLength) errors.push(`${d.label} is too long`);
        v = s;
      }
    }
    out[d.key] = v;
  }
  if (errors.length) throw badRequest('Custom field validation failed', errors);
  return out;
}

/** Strip fields the viewer may not see (role-based for staff, customer_visible for customers). */
export function visibleCustomFields(defs: FieldDef[], values: Record<string, unknown>, ctx: Ctx) {
  const out: Record<string, unknown> = {};
  for (const d of defs) {
    if (!(d.key in (values ?? {}))) continue;
    if (ctx.actorType === 'contact' || ctx.actorType === 'assist') { if (d.customer_visible) out[d.key] = values[d.key]; continue; }
    if (ctx.staff && d.visible_roles.length && !d.visible_roles.includes(ctx.staff.roleKey)) continue;
    out[d.key] = values[d.key];
  }
  return out;
}
