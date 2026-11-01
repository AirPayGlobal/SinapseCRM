import { many, one, type Tx } from '../db/pool.js';
import { audit, diff } from '../lib/audit.js';
import type { Ctx } from '../lib/context.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { similarity } from '../lib/text.js';
import { emit } from './events.js';
import { notify } from './notifications.js';
import { nextReference } from './reference.js';

/**
 * Audit findings management (AM-02 .. AM-02.2). Findings share the platform's notification and
 * escalation engines; remediation tasks are child records whose progress rolls up to the finding.
 */

const STATES = ['open', 'accepted', 'in_remediation', 'pending_verification', 'closed'];
const FLOW: Record<string, string[]> = {
  open: ['accepted'],
  accepted: ['in_remediation', 'pending_verification'],
  in_remediation: ['pending_verification'],
  pending_verification: ['closed', 'in_remediation'],
  closed: ['in_remediation'],
};

export async function detectRecurrence(tx: Tx, title: string, description: string, excludeId?: string) {
  const closed = await many<{ id: string; reference: string; text: string }>(
    tx,
    `SELECT id, reference, title || ' ' || description AS text FROM findings WHERE state = 'closed' AND ($1::uuid IS NULL OR id <> $1) ORDER BY closed_at DESC LIMIT 300`,
    [excludeId ?? null],
  );
  const text = `${title} ${description}`;
  let best: { id: string; reference: string; score: number } | null = null;
  for (const f of closed) {
    const s = similarity(text, f.text, closed.map((c) => c.text).slice(0, 50));
    if (s >= 0.5 && (!best || s > best.score)) best = { id: f.id, reference: f.reference, score: Number(s.toFixed(3)) };
  }
  return best;
}

export async function createFinding(tx: Tx, ctx: Ctx, input: {
  title: string; description?: string; finding_type_key?: string; source: string; severity: string; owner_id?: string;
  department_id?: string; port_code?: string; due_date?: string; linked_query_id?: string; linked_company_id?: string;
}) {
  if (!input.title?.trim() || !input.source || !input.severity) throw badRequest('Title, source and severity are required');
  const recurrence = await detectRecurrence(tx, input.title, input.description ?? '');
  const reference = await nextReference(tx, 'FND', 'finding.reference.mask', 'FND');
  const f = await one(
    tx,
    `INSERT INTO findings (reference, title, description, finding_type_key, source, severity, owner_id, department_id, port_code, due_date,
                           linked_query_id, linked_company_id, recurrence_of, recurrence_score, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [reference, input.title.trim(), input.description ?? '', input.finding_type_key ?? null, input.source, input.severity, input.owner_id ?? null,
     input.department_id ?? ctx.staff?.departmentId ?? null, input.port_code ?? ctx.staff?.portCode ?? null, input.due_date ?? null,
     input.linked_query_id ?? null, input.linked_company_id ?? null, recurrence?.id ?? null, recurrence?.score ?? null, ctx.actorId],
  );
  if (f.owner_id) await notify(tx, { template: 'finding_assigned', to: { type: 'user', id: f.owner_id }, vars: { finding: f }, channels: ['in_app', 'email'] });
  await audit(tx, ctx, 'finding.created', 'finding', f.id, undefined, f);
  await emit(tx, 'finding.created', { id: f.id, reference, severity: f.severity });
  return { ...f, recurrence };
}

export async function listFindings(tx: Tx, f: { state?: string; severity?: string; owner_id?: string; overdue?: boolean }) {
  const where: string[] = [];
  const p: unknown[] = [];
  if (f.state) { p.push(f.state); where.push(`f.state = $${p.length}`); }
  if (f.severity) { p.push(f.severity); where.push(`f.severity = $${p.length}`); }
  if (f.owner_id) { p.push(f.owner_id); where.push(`f.owner_id = $${p.length}`); }
  if (f.overdue) where.push(`f.state <> 'closed' AND f.due_date < current_date`);
  return many(
    tx,
    `SELECT f.*, u.name AS owner_name, d.name AS department_name, r.reference AS recurrence_reference,
            (SELECT count(*)::int FROM remediation_tasks t WHERE t.finding_id = f.id AND t.state <> 'cancelled') AS task_count,
            (SELECT count(*)::int FROM remediation_tasks t WHERE t.finding_id = f.id AND t.state = 'done') AS tasks_done,
            (SELECT count(*)::int FROM remediation_tasks t WHERE t.finding_id = f.id AND t.state IN ('open','in_progress') AND t.due_date < current_date) AS tasks_overdue
       FROM findings f LEFT JOIN users u ON u.id = f.owner_id LEFT JOIN departments d ON d.id = f.department_id
       LEFT JOIN findings r ON r.id = f.recurrence_of
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY f.state = 'closed', CASE f.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, f.due_date NULLS LAST`,
    p,
  );
}

export async function getFinding(tx: Tx, id: string) {
  const f = await one(
    tx,
    `SELECT f.*, u.name AS owner_name, q.reference AS linked_query_reference, c.name AS linked_company_name, r.reference AS recurrence_reference
       FROM findings f LEFT JOIN users u ON u.id = f.owner_id LEFT JOIN queries q ON q.id = f.linked_query_id
       LEFT JOIN companies c ON c.id = f.linked_company_id LEFT JOIN findings r ON r.id = f.recurrence_of WHERE f.id = $1`,
    [id],
  );
  if (!f) throw notFound('Finding not found');
  const tasks = await many(
    tx,
    `SELECT t.*, u.name AS owner_name, a.filename AS evidence_filename FROM remediation_tasks t
       LEFT JOIN users u ON u.id = t.owner_id LEFT JOIN attachments a ON a.id = t.evidence_attachment_id
      WHERE t.finding_id = $1 ORDER BY t.created_at`,
    [id],
  );
  const active = tasks.filter((t) => t.state !== 'cancelled');
  const history = await many(tx, `SELECT action, actor_name, before, after, occurred_at FROM event_log WHERE entity = 'finding' AND entity_id = $1 ORDER BY id`, [id]);
  const evidence = await many(tx, `SELECT id, filename, size_bytes, created_at, task_id FROM attachments WHERE finding_id = $1 ORDER BY created_at`, [id]);
  return { ...f, tasks, evidence, history, progress: active.length ? Math.round((100 * active.filter((t) => t.state === 'done').length) / active.length) : 0 };
}

export async function updateFinding(tx: Tx, ctx: Ctx, id: string, patch: Record<string, any>) {
  const f = await one(tx, 'SELECT * FROM findings WHERE id = $1 FOR UPDATE', [id]);
  if (!f) throw notFound('Finding not found');
  const next: Record<string, any> = {};
  for (const k of ['title', 'description', 'severity', 'owner_id', 'due_date', 'department_id', 'finding_type_key', 'linked_query_id', 'linked_company_id']) if (k in patch) next[k] = patch[k] || null;
  if ('owner_id' in next && next.owner_id !== f.owner_id) {
    next.owner_accepted_at = null;
    if (f.state === 'accepted') next.state = 'open';
  }
  const d = diff(f, next);
  if (!d.changed) return f;
  const keys = Object.keys(d.after);
  await tx.query(`UPDATE findings SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`, [id, ...keys.map((k) => d.after[k])]);
  if (d.after.owner_id) await notify(tx, { template: 'finding_assigned', to: { type: 'user', id: d.after.owner_id as string }, vars: { finding: { ...f, ...next } }, channels: ['in_app', 'email'] });
  await audit(tx, ctx, 'finding.updated', 'finding', id, d.before, d.after);
  return one(tx, 'SELECT * FROM findings WHERE id = $1', [id]);
}

export async function transitionFinding(tx: Tx, ctx: Ctx, id: string, to: string, note?: string) {
  if (!STATES.includes(to)) throw badRequest('Unknown state');
  const f = await one(tx, 'SELECT * FROM findings WHERE id = $1 FOR UPDATE', [id]);
  if (!f) throw notFound('Finding not found');
  if (!FLOW[f.state]?.includes(to)) throw conflict(`A finding cannot move from ${f.state} to ${to}`);
  if (to === 'accepted' && f.owner_id !== ctx.actorId) throw forbidden('Only the assigned owner can accept a finding');
  if (to === 'closed') {
    const open = await one<{ n: number; missing: number }>(
      tx,
      `SELECT count(*) FILTER (WHERE state IN ('open','in_progress'))::int AS n,
              count(*) FILTER (WHERE state = 'done' AND evidence_attachment_id IS NULL)::int AS missing
         FROM remediation_tasks WHERE finding_id = $1`,
      [id],
    );
    if (open!.n) throw badRequest(`${open!.n} remediation task(s) are still open`);
    if (open!.missing) throw badRequest('Every completed task needs closure evidence before the finding can be closed');
    if (f.owner_id === ctx.actorId && f.severity !== 'low') throw forbidden('Closure of a finding must be verified by someone other than its owner');
  }
  await tx.query(
    `UPDATE findings SET state = $2, updated_at = now(),
            owner_accepted_at = CASE WHEN $2 = 'accepted' THEN now() ELSE owner_accepted_at END,
            closed_at = CASE WHEN $2 = 'closed' THEN now() WHEN $2 = 'in_remediation' THEN NULL ELSE closed_at END
      WHERE id = $1`,
    [id, to],
  );
  await audit(tx, ctx, 'finding.transition', 'finding', id, { state: f.state }, { state: to, note: note ?? null });
  if (to === 'closed') await emit(tx, 'finding.closed', { id, reference: f.reference });
  return one(tx, 'SELECT * FROM findings WHERE id = $1', [id]);
}

export async function addTask(tx: Tx, ctx: Ctx, findingId: string, input: { title: string; owner_id?: string; due_date?: string }) {
  if (!input.title?.trim()) throw badRequest('Task title is required');
  const f = await one(tx, 'SELECT * FROM findings WHERE id = $1', [findingId]);
  if (!f) throw notFound('Finding not found');
  if (f.state === 'closed') throw conflict('Finding is closed');
  const t = await one(tx, `INSERT INTO remediation_tasks (finding_id, title, owner_id, due_date) VALUES ($1,$2,$3,$4) RETURNING *`,
    [findingId, input.title.trim(), input.owner_id ?? null, input.due_date ?? null]);
  if (f.state === 'accepted') await tx.query(`UPDATE findings SET state = 'in_remediation', updated_at = now() WHERE id = $1`, [findingId]);
  if (t.owner_id) await notify(tx, { template: 'remediation_task_assigned', to: { type: 'user', id: t.owner_id }, vars: { finding: f, task: t }, channels: ['in_app', 'email'] });
  await audit(tx, ctx, 'finding.task_added', 'finding', findingId, undefined, t);
  return t;
}

export async function updateTask(tx: Tx, ctx: Ctx, taskId: string, patch: { state?: string; owner_id?: string; due_date?: string; completion_note?: string; evidence_attachment_id?: string; title?: string }) {
  const t = await one(tx, 'SELECT * FROM remediation_tasks WHERE id = $1 FOR UPDATE', [taskId]);
  if (!t) throw notFound('Task not found');
  if (patch.state && !['open', 'in_progress', 'done', 'cancelled'].includes(patch.state)) throw badRequest('Invalid task state');
  const next: Record<string, any> = {};
  for (const k of ['state', 'owner_id', 'due_date', 'completion_note', 'evidence_attachment_id', 'title'] as const) if (k in patch) next[k] = patch[k];
  if (next.state === 'done') {
    next.completed_at = new Date();
    if (!(next.evidence_attachment_id ?? t.evidence_attachment_id) && !next.completion_note) throw badRequest('Attach evidence or record a completion note to complete a task');
  }
  const d = diff(t, next);
  if (!d.changed) return t;
  const keys = Object.keys(d.after);
  await tx.query(`UPDATE remediation_tasks SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [taskId, ...keys.map((k) => d.after[k])]);
  await audit(tx, ctx, 'finding.task_updated', 'finding', t.finding_id, { task_id: taskId, ...d.before }, { task_id: taskId, ...d.after });
  // Roll-up: when all active tasks are done, the finding moves to verification
  const agg = await one<{ open: number; total: number }>(tx,
    `SELECT count(*) FILTER (WHERE state IN ('open','in_progress'))::int AS open, count(*) FILTER (WHERE state <> 'cancelled')::int AS total FROM remediation_tasks WHERE finding_id = $1`, [t.finding_id]);
  const f = await one(tx, 'SELECT state FROM findings WHERE id = $1', [t.finding_id]);
  if (agg!.total > 0 && agg!.open === 0 && ['accepted', 'in_remediation'].includes(f.state)) {
    await tx.query(`UPDATE findings SET state = 'pending_verification', updated_at = now() WHERE id = $1`, [t.finding_id]);
    await audit(tx, ctx, 'finding.transition', 'finding', t.finding_id, { state: f.state }, { state: 'pending_verification', note: 'all remediation tasks complete' });
  } else if (next.state === 'in_progress' && f.state === 'accepted') {
    await tx.query(`UPDATE findings SET state = 'in_remediation', updated_at = now() WHERE id = $1`, [t.finding_id]);
  }
  return one(tx, 'SELECT * FROM remediation_tasks WHERE id = $1', [taskId]);
}
