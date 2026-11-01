import { asSystem, many, one, type Tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { systemCtx, type Ctx } from '../lib/context.js';
import { badRequest } from '../lib/errors.js';
import { similarity } from '../lib/text.js';
import { assign } from './assignment.js';
import { classify, evaluateFilter, type Classification } from './classifier.js';
import { validateCustomFields } from './customFields.js';
import { emit } from './events.js';
import { notify } from './notifications.js';
import { nextReference, REFERENCE_PATTERN } from './reference.js';
import { getSetting } from './settings.js';
import { startClock } from './sla.js';
import { publishedDefinitionId, templateVars, transition } from './workflow.js';

/**
 * One Query record whatever the channel (QMC-01, QMC-01.1). Arrival → normalise → de-duplicate →
 * filter → classify → enrich → create with reference → acknowledge → assign.
 */

export type IntakeChannel = 'portal' | 'widget' | 'email' | 'phone' | 'assist' | 'staff';

export interface IntakeInput {
  channel: IntakeChannel;
  subject: string;
  body: string;
  port?: string;
  contactId?: string | null;
  companyId?: string | null;
  from?: { email?: string; name?: string; phone?: string };
  externalMessageId?: string;
  threadId?: string;
  queryTypeKey?: string;
  urgency?: 'low' | 'normal' | 'high' | 'critical';
  customFields?: Record<string, unknown>;
  vesselCallId?: string;
  cargoReferenceId?: string;
  call?: { durationSeconds?: number; outcome?: string; direction?: 'inbound' | 'outbound' };
  createdBy?: string | null;
  /** Assist hands over with the transcript; it is recorded on the case. */
  transcript?: string;
}

export interface IntakeResult {
  outcome: 'created' | 'threaded' | 'duplicate_message' | 'filtered';
  query: any;
  interactionId?: string;
  possibleDuplicateOf?: { id: string; reference: string; score: number } | null;
  classification?: Classification;
  assignment?: { assigned: string | null; reason: string };
}

const CONTAINER_RE = /\b([A-Z]{4}\d{7})\b/;
const LUDERITZ_RE = /l(u|ü|ue)deritz/i;

async function resolveCustomer(tx: Tx, input: IntakeInput) {
  let contactId = input.contactId ?? null;
  let companyId = input.companyId ?? null;
  if (!contactId && input.from?.email) {
    const c = await one<{ id: string }>(tx, 'SELECT id FROM contacts WHERE lower(email) = lower($1)', [input.from.email]);
    contactId = c?.id ?? null;
  }
  if (!contactId && input.from?.phone) {
    const digits = input.from.phone.replace(/\D/g, '');
    if (digits.length >= 7) {
      const c = await one<{ id: string }>(tx, `SELECT id FROM contacts WHERE regexp_replace(coalesce(phone,''), '\\D', '', 'g') LIKE '%' || $1`, [digits.slice(-9)]);
      contactId = c?.id ?? null;
    }
  }
  if (contactId && !companyId) {
    const cc = await one<{ company_id: string }>(
      tx,
      `SELECT cc.company_id FROM company_contacts cc JOIN companies co ON co.id = cc.company_id
        WHERE cc.contact_id = $1 AND cc.status = 'active' AND co.status = 'active'
        ORDER BY (cc.role = 'primary') DESC, cc.created_at LIMIT 1`,
      [contactId],
    );
    companyId = cc?.company_id ?? null;
  }
  const company = companyId ? await one(tx, 'SELECT id, account_tier, ports_served FROM companies WHERE id = $1', [companyId]) : null;
  return { contactId, companyId, company };
}

async function enrichPortContext(tx: Tx, text: string, input: IntakeInput) {
  let vesselCallId = input.vesselCallId ?? null;
  let cargoId = input.cargoReferenceId ?? null;
  let corridorId: string | null = null;
  if (!cargoId) {
    const m = text.toUpperCase().match(CONTAINER_RE);
    if (m) {
      const cr = await one(tx, 'SELECT id, vessel_call_id, corridor_id FROM cargo_references WHERE container_no = $1', [m[1]]);
      if (cr) { cargoId = cr.id; vesselCallId ??= cr.vessel_call_id; corridorId = cr.corridor_id; }
    }
  }
  if (!vesselCallId) {
    const calls = await many<{ id: string; vessel_name: string; voyage_no: string; corridor_id: string | null }>(
      tx, `SELECT id, vessel_name, voyage_no, corridor_id FROM vessel_calls WHERE status <> 'departed' OR updated_at > now() - interval '30 days'`,
    );
    const lower = text.toLowerCase();
    const hit = calls.find((c) => lower.includes(c.voyage_no.toLowerCase()) && c.voyage_no.length >= 3)
      ?? calls.find((c) => lower.includes(c.vessel_name.toLowerCase()));
    if (hit) { vesselCallId = hit.id; corridorId ??= hit.corridor_id; }
  } else if (!corridorId) {
    corridorId = (await one(tx, 'SELECT corridor_id FROM vessel_calls WHERE id = $1', [vesselCallId]))?.corridor_id ?? null;
  }
  return { vesselCallId, cargoId, corridorId };
}

/** Near-duplicate detection: same customer, open, recent, materially similar wording. */
export async function findNearDuplicate(tx: Tx, text: string, contactId: string | null, companyId: string | null, excludeId?: string) {
  if (!contactId && !companyId) return null;
  const lookback = await getSetting<number>(tx, 'dedup.lookback_days');
  const threshold = await getSetting<number>(tx, 'dedup.similarity_threshold');
  const open = await many<{ id: string; reference: string; text: string }>(
    tx,
    `SELECT id, reference, subject || ' ' || left(description, 3000) AS text FROM queries
      WHERE (contact_id = $1 OR company_id = $2) AND state NOT IN ('closed','merged','filtered')
        AND created_at > now() - ($3 || ' days')::interval AND ($4::uuid IS NULL OR id <> $4)
      ORDER BY created_at DESC LIMIT 50`,
    [contactId, companyId, String(lookback), excludeId ?? null],
  );
  const corpus = open.map((o) => o.text);
  let best: { id: string; reference: string; score: number } | null = null;
  for (const o of open) {
    const s = similarity(text, o.text, corpus);
    if (s >= threshold && (!best || s > best.score)) best = { id: o.id, reference: o.reference, score: Number(s.toFixed(3)) };
  }
  return best;
}

/** Find the case an inbound message belongs to: by thread id, or a reference in the subject/body. */
async function findThread(tx: Tx, input: IntakeInput, contactId: string | null) {
  if (input.threadId) {
    const t = await one(tx, `SELECT q.* FROM interactions i JOIN queries q ON q.id = i.query_id WHERE i.thread_id = $1 ORDER BY i.occurred_at DESC LIMIT 1`, [input.threadId]);
    if (t) return t;
  }
  const m = `${input.subject} ${input.body}`.match(REFERENCE_PATTERN);
  if (m) {
    const q = await one(tx, 'SELECT * FROM queries WHERE reference = $1', [m[0]]);
    if (!q) return null;
    // Only thread onto a case the sender is party to (or an unknown sender writing about their own reference by email)
    if (!contactId || q.contact_id === contactId || (await one(tx, `SELECT 1 FROM company_contacts WHERE contact_id = $1 AND company_id = $2 AND status='active'`, [contactId, q.company_id]))) {
      return q.parent_query_id ? one(tx, 'SELECT * FROM queries WHERE id = $1', [q.parent_query_id]) : q;
    }
  }
  return null;
}

const actorTypeFor = (ctx: Ctx) => (ctx.actorType === 'contact' ? 'contact' : ctx.actorType === 'user' ? 'user' : ctx.actorType === 'assist' ? 'assist' : 'system');

export async function intake(tx: Tx, ctx: Ctx, input: IntakeInput): Promise<IntakeResult> {
  return asSystem(tx, () => intakeInner(tx, ctx, input));
}

async function intakeInner(tx: Tx, ctx: Ctx, input: IntakeInput): Promise<IntakeResult> {
  const subject = (input.subject ?? '').trim().slice(0, 300);
  const body = (input.body ?? '').trim();
  if (!subject && !body) throw badRequest('A subject or message is required');
  const text = `${subject}\n${body}`;

  // 1. Idempotency on the external message identifier: a replay cannot create a second case.
  if (input.externalMessageId) {
    const dup = await one(tx, `SELECT q.* FROM interactions i LEFT JOIN queries q ON q.id = i.query_id WHERE i.external_message_id = $1`, [input.externalMessageId]);
    if (dup) return { outcome: 'duplicate_message', query: dup };
  }

  // 2. Normalise: match the customer
  const { contactId, companyId, company } = await resolveCustomer(tx, input);
  const interactionChannel = input.channel === 'staff' ? 'phone' : input.channel;
  const direction = input.call?.direction ?? 'inbound';
  const senderName = input.from?.name ?? input.from?.email ?? ctx.actorName;

  // 3a. Threading: replies to an existing case join it rather than opening a new one
  if (['email', 'portal', 'assist', 'widget'].includes(input.channel)) {
    const existing = await findThread(tx, input, contactId);
    if (existing && !['merged'].includes(existing.state)) {
      const ins = await one<{ id: string }>(
        tx,
        `INSERT INTO interactions (query_id, company_id, contact_id, channel, direction, visibility, subject, body, external_message_id, thread_id, actor_type, actor_id, actor_name)
         VALUES ($1,$2,$3,$4,'inbound','public',$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (external_message_id) WHERE external_message_id IS NOT NULL DO NOTHING RETURNING id`,
        [existing.id, existing.company_id, contactId ?? existing.contact_id, interactionChannel, subject, body, input.externalMessageId ?? null,
         input.threadId ?? null, actorTypeFor(ctx), ctx.actorId, senderName],
      );
      if (!ins) return { outcome: 'duplicate_message', query: existing };
      await tx.query('UPDATE queries SET updated_at = now() WHERE id = $1', [existing.id]);
      // A customer reply restarts the clock where the case was waiting on them; after closure it reopens
      const sys = systemCtx('intake');
      if (existing.state === 'pending_customer') await transition(tx, { ...sys, actorType: 'contact', actorName: senderName, actorId: contactId }, existing.id, 'in_progress');
      else if (existing.state === 'closed' || existing.state === 'resolved') {
        await tx.query(
          `INSERT INTO interactions (query_id, company_id, contact_id, channel, direction, visibility, body, actor_type, actor_name)
           VALUES ($1,$2,$3,'note','internal','internal','Customer wrote again after resolution — review whether to reopen.','system','Sinapse')`,
          [existing.id, existing.company_id, existing.contact_id],
        );
        if (existing.assigned_to) await notify(tx, { template: 'customer_replied', to: { type: 'user', id: existing.assigned_to }, vars: await templateVars(tx, existing), queryId: existing.id, channels: ['in_app'] });
      } else if (existing.assigned_to) {
        await notify(tx, { template: 'customer_replied', to: { type: 'user', id: existing.assigned_to }, vars: await templateVars(tx, existing), queryId: existing.id, channels: ['in_app'] });
      }
      await audit(tx, ctx, 'interaction.created', 'query', existing.id, undefined, { interaction_id: ins.id, channel: interactionChannel, threaded: true });
      return { outcome: 'threaded', query: await one(tx, 'SELECT * FROM queries WHERE id = $1', [existing.id]), interactionId: ins.id };
    }
  }

  // 3b. Filter irrelevant traffic (agent-keyed calls are not filtered)
  const verdict = ['staff', 'phone'].includes(input.channel) ? null : await evaluateFilter(tx, text);

  // 4. Classify: proposed by the AI layer; staff-provided values are treated as confirmed
  const cls = await classify(tx, text, company?.account_tier);
  const typeKey = input.queryTypeKey ?? cls.query_type ?? (await one(tx, `SELECT key FROM query_types WHERE key = 'general'`))?.key ?? null;
  const qt = typeKey ? await one(tx, 'SELECT * FROM query_types WHERE key = $1', [typeKey]) : null;
  const confirmed = Boolean(input.queryTypeKey) || cls.auto_accepted;
  const urgency = input.urgency ?? cls.urgency;

  // 5. Near-duplicate detection — offer a merge rather than open a parallel case silently
  const nearDup = await findNearDuplicate(tx, text, contactId, companyId);

  // 6. Enrich: port context and port
  const portCtx = await enrichPortContext(tx, text, input);
  const port = input.port ?? (LUDERITZ_RE.test(text) ? 'LZ' : company?.ports_served?.length === 1 ? company.ports_served[0] : 'WB');

  const customFields = await validateCustomFields(tx, 'query', input.customFields ?? {}, { queryType: typeKey, partial: false, actor: ctx });
  const workflowId = await publishedDefinitionId(tx, qt?.workflow_key ?? 'default');
  const reference = await nextReference(tx, port);

  const q = await one(
    tx,
    `INSERT INTO queries (reference, subject, description, company_id, contact_id, query_type_key, urgency, department_id, port_code, channel,
                          state, workflow_definition_id, ai_classification, classification_confirmed, sentiment, possible_duplicate_of, duplicate_score,
                          vessel_call_id, cargo_reference_id, corridor_id, custom_fields, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'received',$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING *`,
    [reference, subject || body.slice(0, 120), body, companyId, contactId, typeKey, urgency, qt?.department_id ?? cls.department_id, port,
     input.channel, workflowId, JSON.stringify(cls), confirmed, cls.sentiment, nearDup?.id ?? null, nearDup?.score ?? null,
     portCtx.vesselCallId, portCtx.cargoId, portCtx.corridorId, JSON.stringify(customFields), input.createdBy ?? null],
  );

  const inter = await one<{ id: string }>(
    tx,
    `INSERT INTO interactions (query_id, company_id, contact_id, channel, direction, visibility, subject, body, external_message_id, thread_id,
                               call_duration_seconds, call_outcome, actor_type, actor_id, actor_name)
     VALUES ($1,$2,$3,$4,$5,'public',$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [q.id, companyId, contactId, interactionChannel, direction, subject, input.transcript ? `${body}\n\n--- Sinapse Assist conversation ---\n${input.transcript}` : body,
     input.externalMessageId ?? null, input.threadId ?? null, input.call?.durationSeconds ?? null, input.call?.outcome ?? null,
     actorTypeFor(ctx), ctx.actorId, senderName],
  );

  await tx.query(
    `INSERT INTO classification_signals (query_id, predicted, final, overridden, kind, actor_id) VALUES ($1,$2,$3,$4,'classification',$5)`,
    [q.id, JSON.stringify(cls), JSON.stringify({ query_type: typeKey, urgency }), Boolean(input.queryTypeKey && input.queryTypeKey !== cls.query_type), ctx.actorId],
  ).catch(() => undefined);

  await audit(tx, ctx, 'query.created', 'query', q.id, undefined, { reference, channel: input.channel, query_type: typeKey, urgency, port, possible_duplicate_of: nearDup?.reference ?? null });
  await emit(tx, 'query.created', { id: q.id, reference, channel: input.channel, query_type: typeKey, port, company_id: companyId });

  const sys = systemCtx('intake');
  if (verdict?.filtered) {
    await tx.query('UPDATE queries SET filter_reason = $2 WHERE id = $1', [q.id, verdict.reason]);
    await transition(tx, sys, q.id, 'filtered');
    return { outcome: 'filtered', query: await one(tx, 'SELECT * FROM queries WHERE id = $1', [q.id]), interactionId: inter!.id, classification: cls };
  }

  await transition(tx, sys, q.id, 'triaged');
  await startClock(tx, q.id);
  const created = await one(tx, 'SELECT * FROM queries WHERE id = $1', [q.id]);

  // Acknowledgement carrying the reference number on every submission
  const vars = await templateVars(tx, created);
  if (contactId) await notify(tx, { template: 'query_created', to: { type: 'contact', id: contactId }, vars, queryId: q.id });
  else if (input.from?.email) await notify(tx, { template: 'query_created', to: { type: 'address', address: input.from.email }, vars, queryId: q.id, channels: ['email'] });

  const assignment = await assign(tx, sys, q.id);
  return {
    outcome: 'created',
    query: await one(tx, 'SELECT * FROM queries WHERE id = $1', [q.id]),
    interactionId: inter!.id,
    possibleDuplicateOf: nearDup,
    classification: cls,
    assignment: { assigned: assignment.assigned, reason: assignment.reason },
  };
}
