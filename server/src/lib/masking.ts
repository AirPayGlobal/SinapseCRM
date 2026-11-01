import type { Ctx } from './context.js';

export const MASK = '••••••';

/**
 * Field-level masking (SA-01.1). Masks are attached to roles as "<entity>.<field>" and applied in
 * the single serialisation path used by screens, the API, exports and reports alike, so an export
 * cannot leak what a screen would have masked.
 */
export function mask<T extends Record<string, any>>(entity: string, row: T, ctx: Ctx): T {
  const masks = ctx.staff?.fieldMasks ?? [];
  if (!masks.length || !row) return row;
  const out: Record<string, any> = { ...row };
  for (const m of masks) {
    const [e, ...path] = m.split('.');
    if (e !== entity) continue;
    if (path.length === 1 && path[0] in out && out[path[0]] != null) out[path[0]] = MASK;
    if (path.length === 2 && out[path[0]] && typeof out[path[0]] === 'object' && path[1] in out[path[0]]) {
      out[path[0]] = { ...out[path[0]], [path[1]]: MASK };
    }
  }
  return out as T;
}

export const maskAll = <T extends Record<string, any>>(entity: string, rows: T[], ctx: Ctx) => rows.map((r) => mask(entity, r, ctx));
