import { many, one, type Tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { type Ctx } from '../lib/context.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { emit } from './events.js';
import { notify } from './notifications.js';
import { pauseClock, resumeClock } from './sla.js';

/**
 * Configurable, versioned state machine per query type (WM-01, WM-01.1). Definitions are data.
 * An in-flight case completes on the version it started under because the version id is held
 * on the case itself.
 */

export type StateCategory = 'intake' | 'open' | 'paused' | 'resolved' | 'closed' | 'filtered' | 'merged';
export interface WfState {
  key: string;
  label: string;
  category: StateCategory;
  clock: 'running' | 'paused' | 'stopped';
  customer_label?: string;
}
export type Guard = 'has_assignee' | 'has_resolution_note' | 'classification_confirmed' | 'has_customer' | 'has_reason' | 'within_review_window';
export interface WfTransition {
  from: string; // state key, or '*' for any open state
  to: string;
  label: string;
  guards?: Guard[];
  /** notify_customer:<template> | notify_assignee:<template> | request_satisfaction | record_first_response | increment_reopen | run_assignment */
  actions?: string[];
  roles?: string[];           // empty = any staff with query.update
  customer_allowed?: boolean; // customer may trigger (e.g. reply resumes from pending_customer)
  system_only?: boolean;      // only engines may trigger (e.g. triage, auto-close)
}
export interface WfDefinition {
  initial: string;
  states: WfState[];
  transitions: WfTransition[];
}

export const DEFAULT_WORKFLOW: WfDefinition = {
  initial: 'received',
  states: [
    { key: 'received', label: 'Received', category: 'intake', clock: 'running', customer_label: 'Received' },
    { key: 'filtered', label: 'Filtered', category: 'filtered', clock: 'stopped', customer_label: 'Received' },
    { key: 'triaged', label: 'Triaged', category: 'open', clock: 'running', customer_label: 'In queue' },
    { key: 'merged', label: 'Merged', category: 'merged', clock: 'stopped', customer_label: 'Merged into another case' },
    { key: 'assigned', label: 'Assigned', category: 'open', clock: 'running', customer_label: 'Assigned to an agent' },
    { key: 'in_progress', label: 'In progress', category: 'open', clock: 'running', customer_label: 'In progress' },
    { key: 'pending_customer', label: 'Pending customer', category: 'paused', clock: 'paused', customer_label: 'Waiting for your reply' },
    { key: 'pending_third_party', label: 'Pending third party', category: 'paused', clock: 'paused', customer_label: 'Waiting on another party' },
    { key: 'resolved', label: 'Resolved', category: 'resolved', clock: 'stopped', customer_label: 'Resolved' },
    { key: 'reopened', label: 'Reopened', category: 'open', clock: 'running', customer_label: 'Reopened' },
    { key: 'closed', label: 'Closed', category: 'closed', clock: 'stopped', customer_label: 'Closed' },
  ],
  transitions: [
    { from: 'received', to: 'triaged', label: 'Triage', system_only: true },
    { from: 'received', to: 'filtered', label: 'Filter as irrelevant', system_only: true },
    { from: 'filtered', to: 'received', label: 'Release from filter' },
    { from: 'received', to: 'merged', label: 'Merge into original' },
    { from: 'triaged', to: 'merged', label: 'Merge into original' },
    { from: 'assigned', to: 'merged', label: 'Merge into original' },
    { from: 'in_progress', to: 'merged', label: 'Merge into original' },
    { from: 'triaged', to: 'assigned', label: 'Assign', guards: ['has_assignee'], actions: ['notify_assignee:query_assigned', 'notify_customer:query_assigned_customer'] },
    { from: 'reopened', to: 'assigned', label: 'Assign', guards: ['has_assignee'], actions: ['notify_assignee:query_assigned'] },
    { from: 'assigned', to: 'in_progress', label: 'Start work', guards: ['has_assignee'] },
    { from: 'assigned', to: 'pending_customer', label: 'Await customer', guards: ['has_assignee'], actions: ['notify_customer:awaiting_customer'] },
    { from: 'in_progress', to: 'pending_customer', label: 'Await customer', actions: ['notify_customer:awaiting_customer'] },
    { from: 'pending_customer', to: 'in_progress', label: 'Customer replied', customer_allowed: true },
    { from: 'in_progress', to: 'pending_third_party', label: 'Await third party', guards: ['has_reason'] },
    { from: 'pending_third_party', to: 'in_progress', label: 'Third party replied' },
    { from: 'in_progress', to: 'resolved', label: 'Resolve', guards: ['has_resolution_note', 'has_assignee'], actions: ['record_first_response', 'notify_customer:query_resolved', 'request_satisfaction'] },
    { from: 'assigned', to: 'resolved', label: 'Resolve', guards: ['has_resolution_note', 'has_assignee'], actions: ['record_first_response', 'notify_customer:query_resolved', 'request_satisfaction'] },
    { from: 'resolved', to: 'closed', label: 'Close after review window', system_only: true },
    { from: 'resolved', to: 'reopened', label: 'Dispute outcome', customer_allowed: true, guards: ['within_review_window'], actions: ['increment_reopen'] },
    { from: 'closed', to: 'reopened', label: 'Reopen — outcome disputed', guards: ['has_reason'], actions: ['increment_reopen'] },
    { from: 'reopened', to: 'in_progress', label: 'Resume work', guards: ['has_assignee'] },
  ],
};

export function validateDefinition(def: WfDefinition) {
  const errors: string[] = [];
  const keys = new Set(def.states.map((s) => s.key));
  if (!keys.has(def.initial)) errors.push(`initial state "${def.initial}" is not defined`);
  for (const req of ['filtered', 'triaged', 'merged', 'assigned', 'resolved', 'closed']) {
    if (!keys.has(req)) errors.push(`state "${req}" is required by the intake, assignment and closure engines`);
  }
  for (const t of def.transitions) {
    if (t.from !== '*' && !keys.has(t.from)) errors.push(`transition "${t.label}" has unknown from-state "${t.from}"`);
    if (!keys.has(t.to)) errors.push(`transition "${t.label}" has unknown to-state "${t.to}"`);
  }
  // every non-terminal state must have a way out
  for (const s of def.states) {
    if (['closed', 'merged'].includes(s.category)) continue;
    if (!def.transitions.some((t) => t.from === s.key || (t.from === '*' && ['open', 'paused'].includes(s.category)))) {
      errors.push(`state "${s.key}" has no outgoing transition`);
    }
  }
  return errors;
}

export async function getDefinition(tx: Tx, id: string): Promise<WfDefinition & { id: string; version: number; workflow_key: string }> {
  const row = await one(tx, 'SELECT id, version, workflow_key, definition FROM workflow_definitions WHERE id = $1', [id]);
  if (!row) throw notFound('workflow definition not found');
  return { ...row.definition, id: row.id, version: row.version, workflow_key: row.workflow_key };
}

export async function publishedDefinitionId(tx: Tx, workflowKey: string): Promise<string> {
  const row =
    (await one<{ id: string }>(tx, `SELECT id FROM workflow_definitions WHERE workflow_key = $1 AND status = 'published' ORDER BY version DESC LIMIT 1`, [workflowKey])) ??
    (await one<{ id: string }>(tx, `SELECT id FROM workflow_definitions WHERE workflow_key = 'default' AND status = 'published' ORDER BY version DESC LIMIT 1`));
  if (!row) throw new Error('no published workflow');
  return row.id;
}

export const stateOf = (def: WfDefinition, key: string) => def.states.find((s) => s.key === key);

export function availableTransitions(def: WfDefinition, current: string, opts: { customer?: boolean; system?: boolean; role?: string } = {}) {
  const st = stateOf(def, current);
  return def.transitions.filter((t) => {
    const fromOk = t.from === current || (t.from === '*' && st && ['open', 'paused'].includes(st.category));
    if (!fromOk) return false;
    if (t.system_only && !opts.system) return false;
    if (opts.customer) return Boolean(t.customer_allowed);
    if (t.roles?.length && opts.role && !t.roles.includes(opts.role)) return false;
    return true;
  });
}

export interface TransitionOpts {
  note?: string;
  reason?: string;
  resolutionNote?: string;
}

/**
 * Move a case to a new state, enforcing the definition the case started under. Guards are
 * checked, the service clock is paused or resumed according to the target state, and the
 * transition's automated actions run in the same transaction.
 */
export async function transition(tx: Tx, ctx: Ctx, queryId: string, to: string, opts: TransitionOpts = {}) {
  const q = await one(tx, 'SELECT * FROM queries WHERE id = $1 FOR UPDATE', [queryId]);
  if (!q) throw notFound('query not found');
  const def = await getDefinition(tx, q.workflow_definition_id);
  const isSystem = ctx.actorType === 'system' || ctx.actorType === 'assist';
  const candidates = availableTransitions(def, q.state, {
    customer: ctx.actorType === 'contact', system: isSystem, role: ctx.staff?.roleKey,
  });
  const t = candidates.find((c) => c.to === to);
  if (!t) {
    if (ctx.actorType === 'contact') throw forbidden(`You cannot move this case to ${to}`);
    throw conflict(`Transition ${q.state} → ${to} is not permitted by workflow ${def.workflow_key} v${def.version}`);
  }

  const resolutionNote = opts.resolutionNote ?? q.resolution_note;
  for (const g of t.guards ?? []) {
    if (g === 'has_assignee' && !q.assigned_to) throw badRequest('The case must be assigned first');
    if (g === 'has_resolution_note' && !resolutionNote) throw badRequest('A resolution note is required to resolve');
    if (g === 'classification_confirmed' && !q.classification_confirmed) throw badRequest('Confirm the classification first');
    if (g === 'has_customer' && !q.contact_id && !q.company_id) throw badRequest('Link a customer first');
    if (g === 'has_reason' && !opts.reason) throw badRequest('A reason is required');
    if (g === 'within_review_window') {
      const days = Number((await one(tx, `SELECT value FROM settings WHERE key = 'workflow.review_window_days'`))?.value ?? 5);
      if (q.resolved_at && Date.now() - new Date(q.resolved_at).getTime() > days * 86_400_000) {
        throw badRequest('The review window for disputing this outcome has passed');
      }
    }
  }

  const fromState = stateOf(def, q.state)!;
  const toState = stateOf(def, to)!;
  const now = new Date();

  // service clock follows the state's clock behaviour
  if (fromState.clock === 'paused' && toState.clock !== 'paused') await resumeClock(tx, queryId, now);
  if (toState.clock === 'paused' && fromState.clock !== 'paused') await pauseClock(tx, queryId, now);

  const sets: string[] = ['state = $2', 'updated_at = now()'];
  const params: unknown[] = [queryId, to];
  if (toState.category === 'resolved') {
    sets.push('resolved_at = now()');
    params.push(resolutionNote);
    sets.push(`resolution_note = $${params.length}`);
  }
  if (toState.category === 'closed') sets.push('closed_at = now()');
  if (to === 'reopened') sets.push('resolved_at = NULL, closed_at = NULL');
  await tx.query(`UPDATE queries SET ${sets.join(', ')} WHERE id = $1`, params);

  const refreshed = await one(tx, 'SELECT * FROM queries WHERE id = $1', [queryId]);
  await runActions(tx, ctx, refreshed, t.actions ?? []);

  await tx.query(
    `INSERT INTO interactions (query_id, company_id, contact_id, channel, direction, visibility, body, actor_type, actor_id, actor_name)
     VALUES ($1,$2,$3,'system','internal','public',$4,$5,$6,$7)`,
    [queryId, q.company_id, q.contact_id, `Status changed: ${fromState.customer_label ?? fromState.label} → ${toState.customer_label ?? toState.label}${opts.reason ? ` (${opts.reason})` : ''}`,
     ctx.actorType === 'contact' ? 'contact' : ctx.actorType === 'user' ? 'user' : ctx.actorType === 'assist' ? 'assist' : 'system', ctx.actorId, ctx.actorName],
  );
  await audit(tx, ctx, 'query.transition', 'query', queryId, { state: q.state }, { state: to, reason: opts.reason ?? null, workflow_version: def.version });
  await emit(tx, toState.category === 'resolved' ? 'query.resolved' : toState.category === 'closed' ? 'query.closed' : 'query.state_changed',
    { id: queryId, reference: q.reference, from: q.state, to });
  return refreshed;
}

async function runActions(tx: Tx, ctx: Ctx, q: any, actions: string[]) {
  const vars = await templateVars(tx, q);
  for (const a of actions) {
    const [name, arg] = a.split(':');
    if (name === 'notify_customer' && q.contact_id) {
      await notify(tx, { template: arg, to: { type: 'contact', id: q.contact_id }, vars, queryId: q.id });
    } else if (name === 'notify_assignee' && q.assigned_to) {
      await notify(tx, { template: arg, to: { type: 'user', id: q.assigned_to }, vars, queryId: q.id, channels: ['in_app', 'email'] });
    } else if (name === 'record_first_response') {
      await tx.query('UPDATE queries SET first_responded_at = coalesce(first_responded_at, now()) WHERE id = $1', [q.id]);
    } else if (name === 'increment_reopen') {
      await tx.query('UPDATE queries SET reopen_count = reopen_count + 1 WHERE id = $1', [q.id]);
    } else if (name === 'request_satisfaction' && q.contact_id) {
      const { requestSatisfaction } = await import('./satisfaction.js');
      await requestSatisfaction(tx, q, vars);
    } else if (name === 'run_assignment') {
      const { assign } = await import('./assignment.js');
      await assign(tx, ctx, q.id);
    }
  }
}

export async function templateVars(tx: Tx, q: any) {
  const extra = await one(
    tx,
    `SELECT c.name AS contact_name, c.email AS contact_email, co.name AS company_name, u.name AS agent_name,
            qt.name AS query_type_name
       FROM queries q
       LEFT JOIN contacts c ON c.id = q.contact_id
       LEFT JOIN companies co ON co.id = q.company_id
       LEFT JOIN users u ON u.id = q.assigned_to
       LEFT JOIN query_types qt ON qt.key = q.query_type_key
      WHERE q.id = $1`,
    [q.id],
  );
  return {
    reference: q.reference,
    query: { ...q, type: extra?.query_type_name, due: q.first_response_due_at ? new Date(q.first_response_due_at).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '' },
    contact: { name: extra?.contact_name ?? 'Customer', email: extra?.contact_email },
    company: { name: extra?.company_name ?? '' },
    agent: { name: extra?.agent_name ?? 'our customer care team' },
    portal_url: process.env.PUBLIC_URL ?? 'http://localhost:5173',
  };
}

/**
 * WM-01.1 — preview a draft definition against historical cases before it is published: every
 * recorded transition of recent cases is replayed against the draft and incompatibilities listed.
 */
export async function previewAgainstHistory(tx: Tx, def: WfDefinition, workflowKey: string, limit = 200) {
  const rows = await many<{ entity_id: string; before: any; after: any }>(
    tx,
    `SELECT e.entity_id, e.before, e.after FROM event_log e
      WHERE e.action = 'query.transition'
        AND e.entity_id IN (
          SELECT q.id::text FROM queries q JOIN workflow_definitions w ON w.id = q.workflow_definition_id
           WHERE w.workflow_key = $1 ORDER BY q.created_at DESC LIMIT $2)
      ORDER BY e.id`,
    [workflowKey, limit],
  );
  const cases = new Set(rows.map((r) => r.entity_id));
  const incompatible: Record<string, string[]> = {};
  for (const r of rows) {
    const from = r.before?.state, to = r.after?.state;
    const st = stateOf(def, from);
    const ok = def.transitions.some((t) => t.to === to && (t.from === from || (t.from === '*' && st && ['open', 'paused'].includes(st.category))));
    if (!ok) (incompatible[`${from} → ${to}`] ??= []).push(r.entity_id);
  }
  return {
    cases_examined: cases.size,
    transitions_examined: rows.length,
    incompatible_transitions: Object.entries(incompatible).map(([transition, ids]) => ({ transition, occurrences: ids.length, sample_cases: [...new Set(ids)].slice(0, 5) })),
    validation_errors: validateDefinition(def),
  };
}
