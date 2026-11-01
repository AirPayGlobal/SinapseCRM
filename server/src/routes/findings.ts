import { Router } from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { badRequest } from '../lib/errors.js';
import { ah, db, qp, staff } from '../lib/http.js';
import { storeAttachment } from '../services/attachments.js';
import { addTask, createFinding, detectRecurrence, getFinding, listFindings, transitionFinding, updateFinding, updateTask } from '../services/findings.js';
import { many, one } from '../db/pool.js';

export const findingsRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadBytes } });

findingsRouter.get('/', staff('finding.read'), ah(async (req, res) => {
  const f = qp(req);
  res.json(await db(req, (tx) => listFindings(tx, { ...f, overdue: f.overdue === 'true', owner_id: f.mine === 'true' ? req.ctx.actorId! : f.owner_id })));
}));
findingsRouter.get('/types', staff('finding.read'), ah(async (req, res) => {
  res.json(await db(req, (tx) => many(tx, 'SELECT * FROM finding_types ORDER BY name')));
}));
findingsRouter.post('/check-recurrence', staff('finding.write'), ah(async (req, res) => {
  res.json(await db(req, (tx) => detectRecurrence(tx, req.body?.title ?? '', req.body?.description ?? '')));
}));
findingsRouter.post('/', staff('finding.write'), ah(async (req, res) => {
  res.status(201).json(await db(req, (tx) => createFinding(tx, req.ctx, req.body ?? {})));
}));
findingsRouter.get('/:id', staff('finding.read'), ah(async (req, res) => {
  res.json(await db(req, (tx) => getFinding(tx, req.params.id)));
}));
findingsRouter.patch('/:id', staff('finding.write'), ah(async (req, res) => {
  res.json(await db(req, (tx) => updateFinding(tx, req.ctx, req.params.id, req.body ?? {})));
}));
findingsRouter.post('/:id/transition', staff('finding.read'), ah(async (req, res) => {
  res.json(await db(req, (tx) => transitionFinding(tx, req.ctx, req.params.id, req.body?.to, req.body?.note)));
}));
findingsRouter.post('/:id/tasks', staff('finding.write'), ah(async (req, res) => {
  res.status(201).json(await db(req, (tx) => addTask(tx, req.ctx, req.params.id, req.body ?? {})));
}));
findingsRouter.patch('/tasks/:taskId', staff('finding.read'), ah(async (req, res) => {
  res.json(await db(req, (tx) => updateTask(tx, req.ctx, req.params.taskId, req.body ?? {})));
}));
/** Evidence of closure attached to the finding or directly to a remediation task. */
findingsRouter.post('/:id/evidence', staff('finding.read'), upload.single('file') as any, ah(async (req, res) => {
  if (!req.file) throw badRequest('Attach a file');
  res.status(201).json(await db(req, async (tx) => {
    const f = await one(tx, 'SELECT id FROM findings WHERE id = $1', [req.params.id]);
    if (!f) throw badRequest('Finding not found');
    const a = await storeAttachment(tx, req.ctx, req.file!, { finding_id: req.params.id, task_id: req.body?.task_id ?? null, visibility: 'internal' });
    if (req.body?.task_id) await updateTask(tx, req.ctx, req.body.task_id, { evidence_attachment_id: a.id });
    return a;
  }));
}));
