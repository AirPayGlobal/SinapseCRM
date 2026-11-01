import { Router } from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { many, one } from '../db/pool.js';
import { ah, db, qp, staff } from '../lib/http.js';
import { badRequest, notFound } from '../lib/errors.js';
import { assign, evaluateCandidates, reassign } from '../services/assignment.js';
import { readAttachment, storeAttachment } from '../services/attachments.js';
import { intake } from '../services/intake.js';
import { proposeFromQuery } from '../services/kb.js';
import {
  addNote, buildQueryWhere, dismissDuplicate, getQueryDetail, listQueries, logCall, merge, reply, reviewFiltered, updateQuery,
} from '../services/queries.js';
import { exportTable } from '../services/reports.js';
import { retrieve } from '../services/kb.js';
import { similarity } from '../lib/text.js';
import { transition } from '../services/workflow.js';

export const queriesRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadBytes } });

queriesRouter.get('/', staff('query.read'), ah(async (req, res) => {
  const f = qp(req);
  if (f.saved_search) {
    const s = await db(req, (tx) => one(tx, `SELECT filters FROM saved_searches WHERE id = $1 AND (owner_id = $2 OR shared)`, [f.saved_search, req.ctx.actorId]));
    if (!s) throw notFound('Saved search not found');
    Object.assign(f, s.filters);
  }
  for (const k of ['mine', 'unassigned', 'open', 'duplicates']) if (k in f) f[k] = f[k] === 'true' || f[k] === true;
  res.json(await db(req, (tx) => listQueries(tx, req.ctx, f)));
}));

queriesRouter.get('/export', staff('query.read', 'report.read'), ah(async (req, res) => {
  const f = qp(req);
  for (const k of ['mine', 'unassigned', 'open']) if (k in f) f[k] = f[k] === 'true';
  const { items } = await db(req, (tx) => listQueries(tx, req.ctx, { ...f, limit: 5000 }));
  const columns = ['reference', 'subject', 'state', 'urgency', 'query_type_name', 'department_name', 'port_code', 'company_name', 'contact_name',
    'assigned_to_name', 'channel', 'created_at', 'first_response_due_at', 'resolution_due_at', 'resolved_at'].map((k) => ({ key: k, label: k.replace(/_/g, ' ') }));
  const out = exportTable({ columns, rows: items }, (f.format ?? 'csv') as any, 'Queries');
  res.setHeader('Content-Type', out.type);
  res.setHeader('Content-Disposition', `attachment; filename="queries.${out.ext}"`);
  res.send(out.body);
}));

/** Quick capture (UE-01.4): staff-logged telephone or walk-in query. */
queriesRouter.post('/', staff('query.create'), ah(async (req, res) => {
  const b = req.body ?? {};
  const r = await db(req, (tx) => intake(tx, req.ctx, {
    channel: b.channel === 'email' ? 'email' : 'staff',
    subject: b.subject, body: b.description ?? b.body ?? '', port: b.port_code ?? req.ctx.staff?.portCode ?? undefined,
    contactId: b.contact_id, companyId: b.company_id, queryTypeKey: b.query_type_key, urgency: b.urgency,
    customFields: b.custom_fields, vesselCallId: b.vessel_call_id, cargoReferenceId: b.cargo_reference_id,
    call: b.call ? { direction: b.call.direction ?? 'inbound', durationSeconds: b.call.duration_seconds, outcome: b.call.outcome } : { direction: 'inbound' },
    from: b.from, createdBy: req.ctx.actorId,
  }));
  res.status(201).json(r);
}));

/** Live classification preview for the capture form ("category prediction"). */
queriesRouter.post('/classify', staff('query.create'), ah(async (req, res) => {
  const { classify } = await import('../services/classifier.js');
  const { findNearDuplicate } = await import('../services/intake.js');
  const text = `${req.body?.subject ?? ''}\n${req.body?.description ?? ''}`;
  res.json(await db(req, async (tx) => ({
    classification: await classify(tx, text),
    possible_duplicate: await findNearDuplicate(tx, text, req.body?.contact_id ?? null, req.body?.company_id ?? null),
  })));
}));

queriesRouter.get('/:id', staff('query.read'), ah(async (req, res) => {
  res.json(await db(req, (tx) => getQueryDetail(tx, req.ctx, req.params.id)));
}));

queriesRouter.patch('/:id', staff('query.update'), ah(async (req, res) => {
  res.json(await db(req, (tx) => updateQuery(tx, req.ctx, req.params.id, req.body ?? {})));
}));

queriesRouter.post('/:id/transition', staff('query.update'), ah(async (req, res) => {
  const { to, reason, resolution_note } = req.body ?? {};
  if (!to) throw badRequest('Target state is required');
  res.json(await db(req, (tx) => transition(tx, req.ctx, req.params.id, to, { reason, resolutionNote: resolution_note })));
}));

queriesRouter.post('/:id/notes', staff('query.update'), ah(async (req, res) => {
  res.status(201).json(await db(req, (tx) => addNote(tx, req.ctx, req.params.id, req.body?.body)));
}));

queriesRouter.post('/:id/reply', staff('query.update'), ah(async (req, res) => {
  res.json(await db(req, (tx) => reply(tx, req.ctx, req.params.id, req.body?.body, { then: req.body?.then, resolutionNote: req.body?.resolution_note })));
}));

queriesRouter.post('/:id/calls', staff('query.update'), ah(async (req, res) => {
  const b = req.body ?? {};
  res.status(201).json(await db(req, (tx) => logCall(tx, req.ctx, req.params.id, { direction: b.direction ?? 'inbound', durationSeconds: b.duration_seconds, outcome: b.outcome, notes: b.notes ?? '' })));
}));

queriesRouter.post('/:id/assign', staff('query.reassign'), ah(async (req, res) => {
  const { user_id, reason } = req.body ?? {};
  res.json(await db(req, (tx) => (user_id !== undefined || reason ? reassign(tx, req.ctx, req.params.id, user_id ?? null, reason) : assign(tx, req.ctx, req.params.id))));
}));

/** Why each agent is or is not eligible right now — the assignment engine's reasoning, shown. */
queriesRouter.get('/:id/candidates', staff('query.reassign'), ah(async (req, res) => {
  res.json(await db(req, async (tx) => {
    const q = await one(tx, 'SELECT * FROM queries WHERE id = $1', [req.params.id]);
    if (!q) throw notFound();
    const queue = q.queue_id ? await one(tx, 'SELECT * FROM queues WHERE id = $1', [q.queue_id]) : null;
    return evaluateCandidates(tx, q, queue);
  }));
}));

queriesRouter.post('/:id/merge', staff('query.merge'), ah(async (req, res) => {
  const into = req.body?.into;
  if (!into) throw badRequest('Choose the original case to merge into');
  res.json(await db(req, async (tx) => {
    const target = await one(tx, `SELECT id FROM queries WHERE id::text = $1 OR reference = $1`, [into]);
    if (!target) throw notFound('Original case not found');
    return merge(tx, req.ctx, req.params.id, target.id);
  }));
}));

queriesRouter.post('/:id/dismiss-duplicate', staff('query.update'), ah(async (req, res) => {
  await db(req, (tx) => dismissDuplicate(tx, req.ctx, req.params.id));
  res.status(204).end();
}));

queriesRouter.post('/:id/filter-review', staff('query.review_filtered'), ah(async (req, res) => {
  const decision = req.body?.decision;
  if (!['release', 'confirm'].includes(decision)) throw badRequest('Decision must be release or confirm');
  res.json(await db(req, (tx) => reviewFiltered(tx, req.ctx, req.params.id, decision)));
}));

/** Agent assist: suggested response drawn from approved knowledge and comparable resolved cases. */
queriesRouter.get('/:id/assist', staff('query.read'), ah(async (req, res) => {
  res.json(await db(req, async (tx) => {
    const q = await one(tx, 'SELECT * FROM queries WHERE id = $1', [req.params.id]);
    if (!q) throw notFound();
    const text = `${q.subject} ${q.description}`;
    const { getSetting } = await import('../services/settings.js');
    // Staff suggestions are advisory, so the gate is looser than the customer-facing one, but still drops noise
    const gate = Number(await getSetting(tx, 'assist.confidence_threshold')) * 0.55;
    const articles = (await retrieve(tx, text, 3)).filter((a) => a.score >= gate);
    const resolved = await many(tx,
      `SELECT id, reference, subject, description, resolution_note, resolved_at FROM queries
        WHERE resolution_note IS NOT NULL AND id <> $1 AND (query_type_key = $2 OR $2 IS NULL) ORDER BY resolved_at DESC LIMIT 300`, [q.id, q.query_type_key]);
    const corpus = resolved.map((r) => `${r.subject} ${r.description}`);
    const similar = resolved.map((r) => ({ ...r, score: similarity(text, `${r.subject} ${r.description}`, corpus) }))
      .filter((r) => r.score > 0.2).sort((a, b) => b.score - a.score).slice(0, 3)
      .map((r) => ({ id: r.id, reference: r.reference, subject: r.subject, resolution_note: r.resolution_note, score: Number(r.score.toFixed(2)) }));
    const vessel = q.vessel_call_id ? await one(tx, 'SELECT * FROM vessel_calls WHERE id = $1', [q.vessel_call_id]) : null;
    const contact = q.contact_id ? await one(tx, 'SELECT name FROM contacts WHERE id = $1', [q.contact_id]) : null;
    const basis = similar[0]?.resolution_note ?? articles[0]?.passage ?? null;
    const draft = basis
      ? `Dear ${contact?.name?.split(' ')[0] ?? 'Customer'},\n\n${vessel ? `Regarding ${vessel.vessel_name}, voyage ${vessel.voyage_no}${vessel.berth ? ` (currently allocated to ${vessel.berth})` : ''}: ` : ''}${basis}\n\nKind regards,\n${req.ctx.actorName}\nNamport Customer Care`
      : null;
    return { draft, sources: [...articles.map((a) => ({ type: 'article', id: a.id, title: a.title, score: a.score })), ...similar.map((s) => ({ type: 'case', id: s.id, title: `${s.reference} — ${s.subject}`, score: s.score }))], similar_cases: similar, articles };
  }));
}));

queriesRouter.post('/:id/propose-knowledge', staff('kb.write', 'query.update'), ah(async (req, res) => {
  res.status(201).json(await db(req, (tx) => proposeFromQuery(tx, req.ctx, req.params.id)));
}));

queriesRouter.post('/:id/attachments', staff('query.update'), upload.single('file') as any, ah(async (req, res) => {
  if (!req.file) throw badRequest('Attach a file');
  res.status(201).json(await db(req, (tx) => storeAttachment(tx, req.ctx, req.file!, { query_id: req.params.id, visibility: req.body?.visibility === 'internal' ? 'internal' : 'public' })));
}));

queriesRouter.get('/:id/history', staff('query.read', 'audit.read'), ah(async (req, res) => {
  res.json(await db(req, async (tx) => {
    const q = await one(tx, 'SELECT id FROM queries WHERE id = $1', [req.params.id]);
    if (!q) throw notFound();
    return many(tx, `SELECT id, occurred_at, actor_type, actor_name, action, before, after FROM event_log WHERE entity = 'query' AND entity_id = $1 ORDER BY id`, [q.id]);
  }));
}));

export const attachmentsRouter = Router();
attachmentsRouter.get('/:id', ah(async (req, res) => {
  if (req.ctx.actorType === 'system') throw badRequest('Sign in to download attachments');
  const { meta, buffer } = await db(req, (tx) => readAttachment(tx, req.ctx, req.params.id));
  res.setHeader('Content-Type', meta.mime_type);
  res.setHeader('Content-Disposition', `${req.query.inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(meta.filename)}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(buffer);
}));

export { buildQueryWhere };
