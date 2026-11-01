import { config } from '../config.js';
import pg from 'pg';
import { many, pool, withAnalytics, withSystem } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { systemCtx, type Ctx } from '../lib/context.js';
import { drainQueues } from '../services/assignment.js';
import { autoClose, evaluateFindings, evaluateSla, evaluateThresholds } from '../services/escalation.js';
import { notify } from '../services/notifications.js';
import { exportTable, runReport } from '../services/reports.js';
import { deliverWebhooks, dispatchNotifications } from '../integrations/dispatcher.js';
import { pollMailbox, syncCalendars } from './integrationJobs.js';

/**
 * Background engine. Each job runs in its own transaction so a failure in one never blocks the
 * others. In a multi-instance deployment a Postgres advisory lock elects one runner per tick.
 */

type Job = { name: string; everyMs: number; run: () => Promise<unknown>; last?: number };

/** Scheduled report distribution: saved reports emailed to their recipients on their cadence. */
export async function runScheduledReports() {
  const due = await withSystem((tx) => many(tx,
    `SELECT r.*, u.id AS owner_user_id FROM reports r LEFT JOIN users u ON u.id = r.owner_id
      WHERE r.schedule IS NOT NULL AND (r.last_run_at IS NULL OR r.last_run_at < now() - CASE r.schedule WHEN 'daily' THEN interval '1 day' WHEN 'weekly' THEN interval '7 days' ELSE interval '1 month' END)`));
  for (const r of due) {
    // the report runs under its owner's scope, exactly as they would see it
    const { loadStaff, staffCtx } = await import('../services/auth.js');
    const owner = r.owner_user_id ? await withSystem((tx) => loadStaff(tx, r.owner_user_id)) : null;
    if (!owner) continue;
    const ctx: Ctx = staffCtx(owner);
    const table = await withAnalytics(ctx.scope, (tx) => runReport(tx, ctx, r.definition));
    const out = exportTable(table, r.format, r.name);
    const summary = `${r.name}: ${table.rows.length} row(s). Format: ${out.ext.toUpperCase()}.\n\n${table.columns.map((c) => c.label).join(' | ')}\n${table.rows.slice(0, 20).map((row) => table.columns.map((c) => row[c.key] ?? '').join(' | ')).join('\n')}`;
    await withSystem(async (tx) => {
      for (const address of r.recipients) await notify(tx, { template: 'scheduled_report', to: { type: 'address', address }, vars: { report: r, summary }, channels: ['email'] });
      await tx.query('UPDATE reports SET last_run_at = now() WHERE id = $1', [r.id]);
      await audit(tx, systemCtx('report-scheduler'), 'report.distributed', 'report', r.id, undefined, { recipients: r.recipients.length, rows: table.rows.length });
    });
  }
  return due.length;
}

/** Retention and defensible disposal, with an exportable record of what was disposed of and when. */
export async function applyRetention() {
  return withSystem(async (tx) => {
    const policies = await many<{ entity: string; keep_days: number }>(tx, 'SELECT * FROM retention_policies');
    const out: Record<string, number> = {};
    const targets: Record<string, string> = {
      assist_sessions: `DELETE FROM assist_sessions WHERE updated_at < now() - ($1 || ' days')::interval AND created_query_id IS NULL AND handed_over_query_id IS NULL RETURNING id::text`,
      notifications: `DELETE FROM notifications WHERE created_at < now() - ($1 || ' days')::interval AND status IN ('sent','read','failed') RETURNING id::text`,
      integration_log: `DELETE FROM integration_log WHERE created_at < now() - ($1 || ' days')::interval AND status <> 'dead_letter' RETURNING id::text`,
      webhook_deliveries: `DELETE FROM webhook_deliveries WHERE created_at < now() - ($1 || ' days')::interval AND status = 'delivered' RETURNING id::text`,
    };
    for (const p of policies) {
      const sql = targets[p.entity];
      if (!sql) continue;
      const r = await tx.query(sql, [String(p.keep_days)]);
      if (r.rowCount) {
        await tx.query('INSERT INTO disposal_log (entity, record_ids, count) VALUES ($1,$2,$3)', [p.entity, r.rows.map((x) => x.id), r.rowCount]);
        await audit(tx, systemCtx('retention'), 'retention.disposed', p.entity, null, undefined, { count: r.rowCount, keep_days: p.keep_days });
      }
      out[p.entity] = r.rowCount ?? 0;
    }
    return out;
  });
}

const jobs: Job[] = [
  { name: 'audit-seal', everyMs: 60_000, run: () => withSystem((tx) => tx.query('SELECT seal_event_log()')) },
  { name: 'sla', everyMs: 60_000, run: () => withSystem((tx) => evaluateSla(tx)) },
  { name: 'assignment', everyMs: 60_000, run: () => withSystem((tx) => drainQueues(tx)) },
  { name: 'notifications', everyMs: 15_000, run: () => dispatchNotifications() },
  { name: 'webhooks', everyMs: 15_000, run: () => deliverWebhooks() },
  { name: 'mailbox', everyMs: 60_000, run: () => pollMailbox() },
  { name: 'calendars', everyMs: 15 * 60_000, run: () => syncCalendars() },
  { name: 'auto-close', everyMs: 15 * 60_000, run: () => withSystem((tx) => autoClose(tx)) },
  { name: 'findings', everyMs: 30 * 60_000, run: () => withSystem((tx) => evaluateFindings(tx)) },
  { name: 'thresholds', everyMs: 5 * 60_000, run: () => withSystem((tx) => evaluateThresholds(tx)) },
  { name: 'reports', everyMs: 15 * 60_000, run: () => runScheduledReports() },
  { name: 'retention', everyMs: 24 * 3600_000, run: () => applyRetention() },
];

let running = false;
let timer: NodeJS.Timeout | null = null;
let leaderClient: pg.PoolClient | null = null;

/** Hold a session-level advisory lock on a dedicated connection: one scheduler leader across instances. */
async function isLeader() {
  if (leaderClient) return true;
  const c = await pool.connect();
  const ok = (await c.query('SELECT pg_try_advisory_lock(777001) AS ok')).rows[0].ok;
  if (ok) { leaderClient = c; c.on('error', () => { leaderClient = null; }); } else c.release();
  return ok;
}

export async function tick(now = Date.now()) {
  if (running) return;
  running = true;
  try {
    if (!(await isLeader())) return;
    for (const j of jobs) {
      if (j.last && now - j.last < j.everyMs) continue;
      j.last = now;
      try {
        await j.run();
      } catch (e) {
        console.error(`[scheduler] ${j.name} failed:`, (e as Error).message);
      }
    }
  } finally {
    running = false;
  }
}

export function startScheduler() {
  if (!config.runScheduler || timer) return;
  timer = setInterval(() => void tick(), config.schedulerIntervalMs);
  setTimeout(() => void tick(), 2_000);
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
  const c = leaderClient;
  leaderClient = null;
  if (c) c.query('SELECT pg_advisory_unlock(777001)').catch(() => undefined).finally(() => c.release());
}
