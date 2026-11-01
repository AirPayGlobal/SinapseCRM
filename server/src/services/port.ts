import { many, one, type Tx } from '../db/pool.js';
import { audit, diff } from '../lib/audit.js';
import type { Ctx } from '../lib/context.js';
import { badRequest, notFound } from '../lib/errors.js';
import { emit } from './events.js';
import { notify } from './notifications.js';

/**
 * Port context (Module 6): vessel calls, cargo references and trade corridors attached to the case,
 * corridor analytics, and proactive operational notification — a berth move that would generate
 * forty queries generates one notice instead.
 */

export async function listVesselCalls(tx: Tx, f: { port?: string; status?: string; q?: string }) {
  const p: unknown[] = [];
  const w: string[] = [];
  if (f.port) { p.push(f.port); w.push(`v.port_code = $${p.length}`); }
  if (f.status) { p.push(f.status); w.push(`v.status = $${p.length}`); }
  if (f.q) { p.push(`%${f.q}%`); w.push(`(v.vessel_name ILIKE $${p.length} OR v.voyage_no ILIKE $${p.length})`); }
  return many(tx,
    `SELECT v.*, c.name AS corridor_name,
            (SELECT count(*)::int FROM queries q WHERE q.vessel_call_id = v.id AND q.state NOT IN ('resolved','closed','merged','filtered')) AS open_queries,
            (SELECT count(*)::int FROM cargo_references cr WHERE cr.vessel_call_id = v.id) AS cargo_count
       FROM vessel_calls v LEFT JOIN corridors c ON c.id = v.corridor_id
      ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY v.window_from NULLS LAST`, p);
}

export async function upsertVesselCall(tx: Tx, ctx: Ctx, input: Record<string, any>, id?: string) {
  const fields = ['vessel_name', 'imo_number', 'voyage_no', 'port_code', 'berth', 'window_from', 'window_to', 'status', 'corridor_id'];
  if (!id) {
    if (!input.vessel_name || !input.voyage_no || !input.port_code) throw badRequest('Vessel name, voyage and port are required');
    const v = await one(tx,
      `INSERT INTO vessel_calls (${fields.join(',')}) VALUES (${fields.map((_, i) => `$${i + 1}`).join(',')})
       ON CONFLICT (vessel_name, voyage_no) DO UPDATE SET berth = EXCLUDED.berth, window_from = EXCLUDED.window_from, window_to = EXCLUDED.window_to,
              status = EXCLUDED.status, updated_at = now() RETURNING *`,
      fields.map((f) => input[f] ?? (f === 'status' ? 'expected' : null)));
    await audit(tx, ctx, 'vessel_call.created', 'vessel_call', v.id, undefined, v);
    return v;
  }
  const cur = await one(tx, 'SELECT * FROM vessel_calls WHERE id = $1 FOR UPDATE', [id]);
  if (!cur) throw notFound('Vessel call not found');
  const next: Record<string, any> = {};
  for (const f of fields) if (f in input) next[f] = input[f];
  if ('berth' in next && next.berth !== cur.berth) next.previous_berth = cur.berth;
  const d = diff(cur, next);
  if (!d.changed) return cur;
  const keys = Object.keys(d.after);
  await tx.query(`UPDATE vessel_calls SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`, [id, ...keys.map((k) => d.after[k])]);
  await audit(tx, ctx, 'vessel_call.updated', 'vessel_call', id, d.before, d.after);
  return one(tx, 'SELECT * FROM vessel_calls WHERE id = $1', [id]);
}

export async function cargoLookup(tx: Tx, q: string) {
  return many(tx,
    `SELECT cr.*, v.vessel_name, v.voyage_no, v.berth, v.status AS vessel_status, co.name AS company_name, c.name AS corridor_name
       FROM cargo_references cr LEFT JOIN vessel_calls v ON v.id = cr.vessel_call_id LEFT JOIN companies co ON co.id = cr.company_id
       LEFT JOIN corridors c ON c.id = cr.corridor_id
      WHERE cr.container_no ILIKE $1 OR cr.bl_no ILIKE $1 ORDER BY cr.container_no LIMIT 50`, [`%${q}%`]);
}

/** Corridor analytics: volume, type mix, resolution and service attainment by trade corridor. */
export async function corridorAnalytics(tx: Tx, days = 90) {
  const interval = `${Number(days)} days`;
  const summary = await many(tx,
    `SELECT coalesce(c.name, 'Unattributed') AS corridor, c.id AS corridor_id,
            count(q.id)::int AS volume,
            count(q.id) FILTER (WHERE q.state NOT IN ('resolved','closed','merged','filtered'))::int AS open,
            round(avg(extract(epoch FROM q.resolved_at - q.created_at) / 3600) FILTER (WHERE q.resolved_at IS NOT NULL)::numeric, 1) AS avg_resolution_hours,
            round(100.0 * count(q.id) FILTER (WHERE q.resolved_at IS NOT NULL AND NOT q.breached) / nullif(count(q.id) FILTER (WHERE q.resolved_at IS NOT NULL), 0), 1) AS sla_attainment
       FROM queries q LEFT JOIN corridors c ON c.id = q.corridor_id
      WHERE q.created_at > now() - $1::interval AND q.state <> 'filtered'
      GROUP BY c.id, c.name ORDER BY volume DESC`, [interval]);
  const mix = await many(tx,
    `SELECT coalesce(c.name, 'Unattributed') AS corridor, coalesce(qt.name, 'Unclassified') AS query_type, count(*)::int AS n
       FROM queries q LEFT JOIN corridors c ON c.id = q.corridor_id LEFT JOIN query_types qt ON qt.key = q.query_type_key
      WHERE q.created_at > now() - $1::interval AND q.state <> 'filtered'
      GROUP BY 1, 2 ORDER BY 1, n DESC`, [interval]);
  const trend = await many(tx,
    `SELECT coalesce(c.name, 'Unattributed') AS corridor, date_trunc('week', q.created_at)::date AS week, count(*)::int AS n
       FROM queries q LEFT JOIN corridors c ON c.id = q.corridor_id
      WHERE q.created_at > now() - $1::interval AND q.state <> 'filtered' GROUP BY 1, 2 ORDER BY 2`, [interval]);
  return { summary, mix, trend };
}

/** Proactive notification: tell affected customers about an operational change before they ask. */
export async function sendNotice(tx: Tx, ctx: Ctx, input: { title: string; body: string; vessel_call_id?: string; port_code?: string; corridor_id?: string; audience?: 'affected' | 'port' | 'all' }) {
  if (!input.title?.trim() || !input.body?.trim()) throw badRequest('Title and message are required');
  const audience = input.audience ?? (input.vessel_call_id ? 'affected' : 'port');
  let recipients: { contact_id: string }[] = [];
  if (audience === 'affected') {
    if (!input.vessel_call_id && !input.corridor_id) throw badRequest('Choose a vessel call or corridor for an affected-customer notice');
    recipients = await many(tx,
      `SELECT DISTINCT cc.contact_id FROM company_contacts cc JOIN contacts ct ON ct.id = cc.contact_id
        WHERE cc.status = 'active' AND ct.status = 'active' AND cc.role IN ('primary','operations') AND cc.company_id IN (
          SELECT company_id FROM cargo_references WHERE company_id IS NOT NULL AND ($1::uuid IS NULL OR vessel_call_id = $1) AND ($2::uuid IS NULL OR corridor_id = $2)
          UNION SELECT company_id FROM queries WHERE company_id IS NOT NULL AND ($1::uuid IS NULL OR vessel_call_id = $1) AND ($2::uuid IS NULL OR corridor_id = $2)
                AND state NOT IN ('closed','merged','filtered'))`,
      [input.vessel_call_id ?? null, input.corridor_id ?? null]);
  } else {
    recipients = await many(tx,
      `SELECT DISTINCT cc.contact_id FROM company_contacts cc JOIN companies co ON co.id = cc.company_id JOIN contacts ct ON ct.id = cc.contact_id
        WHERE cc.status = 'active' AND co.status = 'active' AND ct.status = 'active' AND cc.role IN ('primary','operations')
          AND ($1::text IS NULL OR $1 = ANY(co.ports_served))`, [audience === 'port' ? input.port_code ?? null : null]);
  }
  const n = await one(tx,
    `INSERT INTO operational_notices (title, body, vessel_call_id, port_code, corridor_id, audience, recipients_count, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [input.title, input.body, input.vessel_call_id ?? null, input.port_code ?? null, input.corridor_id ?? null, audience, recipients.length, ctx.actorId]);
  for (const r of recipients) {
    await notify(tx, { template: 'operational_notice', to: { type: 'contact', id: r.contact_id }, vars: { notice: n } });
  }
  // Agents handling open queries on the same vessel see the notice on the case
  if (input.vessel_call_id) {
    await tx.query(
      `INSERT INTO interactions (query_id, company_id, contact_id, channel, direction, visibility, subject, body, actor_type, actor_id, actor_name)
       SELECT id, company_id, contact_id, 'system', 'outbound', 'public', $2, $3, 'user', $4, $5 FROM queries
        WHERE vessel_call_id = $1 AND state NOT IN ('resolved','closed','merged','filtered')`,
      [input.vessel_call_id, `Operational notice: ${input.title}`, input.body, ctx.actorId, ctx.actorName]);
  }
  await audit(tx, ctx, 'notice.sent', 'operational_notice', n.id, undefined, { title: n.title, recipients: recipients.length });
  await emit(tx, 'notice.sent', { id: n.id, title: n.title, recipients: recipients.length });
  return n;
}

export async function listNotices(tx: Tx, forContact?: string) {
  if (forContact) {
    return many(tx,
      `SELECT DISTINCT ON (o.id) o.id, o.title, o.body, o.sent_at, v.vessel_name, v.voyage_no FROM operational_notices o
         LEFT JOIN vessel_calls v ON v.id = o.vessel_call_id
         JOIN notifications n ON n.template_key = 'operational_notice' AND n.recipient_type = 'contact' AND n.recipient_id = $1 AND n.body LIKE '%' || o.body || '%'
        ORDER BY o.id, o.sent_at DESC LIMIT 50`, [forContact]);
  }
  return many(tx, `SELECT o.*, v.vessel_name, v.voyage_no, u.name AS created_by_name FROM operational_notices o
                     LEFT JOIN vessel_calls v ON v.id = o.vessel_call_id LEFT JOIN users u ON u.id = o.created_by ORDER BY o.sent_at DESC LIMIT 100`);
}
