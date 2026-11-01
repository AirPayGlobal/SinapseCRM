import type { Tx } from '../db/pool.js';
import type { Ctx } from './context.js';

/**
 * Append an entry to the tamper-evident event log. Every module writes here; the table rejects
 * UPDATE, DELETE and TRUNCATE, and each row is hash-chained to its predecessor.
 */
export async function audit(
  tx: Tx,
  ctx: Ctx,
  action: string,
  entity: string,
  entityId: string | null,
  before?: unknown,
  after?: unknown,
) {
  await tx.query(
    `INSERT INTO event_log (actor_type, actor_id, actor_name, action, entity, entity_id, before, after, request_id, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      ctx.actorType, ctx.actorId, ctx.actorName, action, entity, entityId,
      before === undefined ? null : JSON.stringify(before),
      after === undefined ? null : JSON.stringify(after),
      ctx.requestId ?? null, ctx.ip ?? null, ctx.userAgent ?? null,
    ],
  );
}

/** Shallow diff so before/after carry only what changed. */
export function diff(before: Record<string, any>, after: Record<string, any>) {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const k of Object.keys(after)) {
    if (JSON.stringify(before?.[k]) !== JSON.stringify(after[k])) {
      b[k] = before?.[k];
      a[k] = after[k];
    }
  }
  return { before: b, after: a, changed: Object.keys(a).length > 0 };
}
