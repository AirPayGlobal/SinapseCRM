import { many, one, type Tx } from '../db/pool.js';
import { addBusinessMinutes, businessMinutesBetween, type ServiceCalendar } from '../lib/calendar.js';

export interface SlaPolicy {
  id: string;
  name: string;
  calendar_id: string;
  first_response_minutes: number;
  resolution_minutes: number;
  tier_overrides: Record<string, { first_response_minutes?: number; resolution_minutes?: number }>;
  urgency_multipliers: Record<string, number>;
  pre_breach_percent: number;
}

const calCache = new Map<string, { at: number; cal: ServiceCalendar }>();

export function invalidateCalendarCache() {
  calCache.clear();
}

export async function loadCalendar(tx: Tx, calendarId: string): Promise<ServiceCalendar> {
  const hit = calCache.get(calendarId);
  if (hit && Date.now() - hit.at < 60_000) return hit.cal;
  const c = await one<{ utc_offset_minutes: number; business_hours: Record<string, [string, string][]> }>(
    tx, 'SELECT utc_offset_minutes, business_hours FROM calendars WHERE id = $1', [calendarId],
  );
  if (!c) throw new Error(`calendar ${calendarId} not found`);
  const hol = await many<{ day: string }>(tx, `SELECT to_char(day, 'YYYY-MM-DD') AS day FROM calendar_holidays WHERE calendar_id = $1`, [calendarId]);
  const cal: ServiceCalendar = { utcOffsetMinutes: c.utc_offset_minutes, businessHours: c.business_hours, holidays: new Set(hol.map((h) => h.day)) };
  calCache.set(calendarId, { at: Date.now(), cal });
  return cal;
}

export async function defaultCalendar(tx: Tx): Promise<ServiceCalendar> {
  const c = await one<{ id: string }>(tx, `SELECT id FROM calendars ORDER BY name = 'Namport standard' DESC, name LIMIT 1`);
  if (!c) throw new Error('no service calendar configured');
  return loadCalendar(tx, c.id);
}

/** Targets in business minutes after tier override and urgency multiplier. */
export function targetsFor(policy: SlaPolicy, tier: string | null | undefined, urgency: string) {
  const o = (tier && policy.tier_overrides?.[tier]) || {};
  const mult = policy.urgency_multipliers?.[urgency] ?? 1;
  return {
    firstResponse: Math.max(1, Math.round((o.first_response_minutes ?? policy.first_response_minutes) * mult)),
    resolution: Math.max(1, Math.round((o.resolution_minutes ?? policy.resolution_minutes) * mult)),
  };
}

export async function policyFor(tx: Tx, workflowDefinitionId: string): Promise<SlaPolicy | null> {
  return one<SlaPolicy>(
    tx,
    `SELECT p.* FROM sla_policies p JOIN workflow_definitions w ON w.sla_policy_id = p.id WHERE w.id = $1`,
    [workflowDefinitionId],
  ).then(async (p) => p ?? one<SlaPolicy>(tx, `SELECT * FROM sla_policies ORDER BY name = 'Standard' DESC LIMIT 1`));
}

/** Start the service clock: due dates from creation in business minutes. */
export async function startClock(tx: Tx, queryId: string) {
  const q = await one(tx, `SELECT q.*, c.account_tier FROM queries q LEFT JOIN companies c ON c.id = q.company_id WHERE q.id = $1`, [queryId]);
  if (!q) return;
  const policy = await policyFor(tx, q.workflow_definition_id);
  if (!policy) return;
  const cal = await loadCalendar(tx, policy.calendar_id);
  const t = targetsFor(policy, q.account_tier, q.urgency);
  const start = new Date(q.created_at);
  await tx.query(
    `UPDATE queries SET sla_policy_id = $2, first_response_due_at = $3, resolution_due_at = $4 WHERE id = $1`,
    [queryId, policy.id, addBusinessMinutes(cal, start, t.firstResponse), addBusinessMinutes(cal, start, t.resolution)],
  );
}

/** Recompute due dates (e.g. after urgency or tier changes), preserving accumulated pause time. */
export async function recomputeClock(tx: Tx, queryId: string) {
  const q = await one(tx, `SELECT q.*, c.account_tier FROM queries q LEFT JOIN companies c ON c.id = q.company_id WHERE q.id = $1`, [queryId]);
  if (!q?.sla_policy_id) return startClock(tx, queryId);
  const policy = await one<SlaPolicy>(tx, 'SELECT * FROM sla_policies WHERE id = $1', [q.sla_policy_id]);
  if (!policy) return;
  const cal = await loadCalendar(tx, policy.calendar_id);
  const t = targetsFor(policy, q.account_tier, q.urgency);
  const start = new Date(q.created_at);
  await tx.query(
    `UPDATE queries SET first_response_due_at = $2, resolution_due_at = $3, pre_breach_notified = false WHERE id = $1`,
    [queryId, addBusinessMinutes(cal, start, t.firstResponse + q.paused_business_minutes),
     addBusinessMinutes(cal, start, t.resolution + q.paused_business_minutes)],
  );
}

export async function pauseClock(tx: Tx, queryId: string, at = new Date()) {
  await tx.query(`UPDATE queries SET clock_paused_at = coalesce(clock_paused_at, $2) WHERE id = $1`, [queryId, at]);
}

/**
 * Resume a paused clock. Business minutes spent waiting on the customer or a third party are
 * added to the due dates and accumulated separately, so service figures measure Namport.
 */
export async function resumeClock(tx: Tx, queryId: string, at = new Date()) {
  const q = await one(tx, 'SELECT clock_paused_at, sla_policy_id FROM queries WHERE id = $1', [queryId]);
  if (!q?.clock_paused_at || !q.sla_policy_id) {
    await tx.query('UPDATE queries SET clock_paused_at = NULL WHERE id = $1', [queryId]);
    return 0;
  }
  const policy = await one<SlaPolicy>(tx, 'SELECT * FROM sla_policies WHERE id = $1', [q.sla_policy_id]);
  const cal = await loadCalendar(tx, policy!.calendar_id);
  const paused = businessMinutesBetween(cal, new Date(q.clock_paused_at), at);
  const row = await one(tx, 'SELECT first_response_due_at, resolution_due_at, first_responded_at FROM queries WHERE id = $1', [queryId]);
  const shift = (d: Date | null) => (d ? addBusinessMinutes(cal, new Date(d), paused) : null);
  // addBusinessMinutes from a due date outside business hours first snaps to the next business minute
  await tx.query(
    `UPDATE queries SET clock_paused_at = NULL, paused_business_minutes = paused_business_minutes + $2,
            first_response_due_at = CASE WHEN first_responded_at IS NULL THEN $3 ELSE first_response_due_at END,
            resolution_due_at = $4
      WHERE id = $1`,
    [queryId, paused, paused > 0 ? shift(row!.first_response_due_at) : row!.first_response_due_at,
     paused > 0 ? shift(row!.resolution_due_at) : row!.resolution_due_at],
  );
  return paused;
}

/** Live SLA state for display: running/paused/met/breached with business minutes remaining. */
export function slaState(q: {
  state_clock?: string; clock_paused_at: Date | null; resolution_due_at: Date | null; first_response_due_at: Date | null;
  first_responded_at: Date | null; resolved_at: Date | null; breached: boolean;
}, now = new Date()) {
  if (q.resolved_at) return { status: q.breached ? 'breached' : 'met', minutesRemaining: null as number | null };
  if (q.clock_paused_at) return { status: 'paused', minutesRemaining: null };
  const due = !q.first_responded_at && q.first_response_due_at ? q.first_response_due_at : q.resolution_due_at;
  if (!due) return { status: 'none', minutesRemaining: null };
  const mins = Math.round((new Date(due).getTime() - now.getTime()) / 60000);
  return { status: mins < 0 ? 'breached' : 'running', minutesRemaining: mins, target: !q.first_responded_at ? 'first_response' : 'resolution' };
}
