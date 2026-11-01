import { Router } from 'express';
import { many, one, withAnalytics } from '../db/pool.js';
import { badRequest, notFound } from '../lib/errors.js';
import { ah, db, qp, staff } from '../lib/http.js';
import { deflection } from '../services/assist.js';
import { corridorAnalytics } from '../services/port.js';
import { dashboard, DIMENSIONS, exportTable, METRICS, performance, reassignmentPatterns, runReport } from '../services/reports.js';

export const reportsRouter = Router();
const analytics = <T>(req: any, fn: (tx: any) => Promise<T>) => withAnalytics(req.ctx.scope, fn);

reportsRouter.get('/dashboard', staff('report.read'), ah(async (req, res) => res.json(await analytics(req, (tx) => dashboard(tx, qp(req))))));
reportsRouter.get('/performance', staff('report.read'), ah(async (req, res) => res.json(await analytics(req, (tx) => performance(tx, qp(req))))));
reportsRouter.get('/reassignments', staff('report.read'), ah(async (req, res) => res.json(await analytics(req, (tx) => reassignmentPatterns(tx, Number(qp(req).days ?? 30))))));
reportsRouter.get('/corridors', staff('report.read', 'port.read'), ah(async (req, res) => res.json(await analytics(req, (tx) => corridorAnalytics(tx, Number(qp(req).days ?? 90))))));
reportsRouter.get('/deflection', staff('report.read'), ah(async (req, res) => {
  res.json(await analytics(req, async (tx) => ({
    summary: await deflection(tx, Number(qp(req).days ?? 30)),
    by_week: await many(tx, `SELECT date_trunc('week', created_at)::date AS week, count(*)::int AS sessions,
                                    count(*) FILTER (WHERE outcome IN ('answered','acted'))::int AS deflected,
                                    count(*) FILTER (WHERE outcome = 'handed_over')::int AS handed_over
                               FROM assist_sessions WHERE created_at > now() - interval '90 days' GROUP BY 1 ORDER BY 1`),
    top_articles: await many(tx, `SELECT id, title, answered_count, helpful_count FROM knowledge_articles WHERE state = 'published' ORDER BY answered_count DESC LIMIT 10`),
  })));
}));
/** Adoption measured weekly through hypercare: registrations, portal-logged share, Assist deflection, self-service updates. */
reportsRouter.get('/adoption', staff('report.read'), ah(async (req, res) => {
  res.json(await analytics(req, (tx) => many(tx,
    `WITH weeks AS (SELECT generate_series(date_trunc('week', now()) - interval '11 weeks', date_trunc('week', now()), interval '1 week')::date AS week)
     SELECT w.week,
            (SELECT count(*)::int FROM companies c WHERE c.created_by_channel = 'portal' AND date_trunc('week', c.created_at)::date = w.week) AS portal_registrations,
            (SELECT count(*)::int FROM queries q WHERE date_trunc('week', q.created_at)::date = w.week AND q.state <> 'filtered') AS queries,
            (SELECT round(100.0 * count(*) FILTER (WHERE q.channel IN ('portal','widget','assist')) / nullif(count(*), 0), 1) FROM queries q WHERE date_trunc('week', q.created_at)::date = w.week AND q.state <> 'filtered') AS self_service_share,
            (SELECT round(100.0 * count(*) FILTER (WHERE outcome IN ('answered','acted')) / nullif(count(*), 0), 1) FROM assist_sessions s WHERE date_trunc('week', s.created_at)::date = w.week) AS assist_deflection,
            (SELECT count(*)::int FROM event_log e WHERE e.actor_type = 'contact' AND e.action IN ('contact.updated','company.updated','company_contact.linked','company_contact.removed') AND date_trunc('week', e.occurred_at)::date = w.week) AS self_service_updates
       FROM weeks w ORDER BY w.week`)));
}));
reportsRouter.get('/builder/schema', staff('report.read'), (_req, res) => {
  res.json({ dimensions: Object.entries(DIMENSIONS).map(([key, d]) => ({ key, label: d.label })), metrics: Object.entries(METRICS).map(([key, m]) => ({ key, label: m.label })) });
});
reportsRouter.post('/builder/run', staff('report.read'), ah(async (req, res) => res.json(await analytics(req, (tx) => runReport(tx, req.ctx, req.body ?? {})))));
reportsRouter.post('/builder/export', staff('report.read'), ah(async (req, res) => {
  const { definition, format = 'csv', title = 'Report' } = req.body ?? {};
  if (!['csv', 'xlsx', 'pdf'].includes(format)) throw badRequest('Format must be csv, xlsx or pdf');
  const table = await analytics(req, (tx) => runReport(tx, req.ctx, definition ?? {}));
  const out = exportTable(table, format, title);
  res.setHeader('Content-Type', out.type);
  res.setHeader('Content-Disposition', `attachment; filename="${String(title).replace(/[^\w.-]+/g, '_')}.${out.ext}"`);
  res.send(out.body);
}));
reportsRouter.get('/saved', staff('report.read'), ah(async (req, res) => {
  res.json(await db(req, (tx) => many(tx, `SELECT r.*, u.name AS owner_name FROM reports r LEFT JOIN users u ON u.id = r.owner_id WHERE r.owner_id = $1 OR r.shared ORDER BY r.name`, [req.ctx.actorId])));
}));
reportsRouter.post('/saved', staff('report.build', 'report.read'), ah(async (req, res) => {
  const b = req.body ?? {};
  if (!b.name || !b.definition) throw badRequest('Name and definition are required');
  res.status(201).json(await db(req, (tx) => one(tx,
    `INSERT INTO reports (name, definition, owner_id, shared, schedule, format, recipients) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [b.name, JSON.stringify(b.definition), req.ctx.actorId, Boolean(b.shared), b.schedule || null, b.format ?? 'csv', b.recipients ?? []])));
}));
reportsRouter.patch('/saved/:id', staff('report.read'), ah(async (req, res) => {
  const b = req.body ?? {};
  const r = await db(req, (tx) => one(tx,
    `UPDATE reports SET name = coalesce($3, name), definition = coalesce($4, definition), shared = coalesce($5, shared), schedule = $6,
            format = coalesce($7, format), recipients = coalesce($8, recipients) WHERE id = $1 AND owner_id = $2 RETURNING *`,
    [req.params.id, req.ctx.actorId, b.name ?? null, b.definition ? JSON.stringify(b.definition) : null, b.shared ?? null, b.schedule || null, b.format ?? null, b.recipients ?? null]));
  if (!r) throw notFound('Report not found');
  res.json(r);
}));
reportsRouter.delete('/saved/:id', staff('report.read'), ah(async (req, res) => {
  await db(req, (tx) => tx.query('DELETE FROM reports WHERE id = $1 AND owner_id = $2', [req.params.id, req.ctx.actorId]));
  res.status(204).end();
}));
