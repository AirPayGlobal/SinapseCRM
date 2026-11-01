import { Router } from 'express';
import { ah, db, qp, staff } from '../lib/http.js';
import { createArticle, gapReport, getArticle, listArticles, setArticleState, updateArticle } from '../services/kb.js';
import { classificationAccuracy } from '../services/classifier.js';
import { deflection } from '../services/assist.js';
import { many } from '../db/pool.js';
import { badRequest } from '../lib/errors.js';

export const kbRouter = Router();

kbRouter.get('/articles', staff('query.read', 'kb.write'), ah(async (req, res) => res.json(await db(req, (tx) => listArticles(tx, qp(req))))));
kbRouter.post('/articles', staff('kb.write'), ah(async (req, res) => res.status(201).json(await db(req, (tx) => createArticle(tx, req.ctx, req.body ?? {})))));
kbRouter.get('/articles/:id', staff('query.read', 'kb.write'), ah(async (req, res) => res.json(await db(req, (tx) => getArticle(tx, req.params.id)))));
kbRouter.patch('/articles/:id', staff('kb.write'), ah(async (req, res) => res.json(await db(req, (tx) => updateArticle(tx, req.ctx, req.params.id, req.body ?? {})))));
kbRouter.post('/articles/:id/state', staff('kb.write', 'kb.publish'), ah(async (req, res) => {
  if (!['review', 'published', 'archived', 'draft'].includes(req.body?.to)) throw badRequest('Invalid state');
  res.json(await db(req, (tx) => setArticleState(tx, req.ctx, req.params.id, req.body.to)));
}));
kbRouter.get('/gaps', staff('kb.write'), ah(async (req, res) => res.json(await db(req, (tx) => gapReport(tx)))));
kbRouter.post('/gaps/dismiss', staff('kb.write'), ah(async (req, res) => {
  await db(req, (tx) => tx.query(`UPDATE knowledge_gaps SET status = 'dismissed' WHERE id = ANY($1)`, [req.body?.ids ?? []]));
  res.status(204).end();
}));
kbRouter.post('/gaps/link', staff('kb.write'), ah(async (req, res) => {
  await db(req, (tx) => tx.query(`UPDATE knowledge_gaps SET article_id = $2 WHERE id = ANY($1)`, [req.body?.ids ?? [], req.body?.article_id]));
  res.status(204).end();
}));

/** AI governance console: confidence distribution, classification accuracy, deflection, conversation audit. */
kbRouter.get('/governance', staff('kb.publish', 'admin.config'), ah(async (req, res) => {
  res.json(await db(req, async (tx) => {
    const turns = await many(tx,
      `SELECT (t->>'confidence')::numeric AS confidence, t->>'intent' AS intent
         FROM assist_sessions s, jsonb_array_elements(s.turns) t
        WHERE t->>'role' = 'assist' AND s.created_at > now() - interval '30 days'`);
    const buckets = Array.from({ length: 10 }, (_, i) => ({ bucket: `${i * 10}–${i * 10 + 10}%`, answered: 0, declined: 0 }));
    for (const t of turns) {
      if (t.confidence == null) continue;
      const b = buckets[Math.min(9, Math.floor(Number(t.confidence) * 10))];
      if (t.intent === 'answered') b.answered++; else b.declined++;
    }
    const intents = await many(tx,
      `SELECT t->>'intent' AS intent, count(*)::int AS n FROM assist_sessions s, jsonb_array_elements(s.turns) t
        WHERE t->>'role' = 'assist' AND s.created_at > now() - interval '30 days' GROUP BY 1 ORDER BY 2 DESC`);
    const { getSetting } = await import('../services/settings.js');
    return {
      confidence_threshold: await getSetting(tx, 'assist.confidence_threshold'),
      grounding_mode: 'retrieval-only — answers composed exclusively from published articles, with citation',
      locked_safeguards: [
        'Never answers outside the approved knowledge base',
        'Never quotes tariffs, commits to dates or interprets contracts',
        'Never acts for an unauthenticated customer or shows data they may not see',
        'Never learns without a named Namport approver publishing the article',
        'Stops the moment a customer asks for a person',
      ],
      confidence_distribution: buckets, intents,
      classification: await classificationAccuracy(tx), deflection: await deflection(tx),
      model: { retrieval: 'PostgreSQL full-text recall + TF-IDF re-rank', classifier: 'Multinomial naive Bayes trained on agent-confirmed cases', phrasing: process.env.ANTHROPIC_API_KEY ? `Claude (${process.env.ASSIST_MODEL ?? 'claude-opus-5-5'}) constrained to retrieved passages` : 'Extractive (no LLM configured)' },
    };
  }));
}));

kbRouter.get('/conversations', staff('kb.publish', 'audit.read'), ah(async (req, res) => {
  const f = qp(req);
  res.json(await db(req, (tx) => many(tx,
    `SELECT s.id, s.channel, s.outcome, s.created_at, s.updated_at, jsonb_array_length(s.turns) AS turns, c.name AS contact_name,
            q1.reference AS created_reference, q2.reference AS handed_over_reference, s.turns AS transcript
       FROM assist_sessions s LEFT JOIN contacts c ON c.id = s.contact_id
       LEFT JOIN queries q1 ON q1.id = s.created_query_id LEFT JOIN queries q2 ON q2.id = s.handed_over_query_id
      WHERE ($1::text IS NULL OR s.outcome = $1) ORDER BY s.updated_at DESC LIMIT 100`, [f.outcome ?? null])));
}));

kbRouter.get('/classification-review', staff('kb.publish', 'admin.config', 'query.reassign'), ah(async (req, res) => {
  res.json(await db(req, (tx) => many(tx,
    `SELECT s.id, s.created_at, s.predicted, s.final, s.overridden, s.kind, q.reference, q.subject, u.name AS actor_name
       FROM classification_signals s JOIN queries q ON q.id = s.query_id LEFT JOIN users u ON u.id = s.actor_id
      WHERE s.overridden ORDER BY s.created_at DESC LIMIT 100`)));
}));
