import { many, one, type Tx, inSequence } from '../db/pool.js';
import { audit, diff } from '../lib/audit.js';
import { systemCtx, type Ctx } from '../lib/context.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { mask } from '../lib/masking.js';
import { invalidateModels } from './classifier.js';
import { fieldDefs, validateCustomFields, visibleCustomFields } from './customFields.js';
import { emit } from './events.js';
import { notify } from './notifications.js';
import { recomputeClock, slaState } from './sla.js';
import { availableTransitions, getDefinition, stateOf, templateVars, transition } from './workflow.js';
import { assign } from './assignment.js';

const CLOSED = ['resolved', 'closed', 'merged', 'filtered'];

const LIST_SELECT = `
  SELECT q.id, q.reference, q.subject, q.state, q.urgency, q.channel, q.port_code, q.query_type_key, qt.name AS query_type_name,
         q.department_id, d.name AS department_name, q.company_id, co.name AS company_name, co.account_tier,
         q.contact_id, ct.name AS contact_name, q.assigned_to, u.name AS assigned_to_name, q.queue_id, qu.name AS queue_name,
         q.first_response_due_at, q.resolution_due_at, q.first_responded_at, q.clock_paused_at, q.resolved_at, q.closed_at,
         q.breached, q.escalation_level, q.possible_duplicate_of, q.parent_query_id, q.filter_reason, q.sentiment,
         q.classification_confirmed, q.ai_classification, q.vessel_call_id, q.corridor_id, q.created_at, q.updated_at
    FROM queries q
    LEFT JOIN query_types qt ON qt.key = q.query_type_key
    LEFT JOIN departments d ON d.id = q.department_id
    LEFT JOIN companies co ON co.id = q.company_id
    LEFT JOIN contacts ct ON ct.id = q.contact_id
    LEFT JOIN users u ON u.id = q.assigned_to
    LEFT JOIN queues qu ON qu.id = q.queue_id`;

export interface QueryFilters {
  mine?: boolean;
  assigned_to?: string;
  unassigned?: boolean;
  state?: string | string[];
  open?: boolean;
  company_id?: string;
  contact_id?: string;
  query_type?: string;
  urgency?: string;
  port?: string;
  department_id?: string;
  queue_id?: string;
  corridor_id?: string;
  vessel_call_id?: string;
  sla?: 'breached' | 'at_risk' | 'paused' | 'running';
  tier?: string;
  channel?: string;
  q?: string;
  created_from?: string;
  created_to?: string;
  duplicates?: boolean;
  sort?: 'sla' | 'created' | 'updated' | 'urgency';
  limit?: number;
  offset?: number;
}

/** Build a parameterised WHERE clause from whitelisted filters (also used by saved searches/queues). */
export function buildQueryWhere(f: QueryFilters, ctx: Ctx) {
  const where: string[] = [];
  const p: unknown[] = [];
  const add = (sql: string, v: unknown) => { p.push(v); where.push(sql.replace('$?', `$${p.length}`)); };
  if (f.mine && ctx.actorId) add('q.assigned_to = $?', ctx.actorId);
  if (f.assigned_to) add('q.assigned_to = $?', f.assigned_to);
  if (f.unassigned) where.push('q.assigned_to IS NULL');
  if (f.state) add('q.state = ANY($?)', Array.isArray(f.state) ? f.state : String(f.state).split(','));
  if (f.open) where.push(`q.state NOT IN ('resolved','closed','merged','filtered')`);
  if (f.company_id) add('q.company_id = $?', f.company_id);
  if (f.contact_id) add('q.contact_id = $?', f.contact_id);
  if (f.query_type) add('q.query_type_key = $?', f.query_type);
  if (f.urgency) add('q.urgency = $?', f.urgency);
  if (f.port) add('q.port_code = $?', f.port);
  if (f.department_id) add('q.department_id = $?', f.department_id);
  if (f.queue_id) add('q.queue_id = $?', f.queue_id);
  if (f.corridor_id) add('q.corridor_id = $?', f.corridor_id);
  if (f.vessel_call_id) add('q.vessel_call_id = $?', f.vessel_call_id);
  if (f.tier) add('co.account_tier = $?', f.tier);
  if (f.channel) add('q.channel = $?', f.channel);
  if (f.duplicates) where.push(`q.possible_duplicate_of IS NOT NULL AND q.state NOT IN ('merged','closed')`);
  if (f.created_from) add('q.created_at >= $?', f.created_from);
  if (f.created_to) add('q.created_at < $?', f.created_to);
  if (f.sla === 'breached') where.push(`q.resolved_at IS NULL AND q.clock_paused_at IS NULL AND (q.breached OR coalesce(CASE WHEN q.first_responded_at IS NULL THEN q.first_response_due_at END, q.resolution_due_at) < now())`);
  if (f.sla === 'paused') where.push('q.clock_paused_at IS NOT NULL');
  if (f.sla === 'at_risk') where.push(`q.resolved_at IS NULL AND q.clock_paused_at IS NULL AND NOT q.breached AND q.pre_breach_notified`);
  if (f.sla === 'running') where.push(`q.resolved_at IS NULL AND q.clock_paused_at IS NULL`);
  if (f.q) {
    p.push(f.q);
    const i = p.length;
    where.push(`(q.search @@ websearch_to_tsquery('english', $${i}) OR q.reference ILIKE '%' || $${i} || '%'
                OR co.name ILIKE '%' || $${i} || '%' OR ct.name ILIKE '%' || $${i} || '%'
                OR EXISTS (SELECT 1 FROM interactions i WHERE i.query_id = q.id AND i.search @@ websearch_to_tsquery('english', $${i}))
                OR EXISTS (SELECT 1 FROM attachments a WHERE a.query_id = q.id AND a.search @@ websearch_to_tsquery('english', $${i})))`);
  }
  return { where: where.length ? `WHERE ${where.join(' AND ')}` : '', params: p };
}

const ORDER: Record<string, string> = {
  sla: `CASE WHEN q.clock_paused_at IS NOT NULL OR q.resolved_at IS NOT NULL THEN 1 ELSE 0 END,
        coalesce(CASE WHEN q.first_responded_at IS NULL THEN q.first_response_due_at END, q.resolution_due_at) ASC NULLS LAST`,
  created: 'q.created_at DESC',
  updated: 'q.updated_at DESC',
  urgency: `CASE q.urgency WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, q.created_at`,
};

export function decorate(q: any, ctx: Ctx) {
  const sla = slaState(q);
  const out = { ...q, sla };
  return mask('query', out, ctx);
}

export async function listQueries(tx: Tx, ctx: Ctx, f: QueryFilters) {
  const { where, params } = buildQueryWhere(f, ctx);
  const limit = Math.min(Number(f.limit ?? 50), 500);
  const offset = Number(f.offset ?? 0);
  const rows = await many(tx, `${LIST_SELECT} ${where} ORDER BY ${ORDER[f.sort ?? 'sla'] ?? ORDER.sla} LIMIT ${limit} OFFSET ${offset}`, params);
  const total = await one<{ n: number }>(tx, `SELECT count(*)::int AS n FROM queries q LEFT JOIN companies co ON co.id = q.company_id LEFT JOIN contacts ct ON ct.id = q.contact_id ${where}`, params);
  return { items: rows.map((r) => decorate(r, ctx)), total: total?.n ?? 0 };
}

export async function getQueryRow(tx: Tx, id: string) {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  const q = await one(tx, `${LIST_SELECT.replace('SELECT q.id,', 'SELECT q.*, q.id,')} WHERE ${isUuid ? 'q.id = $1::uuid' : 'q.reference = $1'}`, [id]);
  if (!q) throw notFound('Query not found');
  return q;
}

export async function timeline(tx: Tx, queryIds: string[]) {
  return many(
    tx,
    `SELECT i.id, i.query_id, q.reference, i.channel, i.direction, i.visibility, i.subject, i.body, i.call_duration_seconds, i.call_outcome,
            i.actor_type, i.actor_name, i.occurred_at,
            coalesce((SELECT json_agg(json_build_object('id', a.id, 'filename', a.filename, 'size_bytes', a.size_bytes, 'scan_status', a.scan_status, 'mime_type', a.mime_type))
                        FROM attachments a WHERE a.interaction_id = i.id), '[]') AS attachments
       FROM interactions i JOIN queries q ON q.id = i.query_id
      WHERE i.query_id = ANY($1) ORDER BY i.occurred_at, i.id`,
    [queryIds],
  );
}

export async function customerSummary(tx: Tx, companyId: string | null, contactId: string | null) {
  if (!companyId && !contactId) return null;
  return one(
    tx,
    `SELECT count(*) FILTER (WHERE state NOT IN ('resolved','closed','merged','filtered'))::int AS open_cases,
            count(*) FILTER (WHERE resolved_at > now() - interval '90 days')::int AS resolved_90d,
            round(avg(extract(epoch FROM resolved_at - created_at) / 3600) FILTER (WHERE resolved_at > now() - interval '90 days')::numeric, 1) AS avg_resolution_hours,
            round(100.0 * count(*) FILTER (WHERE resolved_at IS NOT NULL AND NOT breached) / nullif(count(*) FILTER (WHERE resolved_at IS NOT NULL), 0), 1) AS sla_attainment,
            (SELECT round(avg(score)::numeric, 1) FROM satisfaction_responses s JOIN queries q2 ON q2.id = s.query_id
              WHERE s.score IS NOT NULL AND (q2.company_id = $1 OR q2.contact_id = $2)) AS satisfaction
       FROM queries WHERE (company_id = $1 OR ($1::uuid IS NULL AND contact_id = $2)) AND state <> 'filtered'`,
    [companyId, contactId],
  );
}

/** Full case view: record, timeline across all channels (including merged children), context. */
export async function getQueryDetail(tx: Tx, ctx: Ctx, id: string) {
  const q = await getQueryRow(tx, id);
  const children = await many(tx, 'SELECT id, reference, subject, contact_id, created_at FROM queries WHERE parent_query_id = $1', [q.id]);
  const def = await getDefinition(tx, q.workflow_definition_id);
  const isCustomer = ctx.actorType === 'contact';
  const tl = await timeline(tx, [q.id, ...children.map((c: any) => c.id)]);
  const attachments = await many(tx, `SELECT id, filename, mime_type, size_bytes, scan_status, visibility, created_at, interaction_id FROM attachments WHERE query_id = $1 ORDER BY created_at`, [q.id]);
  const defs = await fieldDefs(tx, 'query');
  const st = stateOf(def, q.state);

  if (isCustomer) {
    return {
      id: q.id, reference: q.reference, subject: q.subject, description: q.description, state: q.state,
      status: st?.customer_label ?? st?.label ?? q.state, query_type_name: q.query_type_name, urgency: q.urgency, port_code: q.port_code,
      company_name: q.company_name, created_at: q.created_at, resolved_at: q.resolved_at, resolution_note: q.resolution_note,
      first_response_due_at: q.first_responded_at ? null : q.first_response_due_at, parent_query_id: q.parent_query_id,
      timeline: tl.filter((t: any) => t.visibility === 'public'), attachments: attachments.filter((a: any) => a.visibility === 'public'),
      actions: availableTransitions(def, q.state, { customer: true }).map((t) => ({ to: t.to, label: t.label })),
      custom_fields: visibleCustomFields(defs, q.custom_fields, ctx),
      satisfaction: await one(tx, 'SELECT token, score, responded_at FROM satisfaction_responses WHERE query_id = $1', [q.id]),
    };
  }

  const [vessel, cargo, corridor, duplicate, assignments, tasks, customer, company] = await inSequence([
    () => q.vessel_call_id ? one(tx, 'SELECT * FROM vessel_calls WHERE id = $1', [q.vessel_call_id]) : null,
    () => q.cargo_reference_id ? one(tx, 'SELECT * FROM cargo_references WHERE id = $1', [q.cargo_reference_id]) : null,
    () => q.corridor_id ? one(tx, 'SELECT * FROM corridors WHERE id = $1', [q.corridor_id]) : null,
    () => q.possible_duplicate_of ? one(tx, 'SELECT id, reference, subject, state, created_at FROM queries WHERE id = $1', [q.possible_duplicate_of]) : null,
    () => many(tx, `SELECT a.*, fu.name AS from_name, tu.name AS to_name FROM query_assignments a LEFT JOIN users fu ON fu.id = a.from_user_id
               LEFT JOIN users tu ON tu.id = a.to_user_id WHERE a.query_id = $1 ORDER BY a.occurred_at`, [q.id]),
    () => many(tx, `SELECT t.*, u.name AS assignee_name FROM staff_tasks t JOIN users u ON u.id = t.assignee_id WHERE t.query_id = $1 ORDER BY t.created_at`, [q.id]),
    () => customerSummary(tx, q.company_id, q.contact_id),
    () => q.company_id ? one(tx, 'SELECT id, name, registration_no, company_type, account_tier, ports_served, sap_customer_id, service_agreement_ref FROM companies WHERE id = $1', [q.company_id]) : null,
  ]);
  const contact = q.contact_id ? await one(tx, 'SELECT id, name, email, phone, position FROM contacts WHERE id = $1', [q.contact_id]) : null;
  await audit(tx, ctx, 'query.read', 'query', q.id);
  return {
    ...decorate(q, ctx),
    custom_fields: visibleCustomFields(defs, q.custom_fields, ctx),
    custom_field_definitions: defs.filter((d) => !d.query_types.length || d.query_types.includes(q.query_type_key)),
    workflow: { key: def.workflow_key, version: def.version, state_label: st?.label, clock: st?.clock },
    transitions: availableTransitions(def, q.state, { role: ctx.staff?.roleKey }).map((t) => ({ to: t.to, label: t.label, guards: t.guards ?? [] })),
    timeline: tl, attachments, children, assignments, tasks,
    duplicate_candidate: duplicate ? { ...duplicate, score: q.duplicate_score } : null,
    port_context: { vessel_call: vessel, cargo, corridor },
    customer: { summary: customer, company: company ? mask('company', company, ctx) : null, contact: contact ? mask('contact', contact, ctx) : null },
  };
}

const UPDATABLE = ['subject', 'query_type_key', 'urgency', 'department_id', 'company_id', 'contact_id', 'vessel_call_id', 'cargo_reference_id', 'corridor_id', 'port_code'] as const;

export async function updateQuery(tx: Tx, ctx: Ctx, id: string, patch: Record<string, any>) {
  const q = await one(tx, 'SELECT * FROM queries WHERE id = $1 FOR UPDATE', [id]);
  if (!q) throw notFound('Query not found');
  if (['closed', 'merged'].includes(q.state)) throw conflict('Closed or merged cases are immutable');
  const next: Record<string, any> = {};
  for (const k of UPDATABLE) if (k in patch) next[k] = patch[k] === '' ? null : patch[k];
  if (next.urgency && !['low', 'normal', 'high', 'critical'].includes(next.urgency)) throw badRequest('Invalid urgency');
  if (next.query_type_key) {
    const qt = await one(tx, 'SELECT department_id FROM query_types WHERE key = $1 AND active', [next.query_type_key]);
    if (!qt) throw badRequest('Unknown query type');
    if (!('department_id' in next)) next.department_id = qt.department_id;
  }
  if (patch.custom_fields) {
    next.custom_fields = { ...q.custom_fields, ...(await validateCustomFields(tx, 'query', patch.custom_fields, { queryType: next.query_type_key ?? q.query_type_key, partial: true, actor: ctx })) };
  }
  const confirm = patch.confirm_classification === true || 'query_type_key' in next || 'urgency' in next;
  if (confirm) next.classification_confirmed = true;
  const d = diff(q, next);
  if (!d.changed) return q;
  const keys = Object.keys(d.after);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`);
  await tx.query(`UPDATE queries SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, [id, ...keys.map((k) => (k === 'custom_fields' ? JSON.stringify(d.after[k]) : d.after[k]))]);
  // QMC-03: every confirmation or override of the AI proposal becomes training signal
  if (confirm) {
    const predicted = q.ai_classification ?? {};
    const final = { query_type: next.query_type_key ?? q.query_type_key, urgency: next.urgency ?? q.urgency };
    await tx.query(
      `INSERT INTO classification_signals (query_id, predicted, final, overridden, kind, actor_id) VALUES ($1,$2,$3,$4,'classification',$5)`,
      [id, JSON.stringify(predicted), JSON.stringify(final), predicted.query_type !== final.query_type || predicted.urgency !== final.urgency, ctx.actorId],
    );
    invalidateModels();
  }
  if ('urgency' in d.after || 'company_id' in d.after) await recomputeClock(tx, id);
  await audit(tx, ctx, 'query.updated', 'query', id, d.before, d.after);
  return one(tx, 'SELECT * FROM queries WHERE id = $1', [id]);
}

/** CM01.4 — internal note; @mentions notify the colleague and create a task. */
export async function addNote(tx: Tx, ctx: Ctx, id: string, body: string) {
  if (!body?.trim()) throw badRequest('Note is empty');
  const q = await one(tx, 'SELECT * FROM queries WHERE id = $1', [id]);
  if (!q) throw notFound('Query not found');
  const n = await one<{ id: string }>(
    tx,
    `INSERT INTO interactions (query_id, company_id, contact_id, channel, direction, visibility, body, actor_type, actor_id, actor_name)
     VALUES ($1,$2,$3,'note','internal','internal',$4,'user',$5,$6) RETURNING id`,
    [id, q.company_id, q.contact_id, body, ctx.actorId, ctx.actorName],
  );
  const mentions = [...body.matchAll(/@([\w.+-]+@[\w.-]+|[\w.-]+)/g)].map((m) => m[1].toLowerCase());
  const mentioned: string[] = [];
  for (const m of new Set(mentions)) {
    const u = await one<{ id: string; name: string }>(
      tx, `SELECT id, name FROM users WHERE active AND (lower(email) = $1 OR lower(split_part(email,'@',1)) = $1 OR lower(replace(name,' ','.')) = $1) LIMIT 1`, [m],
    );
    if (!u || u.id === ctx.actorId) continue;
    await tx.query(`INSERT INTO staff_tasks (assignee_id, query_id, interaction_id, title, created_by) VALUES ($1,$2,$3,$4,$5)`,
      [u.id, id, n!.id, `${ctx.actorName} mentioned you on ${q.reference}: ${body.slice(0, 140)}`, ctx.actorId]);
    await notify(tx, { template: 'mention', to: { type: 'user', id: u.id }, vars: { ...(await templateVars(tx, q)), author: ctx.actorName, note: body }, queryId: id, channels: ['in_app', 'teams'] });
    mentioned.push(u.name);
  }
  await audit(tx, ctx, 'query.note_added', 'query', id, undefined, { interaction_id: n!.id, mentions: mentioned });
  return { id: n!.id, mentioned };
}

/** Outbound reply to the customer (email through Graph and the portal timeline). */
export async function reply(tx: Tx, ctx: Ctx, id: string, body: string, opts: { then?: 'resolve' | 'pending_customer' | null; resolutionNote?: string } = {}) {
  if (!body?.trim()) throw badRequest('Reply is empty');
  const q = await one(tx, 'SELECT * FROM queries WHERE id = $1', [id]);
  if (!q) throw notFound('Query not found');
  if (['closed', 'merged'].includes(q.state)) throw conflict('Case is closed');
  const vars = await templateVars(tx, q);
  const r = await one<{ id: string }>(
    tx,
    `INSERT INTO interactions (query_id, company_id, contact_id, channel, direction, visibility, subject, body, actor_type, actor_id, actor_name)
     VALUES ($1,$2,$3,'email','outbound','public',$4,$5,'user',$6,$7) RETURNING id`,
    [id, q.company_id, q.contact_id, `[${q.reference}] ${q.subject}`, body, ctx.actorId, ctx.actorName],
  );
  await tx.query('UPDATE queries SET first_responded_at = coalesce(first_responded_at, now()), updated_at = now() WHERE id = $1', [id]);
  if (q.contact_id) await notify(tx, { template: 'agent_reply', to: { type: 'contact', id: q.contact_id }, vars: { ...vars, message: body }, queryId: id });
  if (q.state === 'assigned') await transition(tx, ctx, id, 'in_progress');
  await audit(tx, ctx, 'query.replied', 'query', id, undefined, { interaction_id: r!.id });
  if (opts.then === 'resolve') return transition(tx, ctx, id, 'resolved', { resolutionNote: opts.resolutionNote ?? body.slice(0, 2000) });
  if (opts.then === 'pending_customer') return transition(tx, ctx, id, 'pending_customer');
  return one(tx, 'SELECT * FROM queries WHERE id = $1', [id]);
}

export async function logCall(tx: Tx, ctx: Ctx, id: string, c: { direction: 'inbound' | 'outbound'; durationSeconds?: number; outcome?: string; notes: string }) {
  const q = await one(tx, 'SELECT * FROM queries WHERE id = $1', [id]);
  if (!q) throw notFound('Query not found');
  const r = await one<{ id: string }>(
    tx,
    `INSERT INTO interactions (query_id, company_id, contact_id, channel, direction, visibility, body, call_duration_seconds, call_outcome, actor_type, actor_id, actor_name)
     VALUES ($1,$2,$3,'phone',$4,'public',$5,$6,$7,'user',$8,$9) RETURNING id`,
    [id, q.company_id, q.contact_id, c.direction, c.notes ?? '', c.durationSeconds ?? null, c.outcome ?? null, ctx.actorId, ctx.actorName],
  );
  if (c.direction === 'outbound') await tx.query('UPDATE queries SET first_responded_at = coalesce(first_responded_at, now()) WHERE id = $1', [id]);
  await audit(tx, ctx, 'query.call_logged', 'query', id, undefined, { interaction_id: r!.id, ...c });
  return r;
}

/**
 * Cases merge rather than close: the near-duplicate joins the original via parent_query_id, so the
 * second customer's words, attachments and expectations are preserved on one case.
 */
export async function merge(tx: Tx, ctx: Ctx, childId: string, parentId: string) {
  if (childId === parentId) throw badRequest('A case cannot be merged into itself');
  const child = await one(tx, 'SELECT * FROM queries WHERE id = $1 FOR UPDATE', [childId]);
  const parent = await one(tx, 'SELECT * FROM queries WHERE id = $1 FOR UPDATE', [parentId]);
  if (!child || !parent) throw notFound('Query not found');
  if (parent.parent_query_id) throw badRequest(`${parent.reference} is itself merged; merge into ${parent.parent_query_id} instead`);
  if (['merged', 'closed'].includes(parent.state)) throw conflict('Cannot merge into a closed case');
  await tx.query('UPDATE queries SET parent_query_id = $2, possible_duplicate_of = NULL WHERE id = $1', [childId, parentId]);
  await tx.query('UPDATE queries SET parent_query_id = $2 WHERE parent_query_id = $1', [childId, parentId]);
  await tx.query('UPDATE attachments SET query_id = $2 WHERE query_id = $1', [childId, parentId]);
  await transition(tx, ctx, childId, 'merged', { reason: `Merged into ${parent.reference}` });
  await tx.query(
    `INSERT INTO interactions (query_id, company_id, contact_id, channel, direction, visibility, body, actor_type, actor_id, actor_name)
     VALUES ($1,$2,$3,'system','internal','internal',$4,'user',$5,$6)`,
    [parentId, parent.company_id, parent.contact_id, `${child.reference} merged into this case by ${ctx.actorName}. Its conversation is preserved in the timeline.`, ctx.actorId, ctx.actorName],
  );
  if (child.contact_id) {
    await notify(tx, { template: 'query_merged', to: { type: 'contact', id: child.contact_id }, vars: { ...(await templateVars(tx, child)), parent: { reference: parent.reference } }, queryId: childId });
  }
  await audit(tx, ctx, 'query.merged', 'query', childId, { parent_query_id: null }, { parent_query_id: parentId, parent_reference: parent.reference });
  await emit(tx, 'query.merged', { id: childId, reference: child.reference, into: parent.reference });
  return { merged: child.reference, into: parent.reference };
}

export async function dismissDuplicate(tx: Tx, ctx: Ctx, id: string) {
  const q = await one(tx, 'SELECT possible_duplicate_of FROM queries WHERE id = $1', [id]);
  if (!q) throw notFound();
  await tx.query('UPDATE queries SET possible_duplicate_of = NULL, duplicate_score = NULL WHERE id = $1', [id]);
  await audit(tx, ctx, 'query.duplicate_dismissed', 'query', id, { possible_duplicate_of: q.possible_duplicate_of }, { possible_duplicate_of: null });
}

/** QMC-05 review queue: release a filtered item (it is triaged and assigned) or confirm the filter. */
export async function reviewFiltered(tx: Tx, ctx: Ctx, id: string, decision: 'release' | 'confirm') {
  const q = await one(tx, 'SELECT * FROM queries WHERE id = $1', [id]);
  if (!q) throw notFound();
  if (q.state !== 'filtered') throw conflict('Only filtered items can be reviewed');
  await tx.query(
    `INSERT INTO classification_signals (query_id, predicted, final, overridden, kind, actor_id) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, JSON.stringify({ filter_reason: q.filter_reason }), JSON.stringify({ decision, category: q.filter_reason?.match(/: (\w+)/)?.[1] ?? 'recruitment' }),
     decision === 'release', decision === 'release' ? 'filter_release' : 'filter_confirm', ctx.actorId],
  );
  invalidateModels();
  await audit(tx, ctx, `query.filter_${decision}d`, 'query', id, { state: 'filtered' }, { decision });
  if (decision === 'confirm') {
    await tx.query(`UPDATE queries SET closed_at = now() WHERE id = $1`, [id]);
    return { decision };
  }
  await transition(tx, ctx, id, 'received');
  await transition(tx, systemCtx('intake'), id, 'triaged');
  await tx.query('UPDATE queries SET filter_reason = NULL WHERE id = $1', [id]);
  const { startClock } = await import('./sla.js');
  await startClock(tx, id);
  const refreshed = await one(tx, 'SELECT * FROM queries WHERE id = $1', [id]);
  if (refreshed.contact_id) await notify(tx, { template: 'query_created', to: { type: 'contact', id: refreshed.contact_id }, vars: await templateVars(tx, refreshed), queryId: id });
  const a = await assign(tx, systemCtx('assignment-engine'), id);
  return { decision, assignment: a.assigned };
}

/** Customer posts a message on their own case from the portal. */
export async function customerMessage(tx: Tx, ctx: Ctx, id: string, body: string) {
  if (ctx.actorType !== 'contact') throw forbidden();
  const q = await one(tx, 'SELECT * FROM queries WHERE id = $1', [id]);
  if (!q) throw notFound('Query not found');
  const { intake } = await import('./intake.js');
  return intake(tx, ctx, { channel: 'portal', subject: `Re: ${q.reference}`, body, contactId: ctx.actorId, companyId: q.company_id });
}

export const isClosedState = (s: string) => CLOSED.includes(s);
