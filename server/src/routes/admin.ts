import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { many, one, withSystem, type Tx } from '../db/pool.js';
import { audit, diff } from '../lib/audit.js';
import { namibianPublicHolidays } from '../lib/calendar.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { ah, db, qp, staff } from '../lib/http.js';
import { createApiClient } from '../services/auth.js';
import { invalidateModels } from '../services/classifier.js';
import { WEBHOOK_EVENTS } from '../services/events.js';
import { exportTable } from '../services/reports.js';
import { invalidateCalendarCache } from '../services/sla.js';
import { DEFAULT_SETTINGS, setSetting } from '../services/settings.js';
import { previewAgainstHistory, validateDefinition, type WfDefinition } from '../services/workflow.js';
import { connectorHealth } from '../integrations/fabric.js';
import { drainQueues } from '../services/assignment.js';

/**
 * Administration console: configuration held as data (fields, taxonomies, workflows, SLA policies,
 * escalation matrices, templates, roles), changed by Namport administrators without a release.
 * Every change is written to the event log with before and after state.
 */
export const adminRouter = Router();

/** Generic audited CRUD over a configuration table with whitelisted columns. */
function crud(path: string, table: string, cols: string[], perm: string, opts: { pk?: string; json?: string[]; order?: string; after?: (tx: Tx) => void | Promise<void> } = {}) {
  const pk = opts.pk ?? 'id';
  const json = new Set(opts.json ?? []);
  const val = (k: string, v: unknown) => (json.has(k) ? JSON.stringify(v) : v);
  adminRouter.get(path, staff(perm, 'admin.config'), ah(async (req, res) => res.json(await db(req, (tx) => many(tx, `SELECT * FROM ${table} ORDER BY ${opts.order ?? pk}`)))));
  adminRouter.post(path, staff(perm), ah(async (req, res) => {
    const b = req.body ?? {};
    const keys = cols.filter((c) => c in b);
    if (!keys.length) throw badRequest('Nothing to create');
    const row = await db(req, async (tx) => {
      const r = await one(tx, `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, keys.map((k) => val(k, b[k])));
      await audit(tx, req.ctx, `config.${table}.created`, table, String(r[pk]), undefined, r);
      await opts.after?.(tx);
      return r;
    });
    res.status(201).json(row);
  }));
  adminRouter.patch(`${path}/:key`, staff(perm), ah(async (req, res) => {
    const b = req.body ?? {};
    const row = await db(req, async (tx) => {
      const cur = await one(tx, `SELECT * FROM ${table} WHERE ${pk}::text = $1 FOR UPDATE`, [req.params.key]);
      if (!cur) throw notFound();
      const next: Record<string, unknown> = {};
      for (const c of cols) if (c in b && c !== pk) next[c] = b[c];
      const d = diff(cur, next);
      if (!d.changed) return cur;
      const keys = Object.keys(d.after);
      const r = await one(tx, `UPDATE ${table} SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE ${pk}::text = $1 RETURNING *`, [req.params.key, ...keys.map((k) => val(k, d.after[k]))]);
      await audit(tx, req.ctx, `config.${table}.updated`, table, req.params.key, d.before, d.after);
      await opts.after?.(tx);
      return r;
    });
    res.json(row);
  }));
  adminRouter.delete(`${path}/:key`, staff(perm), ah(async (req, res) => {
    await db(req, async (tx) => {
      const cur = await one(tx, `DELETE FROM ${table} WHERE ${pk}::text = $1 RETURNING *`, [req.params.key]);
      if (!cur) throw notFound();
      await audit(tx, req.ctx, `config.${table}.deleted`, table, req.params.key, cur, undefined);
      await opts.after?.(tx);
    });
    res.status(204).end();
  }));
}

// ---- reference data used across the console ----------------------------------
adminRouter.get('/reference', ah(async (req, res) => {
  if (req.ctx.actorType !== 'user' && req.ctx.actorType !== 'api') throw badRequest('Staff only');
  res.json(await withSystem(async (tx) => ({
    ports: await many(tx, 'SELECT * FROM ports ORDER BY code'),
    departments: await many(tx, 'SELECT * FROM departments ORDER BY name'),
    query_types: await many(tx, 'SELECT key, name, department_id, default_urgency, weight, skill, active FROM query_types ORDER BY name'),
    queues: await many(tx, 'SELECT id, key, name, department_id, port_code, strategy FROM queues WHERE active ORDER BY name'),
    corridors: await many(tx, 'SELECT * FROM corridors ORDER BY name'),
    roles: await many(tx, 'SELECT key, name FROM roles ORDER BY name'),
    users: await many(tx, `SELECT id, name, email, role_key, port_code, department_id, presence FROM users WHERE active ORDER BY name`),
    finding_types: await many(tx, 'SELECT * FROM finding_types ORDER BY name'),
    urgencies: ['low', 'normal', 'high', 'critical'],
    webhook_events: WEBHOOK_EVENTS,
  })));
}));

// ---- settings -------------------------------------------------------------------
adminRouter.get('/settings', staff('admin.config'), ah(async (req, res) => {
  const rows = await db(req, (tx) => many(tx, 'SELECT key, value FROM settings'));
  res.json({ ...DEFAULT_SETTINGS, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) });
}));
adminRouter.put('/settings/:key', staff('admin.config'), ah(async (req, res) => {
  if (!(req.params.key in DEFAULT_SETTINGS)) throw badRequest('Unknown setting');
  await db(req, async (tx) => {
    const before = await one(tx, 'SELECT value FROM settings WHERE key = $1', [req.params.key]);
    await setSetting(tx, req.params.key, req.body?.value);
    await audit(tx, req.ctx, 'config.setting.updated', 'setting', req.params.key, { value: before?.value ?? DEFAULT_SETTINGS[req.params.key] }, { value: req.body?.value });
  });
  res.status(204).end();
}));

// ---- taxonomies, queues, fields, rules, templates, roles ------------------------
crud('/query-types', 'query_types', ['key', 'name', 'department_id', 'workflow_key', 'queue_key', 'default_urgency', 'weight', 'skill', 'assist_routable', 'active', 'training_examples'], 'admin.config', { pk: 'key', after: () => invalidateModels() });
crud('/departments', 'departments', ['code', 'name'], 'admin.config', { order: 'name' });
crud('/queues', 'queues', ['key', 'name', 'department_id', 'port_code', 'strategy', 'eligible_roles', 'required_skills', 'active'], 'admin.config', { order: 'name' });
crud('/custom-fields', 'custom_field_definitions', ['entity', 'key', 'label', 'field_type', 'required', 'options', 'validation', 'default_value', 'help_text', 'visible_roles', 'query_types', 'customer_visible', 'sort_order', 'active'], 'admin.config', { json: ['validation', 'default_value'], order: 'entity, sort_order' });
crud('/filter-rules', 'filter_rules', ['pattern', 'category', 'active'], 'admin.config', { order: 'pattern' });
crud('/templates', 'notification_templates', ['key', 'subject', 'body', 'channels'], 'admin.config', { pk: 'key' });
crud('/escalation-matrices', 'escalation_matrices', ['name', 'query_type_key', 'department_id', 'account_tier', 'levels', 'active'], 'admin.config', { json: ['levels'], order: 'name' });
crud('/sla-policies', 'sla_policies', ['name', 'calendar_id', 'first_response_minutes', 'resolution_minutes', 'tier_overrides', 'urgency_multipliers', 'pre_breach_percent'], 'admin.config', { json: ['tier_overrides', 'urgency_multipliers'], order: 'name' });
crud('/roles', 'roles', ['key', 'name', 'permissions', 'port_scope', 'dept_scope', 'field_masks', 'landing_view'], 'admin.security', { pk: 'key' });
crud('/corridors', 'corridors', ['code', 'name', 'countries'], 'admin.config', { order: 'name' });
crud('/finding-types', 'finding_types', ['key', 'name'], 'admin.config', { pk: 'key' });
crud('/retention-policies', 'retention_policies', ['entity', 'keep_days'], 'admin.security', { pk: 'entity' });

// ---- calendars and Namibian public holidays --------------------------------------
crud('/calendars', 'calendars', ['name', 'utc_offset_minutes', 'business_hours'], 'admin.config', { json: ['business_hours'], order: 'name', after: () => invalidateCalendarCache() });
adminRouter.get('/calendars/:id/holidays', staff('admin.config'), ah(async (req, res) => {
  res.json(await db(req, (tx) => many(tx, `SELECT to_char(day, 'YYYY-MM-DD') AS day, name FROM calendar_holidays WHERE calendar_id = $1 ORDER BY day`, [req.params.id])));
}));
adminRouter.post('/calendars/:id/holidays', staff('admin.config'), ah(async (req, res) => {
  const { day, name } = req.body ?? {};
  if (!day || !name) throw badRequest('Day and name are required');
  await db(req, async (tx) => {
    await tx.query(`INSERT INTO calendar_holidays (calendar_id, day, name) VALUES ($1,$2,$3) ON CONFLICT (calendar_id, day) DO UPDATE SET name = EXCLUDED.name`, [req.params.id, day, name]);
    await audit(tx, req.ctx, 'config.holiday.added', 'calendar', req.params.id, undefined, { day, name });
  });
  invalidateCalendarCache();
  res.status(201).json({ day, name });
}));
adminRouter.delete('/calendars/:id/holidays/:day', staff('admin.config'), ah(async (req, res) => {
  await db(req, async (tx) => {
    await tx.query('DELETE FROM calendar_holidays WHERE calendar_id = $1 AND day = $2', [req.params.id, req.params.day]);
    await audit(tx, req.ctx, 'config.holiday.removed', 'calendar', req.params.id, { day: req.params.day }, undefined);
  });
  invalidateCalendarCache();
  res.status(204).end();
}));
adminRouter.post('/calendars/:id/holidays/generate', staff('admin.config'), ah(async (req, res) => {
  const year = Number(req.body?.year ?? new Date().getUTCFullYear());
  const days = namibianPublicHolidays(year);
  await db(req, async (tx) => {
    for (const h of days) await tx.query(`INSERT INTO calendar_holidays (calendar_id, day, name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [req.params.id, h.day, h.name]);
    await audit(tx, req.ctx, 'config.holidays.generated', 'calendar', req.params.id, undefined, { year, count: days.length });
  });
  invalidateCalendarCache();
  res.json(days);
}));

// ---- workflow designer: versioned definitions --------------------------------------
adminRouter.get('/workflows', staff('admin.config'), ah(async (req, res) => {
  res.json(await db(req, (tx) => many(tx,
    `SELECT w.id, w.workflow_key, w.version, w.status, w.published_at, w.sla_policy_id, u.name AS published_by_name, w.created_at,
            (SELECT count(*)::int FROM queries q WHERE q.workflow_definition_id = w.id AND q.state NOT IN ('closed','merged','filtered')) AS open_cases
       FROM workflow_definitions w LEFT JOIN users u ON u.id = w.published_by ORDER BY w.workflow_key, w.version DESC`)));
}));
adminRouter.get('/workflows/:id', staff('admin.config'), ah(async (req, res) => {
  const w = await db(req, (tx) => one(tx, 'SELECT * FROM workflow_definitions WHERE id = $1', [req.params.id]));
  if (!w) throw notFound();
  res.json(w);
}));
/** Create a new draft version from an existing definition (or a new workflow key). */
adminRouter.post('/workflows', staff('admin.config'), ah(async (req, res) => {
  const { workflow_key, from_id, definition, sla_policy_id } = req.body ?? {};
  if (!workflow_key) throw badRequest('Workflow key is required');
  res.status(201).json(await db(req, async (tx) => {
    const src = from_id ? await one(tx, 'SELECT definition, sla_policy_id FROM workflow_definitions WHERE id = $1', [from_id]) : null;
    const def = definition ?? src?.definition;
    if (!def) throw badRequest('Provide a definition or a version to copy');
    const v = await one(tx, 'SELECT coalesce(max(version), 0) + 1 AS v FROM workflow_definitions WHERE workflow_key = $1', [workflow_key]);
    const w = await one(tx, `INSERT INTO workflow_definitions (workflow_key, version, status, definition, sla_policy_id) VALUES ($1,$2,'draft',$3,$4) RETURNING *`,
      [workflow_key, v.v, JSON.stringify(def), sla_policy_id ?? src?.sla_policy_id ?? null]);
    await audit(tx, req.ctx, 'config.workflow.draft_created', 'workflow_definition', w.id, undefined, { workflow_key, version: w.version });
    return w;
  }));
}));
adminRouter.patch('/workflows/:id', staff('admin.config'), ah(async (req, res) => {
  res.json(await db(req, async (tx) => {
    const w = await one(tx, 'SELECT * FROM workflow_definitions WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!w) throw notFound();
    if (w.status !== 'draft') throw conflict('Published versions are immutable — create a new draft version');
    const def = req.body?.definition ?? w.definition;
    const r = await one(tx, 'UPDATE workflow_definitions SET definition = $2, sla_policy_id = coalesce($3, sla_policy_id) WHERE id = $1 RETURNING *', [req.params.id, JSON.stringify(def), req.body?.sla_policy_id ?? null]);
    await audit(tx, req.ctx, 'config.workflow.draft_updated', 'workflow_definition', w.id, { definition: w.definition }, { definition: def });
    return { ...r, validation_errors: validateDefinition(def) };
  }));
}));
adminRouter.post('/workflows/:id/preview', staff('admin.config'), ah(async (req, res) => {
  res.json(await db(req, async (tx) => {
    const w = await one(tx, 'SELECT * FROM workflow_definitions WHERE id = $1', [req.params.id]);
    if (!w) throw notFound();
    return previewAgainstHistory(tx, (req.body?.definition ?? w.definition) as WfDefinition, w.workflow_key);
  }));
}));
adminRouter.post('/workflows/:id/publish', staff('admin.config'), ah(async (req, res) => {
  res.json(await db(req, async (tx) => {
    const w = await one(tx, 'SELECT * FROM workflow_definitions WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!w) throw notFound();
    if (w.status !== 'draft') throw conflict('Only drafts can be published');
    const errors = validateDefinition(w.definition);
    if (errors.length) throw badRequest('The workflow is not valid', errors);
    // The previous version is retired for new cases only; in-flight cases keep the version they started under.
    await tx.query(`UPDATE workflow_definitions SET status = 'retired' WHERE workflow_key = $1 AND status = 'published'`, [w.workflow_key]);
    const r = await one(tx, `UPDATE workflow_definitions SET status = 'published', published_at = now(), published_by = $2 WHERE id = $1 RETURNING *`, [w.id, req.ctx.actorId]);
    await audit(tx, req.ctx, 'config.workflow.published', 'workflow_definition', w.id, { status: 'draft' }, { status: 'published', workflow_key: w.workflow_key, version: w.version });
    return r;
  }));
}));

// ---- users, availability and leave ----------------------------------------------------
adminRouter.get('/users', staff('admin.users', 'query.reassign'), ah(async (req, res) => {
  res.json(await db(req, (tx) => many(tx,
    `SELECT u.id, u.email, u.name, u.role_key, u.port_code, u.department_id, d.name AS department_name, u.skills, u.capacity, u.presence, u.active,
            u.identity_subject IS NOT NULL AS sso_linked, u.scim_external_id IS NOT NULL AS scim_managed, u.created_at
       FROM users u LEFT JOIN departments d ON d.id = u.department_id ORDER BY u.active DESC, u.name`)));
}));
adminRouter.post('/users', staff('admin.users'), ah(async (req, res) => {
  const b = req.body ?? {};
  if (!b.email || !b.name || !b.role_key) throw badRequest('Email, name and role are required');
  res.status(201).json(await db(req, async (tx) => {
    const u = await one(tx,
      `INSERT INTO users (email, name, role_key, port_code, department_id, skills, capacity, password_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, email, name, role_key, port_code, department_id, skills, capacity, active`,
      [b.email.toLowerCase(), b.name, b.role_key, b.port_code ?? null, b.department_id ?? null, b.skills ?? [], b.capacity ?? 20, b.password ? await bcrypt.hash(b.password, 10) : null]);
    await tx.query('INSERT INTO agent_availability (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [u.id]);
    await audit(tx, req.ctx, 'user.created', 'user', u.id, undefined, u);
    return u;
  }));
}));
adminRouter.patch('/users/:id', staff('admin.users'), ah(async (req, res) => {
  const b = req.body ?? {};
  res.json(await db(req, async (tx) => {
    const cur = await one(tx, 'SELECT id, email, name, role_key, port_code, department_id, skills, capacity, active, presence FROM users WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!cur) throw notFound();
    const next: Record<string, unknown> = {};
    for (const k of ['name', 'role_key', 'port_code', 'department_id', 'skills', 'capacity', 'active', 'presence']) if (k in b) next[k] = b[k];
    const d = diff(cur, next);
    if (d.changed) {
      const keys = Object.keys(d.after);
      await tx.query(`UPDATE users SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`, [req.params.id, ...keys.map((k) => d.after[k])]);
      await audit(tx, req.ctx, 'user.updated', 'user', req.params.id, d.before, d.after);
    }
    if (b.password) {
      await tx.query('UPDATE users SET password_hash = $2 WHERE id = $1', [req.params.id, await bcrypt.hash(b.password, 10)]);
      await audit(tx, req.ctx, 'user.password_set', 'user', req.params.id);
    }
    return one(tx, 'SELECT id, email, name, role_key, port_code, department_id, skills, capacity, active, presence FROM users WHERE id = $1', [req.params.id]);
  }));
}));

/** Agent availability board: presence, out-of-office (from Outlook), leave and live weighted load. */
adminRouter.get('/availability', staff('query.reassign', 'admin.users'), ah(async (req, res) => {
  res.json(await db(req, (tx) => many(tx,
    `SELECT u.id, u.name, u.role_key, u.port_code, d.name AS department_name, u.presence, u.capacity, u.skills,
            a.out_of_office, a.ooo_from, a.ooo_until, a.ooo_message, a.source, a.synced_at, a.working_pattern,
            (SELECT json_agg(json_build_object('starts_at', l.starts_at, 'ends_at', l.ends_at)) FROM leave_periods l WHERE l.user_id = u.id AND l.ends_at > now()) AS leave,
            coalesce((SELECT sum(coalesce(qt.weight,1) * CASE q.urgency WHEN 'low' THEN 0.75 WHEN 'high' THEN 1.5 WHEN 'critical' THEN 2 ELSE 1 END)
                        FROM queries q LEFT JOIN query_types qt ON qt.key = q.query_type_key
                       WHERE q.assigned_to = u.id AND q.state NOT IN ('resolved','closed','merged','filtered')), 0)::float AS load,
            (SELECT count(*)::int FROM queries q WHERE q.assigned_to = u.id AND q.state NOT IN ('resolved','closed','merged','filtered')) AS open_cases
       FROM users u LEFT JOIN agent_availability a ON a.user_id = u.id LEFT JOIN departments d ON d.id = u.department_id
      WHERE u.active AND u.role_key IN ('agent','supervisor') ORDER BY u.port_code, u.name`)));
}));
adminRouter.patch('/availability/:userId', staff('admin.users', 'query.reassign'), ah(async (req, res) => {
  const b = req.body ?? {};
  await db(req, async (tx) => {
    if ('presence' in b) await tx.query('UPDATE users SET presence = $2 WHERE id = $1', [req.params.userId, b.presence]);
    await tx.query(
      `INSERT INTO agent_availability (user_id, out_of_office, ooo_from, ooo_until, ooo_message, working_pattern, source)
       VALUES ($1, coalesce($2, false), $3, $4, $5, $6, 'manual')
       ON CONFLICT (user_id) DO UPDATE SET out_of_office = coalesce($2, agent_availability.out_of_office), ooo_from = $3, ooo_until = $4,
              ooo_message = coalesce($5, agent_availability.ooo_message), working_pattern = coalesce($6, agent_availability.working_pattern), source = 'manual'`,
      [req.params.userId, b.out_of_office ?? null, b.ooo_from ?? null, b.ooo_until ?? null, b.ooo_message ?? null, b.working_pattern ? JSON.stringify(b.working_pattern) : null]);
    await audit(tx, req.ctx, 'availability.updated', 'user', req.params.userId, undefined, b);
    await drainQueues(tx);
  });
  res.status(204).end();
}));
adminRouter.post('/availability/:userId/leave', staff('admin.users', 'query.reassign'), ah(async (req, res) => {
  const { starts_at, ends_at } = req.body ?? {};
  if (!starts_at || !ends_at) throw badRequest('Start and end are required');
  res.status(201).json(await db(req, async (tx) => {
    const l = await one(tx, `INSERT INTO leave_periods (user_id, starts_at, ends_at, source, external_id) VALUES ($1,$2,$3,'manual',$4) RETURNING *`,
      [req.params.userId, starts_at, ends_at, crypto.randomUUID()]);
    await audit(tx, req.ctx, 'availability.leave_added', 'user', req.params.userId, undefined, l);
    return l;
  }));
}));

// ---- alerts ----------------------------------------------------------------------------
adminRouter.get('/alerts', staff('query.read'), ah(async (req, res) => {
  const f = qp(req);
  res.json(await db(req, (tx) => many(tx,
    `SELECT a.*, q.reference, f.reference AS finding_reference, u.name AS acknowledged_by_name FROM alerts a
       LEFT JOIN queries q ON q.id = a.query_id LEFT JOIN findings f ON f.id = a.finding_id LEFT JOIN users u ON u.id = a.acknowledged_by
      WHERE ($1::boolean IS NOT TRUE OR a.acknowledged_at IS NULL) AND ($2::text IS NULL OR a.kind = $2)
        AND (a.port_code IS NULL OR $3::text IS NULL OR a.port_code = $3)
      ORDER BY a.acknowledged_at IS NULL DESC, a.created_at DESC LIMIT 200`,
    [f.open === 'true', f.kind ?? null, req.ctx.staff?.portScope === 'all' ? null : req.ctx.staff?.portCode ?? null])));
}));
adminRouter.post('/alerts/:id/ack', staff('query.read'), ah(async (req, res) => {
  await db(req, async (tx) => {
    await tx.query('UPDATE alerts SET acknowledged_by = $2, acknowledged_at = now() WHERE id = $1 AND acknowledged_at IS NULL', [req.params.id, req.ctx.actorId]);
    await audit(tx, req.ctx, 'alert.acknowledged', 'alert', req.params.id);
  });
  res.status(204).end();
}));

// ---- webhooks and API clients (Namport-owned integration surface) ------------------------
adminRouter.get('/webhooks', staff('integration.manage'), ah(async (req, res) => {
  res.json(await db(req, (tx) => many(tx, `SELECT w.id, w.name, w.url, w.events, w.active, w.created_at,
    (SELECT count(*)::int FROM webhook_deliveries d WHERE d.webhook_id = w.id AND d.status = 'dead_letter') AS dead_letters FROM webhooks w ORDER BY w.name`)));
}));
adminRouter.post('/webhooks', staff('integration.manage'), ah(async (req, res) => {
  const b = req.body ?? {};
  if (!b.name || !/^https:\/\//.test(b.url ?? '') && !/^http:\/\/localhost/.test(b.url ?? '')) throw badRequest('A name and an https URL are required');
  const events = (b.events ?? []).filter((e: string) => (WEBHOOK_EVENTS as readonly string[]).includes(e));
  if (!events.length) throw badRequest('Subscribe to at least one event');
  res.status(201).json(await db(req, async (tx) => {
    const secret = `whsec_${crypto.randomBytes(24).toString('base64url')}`;
    const w = await one(tx, 'INSERT INTO webhooks (name, url, events, secret, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, url, events, active', [b.name, b.url, events, secret, req.ctx.actorId]);
    await audit(tx, req.ctx, 'webhook.created', 'webhook', w.id, undefined, w);
    return { ...w, secret };
  }));
}));
adminRouter.patch('/webhooks/:id', staff('integration.manage'), ah(async (req, res) => {
  const b = req.body ?? {};
  res.json(await db(req, async (tx) => {
    const w = await one(tx, `UPDATE webhooks SET active = coalesce($2, active), events = coalesce($3, events), url = coalesce($4, url) WHERE id = $1 RETURNING id, name, url, events, active`,
      [req.params.id, b.active ?? null, b.events ?? null, b.url ?? null]);
    if (!w) throw notFound();
    await audit(tx, req.ctx, 'webhook.updated', 'webhook', w.id, undefined, b);
    return w;
  }));
}));
adminRouter.delete('/webhooks/:id', staff('integration.manage'), ah(async (req, res) => {
  await db(req, async (tx) => { await tx.query('DELETE FROM webhooks WHERE id = $1', [req.params.id]); await audit(tx, req.ctx, 'webhook.deleted', 'webhook', req.params.id); });
  res.status(204).end();
}));
adminRouter.get('/webhooks/:id/deliveries', staff('integration.manage'), ah(async (req, res) => {
  res.json(await db(req, (tx) => many(tx, 'SELECT id, event, status, attempts, response_code, last_error, created_at, next_attempt_at FROM webhook_deliveries WHERE webhook_id = $1 ORDER BY created_at DESC LIMIT 100', [req.params.id])));
}));
adminRouter.post('/webhooks/deliveries/:id/retry', staff('integration.manage'), ah(async (req, res) => {
  await db(req, (tx) => tx.query(`UPDATE webhook_deliveries SET status = 'pending', attempts = 0, next_attempt_at = now() WHERE id = $1`, [req.params.id]));
  res.status(204).end();
}));
adminRouter.get('/api-clients', staff('integration.manage'), ah(async (req, res) => res.json(await db(req, (tx) => many(tx, 'SELECT id, name, role_key, active, created_at FROM api_clients ORDER BY name')))));
adminRouter.post('/api-clients', staff('integration.manage'), ah(async (req, res) => {
  if (!req.body?.name || !req.body?.role_key) throw badRequest('Name and role are required');
  res.status(201).json(await db(req, (tx) => createApiClient(tx, req.ctx, req.body.name, req.body.role_key)));
}));
adminRouter.post('/api-clients/:id/revoke', staff('integration.manage'), ah(async (req, res) => {
  await db(req, async (tx) => { await tx.query('UPDATE api_clients SET active = false WHERE id = $1', [req.params.id]); await audit(tx, req.ctx, 'api_client.revoked', 'api_client', req.params.id); });
  res.status(204).end();
}));

// ---- integration health console --------------------------------------------------------------
adminRouter.get('/integrations', staff('integration.manage', 'admin.config'), ah(async (_req, res) => res.json(await connectorHealth())));
adminRouter.get('/integrations/:key/log', staff('integration.manage', 'admin.config'), ah(async (req, res) => {
  const f = qp(req);
  res.json(await db(req, (tx) => many(tx,
    `SELECT * FROM integration_log WHERE connector_key = $1 AND ($2::text IS NULL OR status = $2) AND ($3::text IS NULL OR correlation_id = $3 OR payload::text ILIKE '%' || $3 || '%')
      ORDER BY id DESC LIMIT 200`, [req.params.key, f.status ?? null, f.q ?? null])));
}));
adminRouter.post('/integrations/:key/:action', staff('integration.manage'), ah(async (req, res) => {
  const action = req.params.action;
  if (!['enable', 'disable', 'revoke'].includes(action)) throw badRequest('Unknown action');
  await db(req, async (tx) => {
    await tx.query(
      `UPDATE integration_connectors SET enabled = $2, status = CASE WHEN $3 THEN 'revoked' WHEN $2 AND status = 'revoked' THEN 'unconfigured' ELSE status END WHERE key = $1`,
      [req.params.key, action === 'enable', action === 'revoke']);
    await audit(tx, req.ctx, `integration.${action}d`, 'integration_connector', req.params.key);
  });
  res.status(204).end();
}));

// ---- audit log explorer (SA-01.3) ---------------------------------------------------------------
async function auditRows(tx: Tx, f: Record<string, any>, limit = 200) {
  return many(tx,
    `SELECT id, occurred_at, actor_type, actor_id, actor_name, action, entity, entity_id, before, after, request_id, ip, hash FROM event_log
      WHERE ($1::text IS NULL OR action ILIKE $1 || '%') AND ($2::text IS NULL OR entity = $2) AND ($3::text IS NULL OR entity_id = $3)
        AND ($4::text IS NULL OR actor_name ILIKE '%' || $4 || '%' OR actor_id = $4) AND ($5::timestamptz IS NULL OR occurred_at >= $5)
        AND ($6::timestamptz IS NULL OR occurred_at < $6) AND ($7::bigint IS NULL OR id < $7)
      ORDER BY id DESC LIMIT ${limit}`,
    [f.action ?? null, f.entity ?? null, f.entity_id ?? null, f.actor ?? null, f.from ?? null, f.to ?? null, f.before_id ?? null]);
}
adminRouter.get('/audit', staff('audit.read'), ah(async (req, res) => res.json(await db(req, (tx) => auditRows(tx, qp(req))))));
adminRouter.get('/audit/export', staff('audit.read'), ah(async (req, res) => {
  const f = qp(req);
  const rows = await db(req, (tx) => auditRows(tx, f, 50_000));
  await db(req, (tx) => audit(tx, req.ctx, 'audit.exported', 'event_log', null, undefined, { filters: f, rows: rows.length }));
  if (f.format === 'jsonl') {
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Content-Disposition', 'attachment; filename="sinapse-audit.jsonl"');
    return res.send(rows.map((r) => JSON.stringify(r)).join('\n'));
  }
  const cols = ['id', 'occurred_at', 'actor_type', 'actor_name', 'action', 'entity', 'entity_id', 'before', 'after', 'ip', 'hash'];
  const out = exportTable({ columns: cols.map((c) => ({ key: c, label: c })), rows: rows.map((r) => ({ ...r, before: JSON.stringify(r.before), after: JSON.stringify(r.after) })) }, 'csv', 'Audit');
  res.setHeader('Content-Type', out.type);
  res.setHeader('Content-Disposition', 'attachment; filename="sinapse-audit.csv"');
  res.send(out.body);
}));
/** Verify every row hash and the seal chain end to end: any edited, removed or reordered entry breaks it. */
adminRouter.get('/audit/verify', staff('audit.read'), ah(async (req, res) => {
  await withSystem((tx) => tx.query('SELECT seal_event_log()'));
  res.json(await db(req, async (tx) => {
    const rows = await one(tx, `SELECT count(*)::int AS entries, count(*) FILTER (WHERE e.hash <> event_log_row_hash(e))::int AS tampered_rows,
                                       min(e.id) FILTER (WHERE e.hash <> event_log_row_hash(e)) AS first_tampered_id,
                                       count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM event_log_seal s WHERE s.event_id = e.id))::int AS unsealed
                                  FROM event_log e`);
    const chain = await one(tx,
      `WITH c AS (
         SELECT s.seq, s.prev_hash, s.chain_hash, s.row_hash, e.hash AS current_row_hash,
                coalesce(lag(s.chain_hash) OVER (ORDER BY s.seq), 'GENESIS') AS expected_prev
           FROM event_log_seal s LEFT JOIN event_log e ON e.id = s.event_id)
       SELECT count(*)::int AS sealed,
              count(*) FILTER (WHERE prev_hash <> expected_prev
                                  OR chain_hash <> encode(sha256(convert_to(prev_hash || '|' || row_hash, 'UTF8')), 'hex')
                                  OR current_row_hash IS DISTINCT FROM row_hash)::int AS broken_links,
              min(seq) FILTER (WHERE prev_hash <> expected_prev OR current_row_hash IS DISTINCT FROM row_hash) AS first_broken_seq,
              (SELECT chain_hash FROM event_log_seal ORDER BY seq DESC LIMIT 1) AS head
         FROM c`);
    return { ...rows, ...chain, intact: rows.tampered_rows === 0 && chain.broken_links === 0, verified_at: new Date().toISOString() };
  }));
}));
