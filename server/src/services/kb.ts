import { many, one, type Tx } from '../db/pool.js';
import { audit, diff } from '../lib/audit.js';
import { can, type Ctx } from '../lib/context.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { cosine, normalizeQuestion, sentences, TfIdf, tokenize } from '../lib/text.js';

/**
 * Knowledge base owned by Namport administrators (CB-01.6): draft → review → published, with a
 * named approver. Sinapse Assist proposes learning as drafts; it never publishes anything itself.
 */

export async function listArticles(tx: Tx, f: { state?: string; q?: string; category?: string }) {
  const p: unknown[] = [];
  const where: string[] = [];
  if (f.state) { p.push(f.state); where.push(`a.state = $${p.length}`); }
  if (f.category) { p.push(f.category); where.push(`a.category = $${p.length}`); }
  if (f.q) { p.push(f.q); where.push(`(a.search @@ websearch_to_tsquery('english', $${p.length}) OR a.title ILIKE '%' || $${p.length} || '%')`); }
  return many(
    tx,
    `SELECT a.id, a.title, a.category, a.audience_scope, a.state, a.version, a.proposed_by_assist, a.answered_count, a.helpful_count,
            a.published_at, a.updated_at, au.name AS author_name, ap.name AS approved_by_name, left(a.body, 240) AS excerpt
       FROM knowledge_articles a LEFT JOIN users au ON au.id = a.author_id LEFT JOIN users ap ON ap.id = a.approved_by
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.state = 'published' DESC, a.updated_at DESC`,
    p,
  );
}

export async function getArticle(tx: Tx, id: string) {
  const a = await one(tx, `SELECT a.*, au.name AS author_name, ap.name AS approved_by_name, q.reference AS source_query_reference
    FROM knowledge_articles a LEFT JOIN users au ON au.id = a.author_id LEFT JOIN users ap ON ap.id = a.approved_by
    LEFT JOIN queries q ON q.id = a.source_query_id WHERE a.id = $1`, [id]);
  if (!a) throw notFound('Article not found');
  delete a.search;
  return a;
}

export async function createArticle(tx: Tx, ctx: Ctx, input: { title: string; body: string; category?: string; audience_scope?: string; department_id?: string }) {
  if (!input.title?.trim() || !input.body?.trim()) throw badRequest('Title and body are required');
  const a = await one(tx,
    `INSERT INTO knowledge_articles (title, body, category, audience_scope, department_id, author_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, title, state`,
    [input.title.trim(), input.body.trim(), input.category ?? null, input.audience_scope ?? 'public', input.department_id ?? null, ctx.actorId]);
  await audit(tx, ctx, 'kb.created', 'knowledge_article', a.id, undefined, a);
  return a;
}

export async function updateArticle(tx: Tx, ctx: Ctx, id: string, patch: Record<string, any>) {
  const a = await one(tx, 'SELECT * FROM knowledge_articles WHERE id = $1 FOR UPDATE', [id]);
  if (!a) throw notFound('Article not found');
  const next: Record<string, any> = {};
  for (const k of ['title', 'body', 'category', 'audience_scope', 'department_id']) if (k in patch) next[k] = patch[k];
  const d = diff(a, next);
  if (!d.changed) return a;
  // Editing published content creates a new draft version; the published article stays live
  // (and keeps answering customers) until the revision is approved.
  if (a.state === 'published' && ('body' in d.after || 'title' in d.after)) {
    const rev = await one(tx,
      `INSERT INTO knowledge_articles (title, body, category, audience_scope, department_id, author_id, version, state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'draft') RETURNING id, title, state, version`,
      [next.title ?? a.title, next.body ?? a.body, next.category ?? a.category, next.audience_scope ?? a.audience_scope, next.department_id ?? a.department_id, ctx.actorId, a.version + 1]);
    await audit(tx, ctx, 'kb.revision_created', 'knowledge_article', rev.id, undefined, { revises: id });
    await tx.query(`UPDATE knowledge_articles SET source_query_id = $2 WHERE id = $1`, [rev.id, a.source_query_id]);
    return { ...rev, revises: id };
  }
  const keys = Object.keys(d.after);
  await tx.query(`UPDATE knowledge_articles SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`, [id, ...keys.map((k) => d.after[k])]);
  await audit(tx, ctx, 'kb.updated', 'knowledge_article', id, d.before, d.after);
  return getArticle(tx, id);
}

export async function setArticleState(tx: Tx, ctx: Ctx, id: string, to: 'review' | 'published' | 'archived' | 'draft') {
  const a = await one(tx, 'SELECT * FROM knowledge_articles WHERE id = $1 FOR UPDATE', [id]);
  if (!a) throw notFound('Article not found');
  const allowed: Record<string, string[]> = { draft: ['review', 'archived'], review: ['published', 'draft', 'archived'], published: ['archived'], archived: ['draft'] };
  if (!allowed[a.state]?.includes(to)) throw conflict(`An article cannot move from ${a.state} to ${to}`);
  if (to === 'published') {
    if (!can(ctx, 'kb.publish')) throw forbidden('Only a named Namport approver can publish knowledge');
    if (a.author_id && a.author_id === ctx.actorId && !can(ctx, '*')) throw forbidden('An article must be approved by someone other than its author');
    // Publishing a revision retires the version it replaces
    await tx.query(`UPDATE knowledge_articles SET state = 'archived', updated_at = now()
                     WHERE id <> $1 AND state = 'published' AND title = $2 AND version < $3`, [id, a.title, a.version]);
  }
  await tx.query(
    `UPDATE knowledge_articles SET state = $2, updated_at = now(),
            approved_by = CASE WHEN $2 = 'published' THEN $3 ELSE approved_by END,
            published_at = CASE WHEN $2 = 'published' THEN now() ELSE published_at END WHERE id = $1`,
    [id, to, ctx.actorId],
  );
  if (to === 'published') await tx.query(`UPDATE knowledge_gaps SET status = 'addressed' WHERE article_id = $1`, [id]);
  await audit(tx, ctx, 'kb.state_changed', 'knowledge_article', id, { state: a.state }, { state: to });
  return getArticle(tx, id);
}

/** Learning proposed for human approval: a resolved case becomes a draft article, never a published one. */
export async function proposeFromQuery(tx: Tx, ctx: Ctx, queryId: string) {
  const q = await one(tx, `SELECT q.*, qt.name AS type_name FROM queries q LEFT JOIN query_types qt ON qt.key = q.query_type_key WHERE q.id = $1`, [queryId]);
  if (!q) throw notFound('Query not found');
  if (!q.resolution_note) throw badRequest('Only resolved cases with a resolution note can be proposed as knowledge');
  const a = await one(tx,
    `INSERT INTO knowledge_articles (title, body, category, audience_scope, department_id, source_query_id, proposed_by_assist, author_id)
     VALUES ($1,$2,$3,'public',$4,$5,true,$6) RETURNING id, title, state`,
    [q.subject, `${q.resolution_note}`, q.type_name, q.department_id, q.id, ctx.actorId]);
  await audit(tx, ctx, 'kb.proposed', 'knowledge_article', a.id, undefined, { source_query: q.reference });
  return a;
}

export async function recordGap(tx: Tx, question: string) {
  const norm = normalizeQuestion(question);
  if (!norm) return;
  await tx.query(
    `INSERT INTO knowledge_gaps (normalized, sample_question) VALUES ($1,$2)
     ON CONFLICT (normalized) DO UPDATE SET ask_count = knowledge_gaps.ask_count + 1, last_asked_at = now(),
            status = CASE WHEN knowledge_gaps.status = 'dismissed' THEN 'dismissed' ELSE 'open' END`,
    [norm, question.slice(0, 500)],
  );
}

/** Knowledge-gap report: questions Assist repeatedly failed to answer, clustered and ranked. */
export async function gapReport(tx: Tx) {
  const rows = await many<{ id: string; normalized: string; sample_question: string; ask_count: number; last_asked_at: string; status: string }>(
    tx, `SELECT id, normalized, sample_question, ask_count, last_asked_at, status FROM knowledge_gaps WHERE status = 'open' ORDER BY ask_count DESC, last_asked_at DESC LIMIT 500`,
  );
  const tf = new TfIdf(rows.map((r) => r.sample_question));
  const clusters: { lead: typeof rows[number]; members: typeof rows; total: number }[] = [];
  for (const r of rows) {
    const v = tf.vector(r.sample_question);
    const home = clusters.find((c) => cosine(tf.vector(c.lead.sample_question), v) >= 0.5);
    if (home) { home.members.push(r); home.total += r.ask_count; } else clusters.push({ lead: r, members: [r], total: r.ask_count });
  }
  return clusters.sort((a, b) => b.total - a.total).map((c) => ({
    question: c.lead.sample_question, total_asks: c.total, variants: c.members.length, gap_ids: c.members.map((m) => m.id),
    examples: c.members.slice(0, 5).map((m) => m.sample_question), last_asked_at: c.members.map((m) => m.last_asked_at).sort().at(-1),
  }));
}

export interface Retrieved { id: string; title: string; body: string; category: string | null; score: number; passage: string }

/**
 * Retrieval over approved knowledge (and, for staff, resolved cases). Postgres full-text search
 * recalls candidates; TF-IDF cosine plus term coverage re-ranks and produces a calibrated confidence.
 * Access is enforced by row-level security: customers can only retrieve published, customer-facing articles.
 */
export async function retrieve(tx: Tx, question: string, limit = 3): Promise<Retrieved[]> {
  const toks = [...new Set(tokenize(question))].filter((t) => /^[a-z0-9]+$/.test(t));
  if (!toks.length) return [];
  const cands = await many<{ id: string; title: string; body: string; category: string | null; rank: number }>(
    tx,
    `SELECT id, title, body, category, ts_rank_cd(search, to_tsquery('english', $1)) AS rank
       FROM knowledge_articles WHERE state = 'published' AND search @@ to_tsquery('english', $1)
      ORDER BY rank DESC LIMIT 20`,
    [toks.map((t) => `${t}:*`).join(' | ')],
  );
  if (!cands.length) return [];
  const tf = new TfIdf(cands.map((c) => `${c.title} ${c.title} ${c.body}`));
  const qv = tf.vector(question);
  const scored = cands.map((c) => {
    const docTokens = new Set(tokenize(`${c.title} ${c.body}`));
    const coverage = toks.filter((t) => [...docTokens].some((d) => d.startsWith(t) || t.startsWith(d))).length / toks.length;
    const cos = cosine(qv, tf.vector(`${c.title} ${c.title} ${c.body}`));
    // best supporting passage: sentences most similar to the question
    const sents = sentences(c.body);
    const ranked = sents.map((s, i) => ({ s, i, sc: cosine(qv, tf.vector(s)) })).sort((a, b) => b.sc - a.sc);
    const keep = ranked.slice(0, 3).filter((r) => r.sc > 0).sort((a, b) => a.i - b.i).map((r) => r.s);
    return { id: c.id, title: c.title, body: c.body, category: c.category, score: Number((0.55 * cos + 0.45 * coverage).toFixed(3)), passage: (keep.length ? keep : sents.slice(0, 2)).join(' ') };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}
