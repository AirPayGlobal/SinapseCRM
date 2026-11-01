import { Router } from 'express';
import { many, one } from '../db/pool.js';
import { badRequest, notFound } from '../lib/errors.js';
import { ah, db, staff } from '../lib/http.js';

/** The signed-in staff member: profile, landing view, notifications, tasks, saved searches, dashboard layout. */
export const meRouter = Router();
meRouter.use(staff());

meRouter.get('/', ah(async (req, res) => {
  res.json(await db(req, async (tx) => ({
    ...req.ctx.staff,
    landing_view: (await one(tx, 'SELECT landing_view FROM roles WHERE key = $1', [req.ctx.staff?.roleKey]))?.landing_view ?? 'queue',
    presence: (await one(tx, 'SELECT presence FROM users WHERE id = $1', [req.ctx.actorId]))?.presence,
    counts: await one(tx,
      `SELECT (SELECT count(*)::int FROM queries WHERE assigned_to = $1 AND state NOT IN ('resolved','closed','merged','filtered')) AS my_queue,
              (SELECT count(*)::int FROM queries WHERE state NOT IN ('resolved','closed','merged','filtered')) AS team_queue,
              (SELECT count(*)::int FROM notifications WHERE recipient_type = 'user' AND recipient_id = $1 AND channel = 'in_app' AND read_at IS NULL) AS unread,
              (SELECT count(*)::int FROM staff_tasks WHERE assignee_id = $1 AND NOT done) AS tasks,
              (SELECT count(*)::int FROM queries WHERE state = 'filtered' AND closed_at IS NULL) AS filtered,
              (SELECT count(*)::int FROM companies WHERE status = 'pending') AS registrations`, [req.ctx.actorId]),
  })));
}));
meRouter.patch('/presence', ah(async (req, res) => {
  if (!['available', 'busy', 'away', 'offline'].includes(req.body?.presence)) throw badRequest('Invalid presence');
  await db(req, (tx) => tx.query('UPDATE users SET presence = $2 WHERE id = $1', [req.ctx.actorId, req.body.presence]));
  res.status(204).end();
}));
meRouter.get('/notifications', ah(async (req, res) => {
  res.json(await db(req, (tx) => many(tx, `SELECT id, subject, body, query_id, created_at, read_at FROM notifications WHERE recipient_type = 'user' AND recipient_id = $1 AND channel = 'in_app' ORDER BY created_at DESC LIMIT 50`, [req.ctx.actorId])));
}));
meRouter.post('/notifications/read', ah(async (req, res) => {
  await db(req, (tx) => tx.query(`UPDATE notifications SET read_at = now(), status = 'read' WHERE recipient_type = 'user' AND recipient_id = $1 AND channel = 'in_app' AND read_at IS NULL`, [req.ctx.actorId]));
  res.status(204).end();
}));
meRouter.get('/tasks', ah(async (req, res) => {
  res.json(await db(req, (tx) => many(tx, `SELECT t.*, q.reference FROM staff_tasks t LEFT JOIN queries q ON q.id = t.query_id WHERE t.assignee_id = $1 ORDER BY t.done, t.created_at DESC LIMIT 100`, [req.ctx.actorId])));
}));
meRouter.patch('/tasks/:id', ah(async (req, res) => {
  const r = await db(req, (tx) => one(tx, 'UPDATE staff_tasks SET done = $3 WHERE id = $1 AND assignee_id = $2 RETURNING *', [req.params.id, req.ctx.actorId, Boolean(req.body?.done)]));
  if (!r) throw notFound();
  res.json(r);
}));
meRouter.get('/saved-searches', ah(async (req, res) => {
  res.json(await db(req, (tx) => many(tx, `SELECT s.*, u.name AS owner_name FROM saved_searches s JOIN users u ON u.id = s.owner_id WHERE s.owner_id = $1 OR s.shared ORDER BY s.is_queue DESC, s.name`, [req.ctx.actorId])));
}));
meRouter.post('/saved-searches', ah(async (req, res) => {
  const b = req.body ?? {};
  if (!b.name || !b.filters) throw badRequest('Name and filters are required');
  res.status(201).json(await db(req, (tx) => one(tx, 'INSERT INTO saved_searches (owner_id, name, filters, shared, is_queue) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [req.ctx.actorId, b.name, JSON.stringify(b.filters), Boolean(b.shared), Boolean(b.is_queue)])));
}));
meRouter.delete('/saved-searches/:id', ah(async (req, res) => {
  await db(req, (tx) => tx.query('DELETE FROM saved_searches WHERE id = $1 AND owner_id = $2', [req.params.id, req.ctx.actorId]));
  res.status(204).end();
}));
meRouter.get('/dashboard-layout', ah(async (req, res) => {
  res.json((await db(req, (tx) => one(tx, 'SELECT layout FROM dashboard_layouts WHERE user_id = $1', [req.ctx.actorId])))?.layout ?? null);
}));
meRouter.put('/dashboard-layout', ah(async (req, res) => {
  await db(req, (tx) => tx.query('INSERT INTO dashboard_layouts (user_id, layout) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET layout = EXCLUDED.layout', [req.ctx.actorId, JSON.stringify(req.body ?? {})]));
  res.status(204).end();
}));
