import { many, one, type Tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { businessMinutesBetween } from '../lib/calendar.js';
import { systemCtx } from '../lib/context.js';
import { emit } from './events.js';
import { notify, raiseAlert, usersWithRole } from './notifications.js';
import { loadCalendar, targetsFor, type SlaPolicy } from './sla.js';
import { templateVars, transition } from './workflow.js';

/**
 * Overdue and escalation engine (WM-01.3 .. WM-01.5). Evaluated on a schedule against the service
 * clock (business hours + Namibian public holidays, paused states excluded):
 *   - pre-breach warning when the configured share of the target has elapsed;
 *   - breach alert when the target is missed;
 *   - escalation through the matrix levels, resolved by query type, department and customer tier.
 *     Targets resolve by role, so the matrix survives staff changes. Negative sentiment or critical
 *     urgency shortens the level timers, so a calm breach and an angry one escalate differently.
 */

export interface EscalationLevel {
  level: number;
  after_minutes: number; // minutes after breach
  target_role: string;
  template?: string;
  channels?: ('in_app' | 'teams' | 'email')[];
}

export async function matrixFor(tx: Tx, q: { query_type_key: string | null; department_id: string | null; account_tier: string | null }) {
  return one<{ id: string; name: string; levels: EscalationLevel[] }>(
    tx,
    `SELECT id, name, levels FROM escalation_matrices
      WHERE active AND (query_type_key IS NULL OR query_type_key = $1) AND (department_id IS NULL OR department_id = $2)
        AND (account_tier IS NULL OR account_tier = $3)
      ORDER BY (query_type_key IS NOT NULL)::int + (department_id IS NOT NULL)::int + (account_tier IS NOT NULL)::int * 2 DESC LIMIT 1`,
    [q.query_type_key, q.department_id, q.account_tier ?? 'standard'],
  );
}

export async function evaluateSla(tx: Tx, now = new Date()) {
  const ctx = systemCtx('sla-monitor');
  const open = await many(
    tx,
    `SELECT q.*, c.account_tier, p.calendar_id, row_to_json(p) AS policy
       FROM queries q JOIN sla_policies p ON p.id = q.sla_policy_id LEFT JOIN companies c ON c.id = q.company_id
      WHERE q.resolved_at IS NULL AND q.clock_paused_at IS NULL
        AND q.state NOT IN ('closed','merged','filtered','resolved')`,
  );
  const result = { pre_breach: 0, breached: 0, escalated: 0 };
  for (const q of open) {
    const cal = await loadCalendar(tx, q.calendar_id);
    const policy = q.policy as SlaPolicy;
    const targets = targetsFor(policy, q.account_tier, q.urgency);
    const onFirst = !q.first_responded_at;
    const due: Date | null = onFirst ? q.first_response_due_at : q.resolution_due_at;
    if (!due) continue;
    const vars = await templateVars(tx, q);

    // Pre-breach warning
    if (!q.pre_breach_notified && !q.breached && new Date(due) > now) {
      const remaining = businessMinutesBetween(cal, now, new Date(due));
      const total = onFirst ? targets.firstResponse : targets.resolution;
      if (remaining <= total * (1 - policy.pre_breach_percent / 100)) {
        await tx.query('UPDATE queries SET pre_breach_notified = true WHERE id = $1', [q.id]);
        const msg = `${q.reference} will breach its ${onFirst ? 'first-response' : 'resolution'} target in ${remaining} business minutes`;
        if (q.assigned_to) await notify(tx, { template: 'pre_breach', to: { type: 'user', id: q.assigned_to }, vars: { ...vars, minutes: remaining, target: onFirst ? 'first response' : 'resolution' }, queryId: q.id, channels: ['in_app', 'teams'] });
        await raiseAlert(tx, { kind: 'pre_breach', message: msg, queryId: q.id, port: q.port_code, departmentId: q.department_id, targetRole: 'supervisor', dedupeKey: `pre_breach:${q.id}:${onFirst ? 'fr' : 'res'}` });
        await audit(tx, ctx, 'sla.pre_breach', 'query', q.id, undefined, { target: onFirst ? 'first_response' : 'resolution', remaining_business_minutes: remaining });
        result.pre_breach++;
      }
    }

    // Breach
    if (new Date(due) <= now && !q.breached) {
      await tx.query('UPDATE queries SET breached = true, breached_at = now() WHERE id = $1', [q.id]);
      q.breached = true;
      q.breached_at = now;
      await raiseAlert(tx, { kind: 'breach', severity: 'critical', message: `${q.reference} breached its ${onFirst ? 'first-response' : 'resolution'} target`, queryId: q.id, port: q.port_code, departmentId: q.department_id, targetRole: 'supervisor', dedupeKey: `breach:${q.id}` });
      if (q.assigned_to) await notify(tx, { template: 'breach', to: { type: 'user', id: q.assigned_to }, vars: { ...vars, target: onFirst ? 'first response' : 'resolution' }, queryId: q.id, channels: ['in_app', 'teams'] });
      await audit(tx, ctx, 'sla.breached', 'query', q.id, undefined, { target: onFirst ? 'first_response' : 'resolution', due });
      await emit(tx, 'query.breached', { id: q.id, reference: q.reference });
      result.breached++;
    }

    // Escalation through the matrix
    if (q.breached) {
      const matrix = await matrixFor(tx, q);
      if (!matrix) continue;
      const factor = (q.sentiment ?? 0) <= -0.3 || q.urgency === 'critical' ? 0.5 : 1;
      const since = (now.getTime() - new Date(q.breached_at).getTime()) / 60000;
      const due = matrix.levels
        .filter((l) => l.level > q.escalation_level && since >= l.after_minutes * factor)
        .sort((a, b) => b.level - a.level)[0];
      if (!due) continue;
      await tx.query('UPDATE queries SET escalation_level = $2, last_escalated_at = now() WHERE id = $1', [q.id, due.level]);
      const targets = await usersWithRole(tx, due.target_role, q.port_code, q.department_id);
      for (const u of targets) {
        await notify(tx, { template: due.template ?? 'escalation', to: { type: 'user', id: u.id }, vars: { ...vars, level: due.level, role: due.target_role, matrix: matrix.name }, queryId: q.id, channels: due.channels ?? ['in_app', 'teams'] });
      }
      await raiseAlert(tx, { kind: 'escalation', severity: due.level >= 2 ? 'critical' : 'warning', message: `${q.reference} escalated to level ${due.level} (${due.target_role}) under "${matrix.name}"`, queryId: q.id, port: q.port_code, departmentId: q.department_id, targetRole: due.target_role, dedupeKey: `escalation:${q.id}:${due.level}` });
      // If the escalation contact role on the customer side exists, the customer escalation contact is informed at the top level
      if (due.level >= 3) {
        const esc = await one(tx, `SELECT contact_id FROM company_contacts WHERE company_id = $1 AND role = 'escalation' AND status = 'active' LIMIT 1`, [q.company_id]);
        if (esc) await notify(tx, { template: 'customer_escalation_notice', to: { type: 'contact', id: esc.contact_id }, vars, queryId: q.id });
      }
      await audit(tx, ctx, 'query.escalated', 'query', q.id, { escalation_level: q.escalation_level }, { escalation_level: due.level, target_role: due.target_role, matrix: matrix.name, sentiment_factor: factor });
      await emit(tx, 'query.escalated', { id: q.id, reference: q.reference, level: due.level, target_role: due.target_role });
      result.escalated++;
    }
  }
  return result;
}

/** Resolved cases close automatically once the review window has passed. */
export async function autoClose(tx: Tx) {
  const days = Number((await one(tx, `SELECT value FROM settings WHERE key = 'workflow.review_window_days'`))?.value ?? 5);
  const due = await many<{ id: string }>(tx, `SELECT id FROM queries WHERE state = 'resolved' AND resolved_at < now() - ($1 || ' days')::interval LIMIT 200`, [String(days)]);
  for (const d of due) await transition(tx, systemCtx('auto-close'), d.id, 'closed');
  return due.length;
}

/** Overdue remediation tasks escalate through the same notification path as overdue queries (AM-02.2). */
export async function evaluateFindings(tx: Tx) {
  const overdue = await many(
    tx,
    `SELECT t.*, f.reference, f.title AS finding_title, f.port_code, f.department_id, f.owner_id AS finding_owner
       FROM remediation_tasks t JOIN findings f ON f.id = t.finding_id
      WHERE t.state IN ('open','in_progress') AND t.due_date < current_date AND NOT t.overdue_escalated`,
  );
  for (const t of overdue) {
    await tx.query('UPDATE remediation_tasks SET overdue_escalated = true WHERE id = $1', [t.id]);
    const vars = { finding: { reference: t.reference, title: t.finding_title }, task: t };
    if (t.owner_id) await notify(tx, { template: 'remediation_overdue', to: { type: 'user', id: t.owner_id }, vars, channels: ['in_app', 'email'] });
    if (t.finding_owner && t.finding_owner !== t.owner_id) await notify(tx, { template: 'remediation_overdue', to: { type: 'user', id: t.finding_owner }, vars, channels: ['in_app'] });
    for (const s of await usersWithRole(tx, 'supervisor', t.port_code, t.department_id)) {
      await notify(tx, { template: 'remediation_overdue', to: { type: 'user', id: s.id }, vars, channels: ['in_app', 'teams'] });
    }
    await raiseAlert(tx, { kind: 'finding_overdue', message: `${t.reference}: remediation task "${t.title}" is overdue`, findingId: t.finding_id, port: t.port_code, departmentId: t.department_id, targetRole: 'supervisor', dedupeKey: `task_overdue:${t.id}` });
    await audit(tx, systemCtx('findings-monitor'), 'finding.task_overdue', 'finding', t.finding_id, undefined, { task_id: t.id });
  }
  return overdue.length;
}

/** Threshold alerts push to management when backlog or breach rate crosses a configured level (RA-01.4). */
export async function evaluateThresholds(tx: Tx) {
  const backlogMax = Number((await one(tx, `SELECT value FROM settings WHERE key = 'threshold.backlog_max'`))?.value ?? 150);
  const breachMax = Number((await one(tx, `SELECT value FROM settings WHERE key = 'threshold.breach_rate_max_percent'`))?.value ?? 10);
  const m = await one(
    tx,
    `SELECT count(*) FILTER (WHERE state NOT IN ('resolved','closed','merged','filtered'))::int AS backlog,
            round(100.0 * count(*) FILTER (WHERE breached AND created_at > now() - interval '7 days') / nullif(count(*) FILTER (WHERE created_at > now() - interval '7 days' AND state <> 'filtered'), 0), 1) AS breach_rate
       FROM queries`,
  );
  const hour = new Date().toISOString().slice(0, 13);
  const fired: string[] = [];
  const fire = async (key: string, message: string) => {
    const id = await raiseAlert(tx, { kind: 'threshold', severity: 'critical', message, targetRole: 'executive', dedupeKey: `threshold:${key}:${hour}` });
    if (!id) return;
    fired.push(key);
    for (const role of ['executive', 'department_head']) {
      for (const u of await usersWithRole(tx, role)) await notify(tx, { template: 'threshold_alert', to: { type: 'user', id: u.id }, vars: { message }, channels: ['in_app', 'teams', 'email'] });
    }
  };
  if (m.backlog > backlogMax) await fire('backlog', `Open backlog is ${m.backlog}, above the threshold of ${backlogMax}`);
  if (m.breach_rate != null && Number(m.breach_rate) > breachMax) await fire('breach_rate', `7-day breach rate is ${m.breach_rate}%, above the threshold of ${breachMax}%`);
  return { ...m, fired };
}
