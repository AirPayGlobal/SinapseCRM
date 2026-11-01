import { asSystem, many, one, type Tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { isBusinessTime } from '../lib/calendar.js';
import { systemCtx, type Ctx } from '../lib/context.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { emit } from './events.js';
import { notify, raiseAlert, usersWithRole } from './notifications.js';
import { defaultCalendar } from './sla.js';
import { availableTransitions, getDefinition, transition } from './workflow.js';

/**
 * Assignment engine (TA-01 .. TA-01.5), evaluated in sequence:
 *   eligibility → availability → capacity → strategy → atomic claim.
 * Load is weighted open work, not a ticket count. Availability combines presence, working pattern,
 * leave and out-of-office (synchronised from Outlook through Microsoft Graph). Where nobody eligible
 * is available the case holds in queue and a supervisor is alerted.
 */

export const URGENCY_WEIGHT: Record<string, number> = { low: 0.75, normal: 1, high: 1.5, critical: 2 };
const CLOSED_STATES = `('resolved','closed','merged','filtered')`;

export interface Candidate {
  id: string;
  name: string;
  skills: string[];
  capacity: number;
  load: number;
  presence: string;
  excluded?: string;
}

export async function agentLoads(tx: Tx, userIds?: string[]) {
  return many<{ user_id: string; load: number; open_count: number }>(
    tx,
    `SELECT q.assigned_to AS user_id,
            sum(coalesce(qt.weight, 1) * CASE q.urgency WHEN 'low' THEN 0.75 WHEN 'high' THEN 1.5 WHEN 'critical' THEN 2 ELSE 1 END)::float AS load,
            count(*)::int AS open_count
       FROM queries q LEFT JOIN query_types qt ON qt.key = q.query_type_key
      WHERE q.assigned_to IS NOT NULL AND q.state NOT IN ${CLOSED_STATES}
        AND ($1::uuid[] IS NULL OR q.assigned_to = ANY($1))
      GROUP BY q.assigned_to`,
    [userIds ?? null],
  );
}

async function resolveQueue(tx: Tx, q: any) {
  if (q.queue_id) return one(tx, 'SELECT * FROM queues WHERE id = $1', [q.queue_id]);
  const byType = q.query_type_key
    ? await one(tx, `SELECT qu.* FROM queues qu JOIN query_types qt ON qt.queue_key = qu.key WHERE qt.key = $1 AND qu.active`, [q.query_type_key])
    : null;
  if (byType) return byType;
  return one(
    tx,
    `SELECT * FROM queues WHERE active AND (department_id = $1 OR department_id IS NULL) AND (port_code = $2 OR port_code IS NULL)
      ORDER BY (department_id = $1) DESC NULLS LAST, (port_code = $2) DESC NULLS LAST LIMIT 1`,
    [q.department_id, q.port_code],
  );
}

/** Evaluate every potential agent and explain why each one is or is not eligible right now. */
export async function evaluateCandidates(tx: Tx, q: any, queue: any, opts: { exclude?: string[] } = {}) {
  const qt = q.query_type_key ? await one(tx, 'SELECT * FROM query_types WHERE key = $1', [q.query_type_key]) : null;
  const requiredSkills: string[] = [...(queue?.required_skills ?? [])];
  if (queue?.strategy === 'skills' && qt?.skill) requiredSkills.push(qt.skill);
  const weight = (qt?.weight ?? 1) * (URGENCY_WEIGHT[q.urgency] ?? 1);

  const users = await many(
    tx,
    `SELECT u.id, u.name, u.skills, u.capacity, u.presence, u.port_code, u.department_id, u.role_key,
            a.out_of_office, a.ooo_from, a.ooo_until, a.working_pattern,
            EXISTS (SELECT 1 FROM leave_periods l WHERE l.user_id = u.id AND now() BETWEEN l.starts_at AND l.ends_at) AS on_leave
       FROM users u LEFT JOIN agent_availability a ON a.user_id = u.id
      WHERE u.active AND u.role_key = ANY($1)`,
    [queue?.eligible_roles ?? ['agent', 'supervisor']],
  );
  const loads = new Map((await agentLoads(tx, users.map((u) => u.id))).map((l) => [l.user_id, l.load]));
  const cal = await defaultCalendar(tx);
  const now = new Date();

  const out: (Candidate & { weightAfter: number; skillScore: number })[] = [];
  for (const u of users) {
    const c = { id: u.id, name: u.name, skills: u.skills, capacity: Number(u.capacity), load: loads.get(u.id) ?? 0, presence: u.presence, weightAfter: 0, skillScore: 0 } as Candidate & { weightAfter: number; skillScore: number };
    c.weightAfter = c.load + weight;
    c.skillScore = qt?.skill && u.skills.includes(qt.skill) ? 1 : 0;
    // 1. eligibility
    if (u.port_code && u.port_code !== q.port_code) c.excluded = `works at ${u.port_code}`;
    else if (queue?.department_id && u.department_id && u.department_id !== queue.department_id) c.excluded = 'different department';
    else if (requiredSkills.some((s) => !u.skills.includes(s))) c.excluded = `missing skill: ${requiredSkills.filter((s) => !u.skills.includes(s)).join(', ')}`;
    else if (opts.exclude?.includes(u.id)) c.excluded = 'excluded for this reassignment';
    // 2. availability
    else if (u.on_leave) c.excluded = 'on leave';
    else if (u.out_of_office && (!u.ooo_from || new Date(u.ooo_from) <= now) && (!u.ooo_until || new Date(u.ooo_until) > now)) c.excluded = 'out of office (Outlook)';
    else if (['away', 'offline'].includes(u.presence)) c.excluded = `presence: ${u.presence}`;
    else if (!isBusinessTime(cal, now, u.working_pattern)) c.excluded = 'outside working pattern';
    // 3. capacity
    else if (c.weightAfter > c.capacity) c.excluded = `at capacity (${c.load.toFixed(1)}/${c.capacity})`;
    out.push(c);
  }
  return { candidates: out, weight, requiredSkills };
}

function pick<T extends Candidate & { skillScore: number }>(strategy: string, eligible: T[], lastAssigned: string | null): T | null {
  if (!eligible.length) return null;
  if (strategy === 'round_robin') {
    const sorted = [...eligible].sort((a, b) => a.id.localeCompare(b.id));
    const idx = lastAssigned ? sorted.findIndex((c) => c.id.localeCompare(lastAssigned) > 0) : 0;
    return sorted[idx === -1 ? 0 : idx];
  }
  const ratio = (c: Candidate) => c.load / Math.max(c.capacity, 0.0001);
  return [...eligible].sort((a, b) =>
    strategy === 'skills' ? b.skillScore - a.skillScore || ratio(a) - ratio(b) : ratio(a) - ratio(b) || a.load - b.load,
  )[0];
}

/**
 * Atomic claim: the assignee is set only where nobody else holds the case, inside an advisory lock
 * on the agent so their capacity cannot be over-committed by concurrent assignment.
 */
async function claim(tx: Tx, queryId: string, agent: Candidate & { weightAfter: number }, queueId: string | null) {
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`agent:${agent.id}`]);
  const [l] = await agentLoads(tx, [agent.id]);
  const weightNow = agent.weightAfter - agent.load;
  if ((l?.load ?? 0) + weightNow > agent.capacity) return false;
  const r = await tx.query(
    `UPDATE queries SET assigned_to = $2, assigned_at = now(), queue_id = coalesce($3, queue_id), unassignable_alerted_at = NULL
      WHERE id = $1 AND assigned_to IS NULL RETURNING id`,
    [queryId, agent.id, queueId],
  );
  return r.rowCount === 1;
}

export async function assign(tx: Tx, ctx: Ctx, queryId: string, opts: { exclude?: string[] } = {}) {
  return asSystem(tx, () => assignInner(tx, ctx, queryId, opts));
}

async function assignInner(tx: Tx, ctx: Ctx, queryId: string, opts: { exclude?: string[] }) {
  const q = await one(tx, 'SELECT * FROM queries WHERE id = $1', [queryId]);
  if (!q) throw notFound('query not found');
  if (q.assigned_to) return { assigned: q.assigned_to as string, reason: 'already assigned', candidates: [] };
  const def = await getDefinition(tx, q.workflow_definition_id);
  if (!availableTransitions(def, q.state, { system: true }).some((t) => t.to === 'assigned')) {
    return { assigned: null, reason: `state ${q.state} is not assignable`, candidates: [] };
  }
  const queue = await resolveQueue(tx, q);
  if (queue && q.queue_id !== queue.id) await tx.query('UPDATE queries SET queue_id = $2 WHERE id = $1', [queryId, queue.id]);
  const { candidates } = await evaluateCandidates(tx, q, queue, opts);
  let eligible = candidates.filter((c) => !c.excluded);
  const strategy = queue?.strategy ?? 'least_loaded';

  while (eligible.length) {
    const chosen = pick(strategy, eligible, queue?.last_assigned_user_id ?? null)!;
    if (await claim(tx, queryId, chosen, queue?.id ?? null)) {
      if (queue) await tx.query('UPDATE queues SET last_assigned_user_id = $2 WHERE id = $1', [queue.id, chosen.id]);
      await tx.query(
        `INSERT INTO query_assignments (query_id, to_user_id, reason, strategy, actor_id) VALUES ($1,$2,$3,$4,$5)`,
        [queryId, chosen.id, 'automatic', strategy, ctx.actorId],
      );
      await audit(tx, ctx.actorType === 'system' ? ctx : systemCtx('assignment-engine'), 'query.assigned', 'query', queryId, { assigned_to: null },
        { assigned_to: chosen.id, strategy, load_before: chosen.load, capacity: chosen.capacity });
      await transition(tx, systemCtx('assignment-engine'), queryId, 'assigned');
      await emit(tx, 'query.assigned', { id: queryId, reference: q.reference, assigned_to: chosen.id });
      return { assigned: chosen.id, reason: strategy, candidates };
    }
    // lost the race for this agent or the case: refresh and try the next one
    const now = await one(tx, 'SELECT assigned_to FROM queries WHERE id = $1', [queryId]);
    if (now?.assigned_to) return { assigned: now.assigned_to, reason: 'claimed concurrently', candidates };
    eligible = eligible.filter((c) => c.id !== chosen.id);
  }

  // Nobody eligible: hold in queue, never assign to someone absent, never sit silently.
  const cal = await defaultCalendar(tx);
  const inHours = isBusinessTime(cal, new Date());
  if (inHours && !q.unassignable_alerted_at) {
    await tx.query('UPDATE queries SET unassignable_alerted_at = now() WHERE id = $1', [queryId]);
    const msg = `${q.reference} cannot be assigned: no eligible agent is available in ${queue?.name ?? 'any queue'}`;
    await raiseAlert(tx, { kind: 'unassignable', message: msg, queryId, port: q.port_code, departmentId: q.department_id, targetRole: 'supervisor', dedupeKey: `unassignable:${queryId}` });
    for (const s of await usersWithRole(tx, 'supervisor', q.port_code, q.department_id)) {
      await notify(tx, { template: 'unassignable_alert', to: { type: 'user', id: s.id }, vars: { reference: q.reference, queue: queue?.name ?? '' }, queryId, channels: ['in_app', 'teams'] });
    }
  }
  return { assigned: null, reason: inHours ? 'no eligible agent available' : 'outside business hours — held in queue', candidates };
}

/** TA-01.5 — manual reassignment with a captured reason; history retained and reported. */
export async function reassign(tx: Tx, ctx: Ctx, queryId: string, toUserId: string | null, reason: string) {
  if (!reason?.trim()) throw badRequest('A reason is required to reassign');
  const q = await one(tx, 'SELECT * FROM queries WHERE id = $1 FOR UPDATE', [queryId]);
  if (!q) throw notFound('query not found');
  if (['resolved', 'closed', 'merged', 'filtered'].includes(q.state)) throw conflict('Closed cases cannot be reassigned');
  if (toUserId) {
    const u = await one(tx, 'SELECT id, active FROM users WHERE id = $1', [toUserId]);
    if (!u?.active) throw badRequest('Target agent is not active');
  }
  const from = q.assigned_to;
  await tx.query(
    `UPDATE queries SET assigned_to = $2, assigned_at = CASE WHEN $2::uuid IS NULL THEN NULL ELSE now() END,
            reassignment_count = reassignment_count + 1, updated_at = now() WHERE id = $1`,
    [queryId, toUserId],
  );
  await tx.query(`INSERT INTO query_assignments (query_id, from_user_id, to_user_id, reason, strategy, actor_id) VALUES ($1,$2,$3,$4,'manual',$5)`,
    [queryId, from, toUserId, reason, ctx.actorId]);
  await audit(tx, ctx, 'query.reassigned', 'query', queryId, { assigned_to: from }, { assigned_to: toUserId, reason });

  if (toUserId) {
    if (q.state === 'triaged' || q.state === 'reopened') await transition(tx, systemCtx('assignment-engine'), queryId, 'assigned');
    else {
      const { templateVars } = await import('./workflow.js');
      await notify(tx, { template: 'query_assigned', to: { type: 'user', id: toUserId }, vars: await templateVars(tx, { ...q, assigned_to: toUserId }), queryId, channels: ['in_app', 'email'] });
    }
    await emit(tx, 'query.assigned', { id: queryId, reference: q.reference, assigned_to: toUserId, reassigned: true });
    return { assigned: toUserId };
  }
  // automatic reassignment: return to queue and run the engine excluding the previous holder
  if (['assigned', 'in_progress'].includes(q.state)) {
    await tx.query(`UPDATE queries SET state = 'triaged' WHERE id = $1`, [queryId]);
    await audit(tx, ctx, 'query.transition', 'query', queryId, { state: q.state }, { state: 'triaged', reason: 'returned to queue for reassignment' });
  }
  return assign(tx, ctx, queryId, { exclude: from ? [from] : [] });
}

/** Re-run assignment for cases holding in queue (called by the scheduler and on availability change). */
export async function drainQueues(tx: Tx) {
  const waiting = await many<{ id: string }>(
    tx, `SELECT id FROM queries WHERE assigned_to IS NULL AND state IN ('triaged','reopened') ORDER BY created_at LIMIT 100`,
  );
  let assigned = 0;
  for (const w of waiting) {
    const r = await assign(tx, systemCtx('assignment-engine'), w.id);
    if (r.assigned) assigned++;
  }
  return { examined: waiting.length, assigned };
}
