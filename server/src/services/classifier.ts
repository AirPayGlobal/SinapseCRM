import { many, one, type Tx } from '../db/pool.js';
import { escapeRegex, NaiveBayes, sentiment } from '../lib/text.js';
import { getSetting } from './settings.js';

/**
 * The AI layer's intake models.
 *  - Query-type classifier: proposes type (→ department, workflow, queue). Trained from the
 *    administrator-maintained examples on each query type plus every agent-confirmed case, so each
 *    override is training signal (QMC-03).
 *  - Irrelevant-traffic filter (QMC-05): deterministic keyword rules seeded with CV, job application,
 *    vacancy, donations, apprenticeship; behind it an intent classifier that recognises the same
 *    categories worded differently. Released/confirmed items retrain it.
 *  - Urgency and sentiment detection feed escalation.
 */

const IRRELEVANT_SEED: Record<string, string[]> = {
  recruitment: [
    'please find attached my curriculum vitae for any available position',
    'I am writing to apply for employment at Namport',
    'I would like to be considered for an internship or graduate programme',
    'are you hiring? I am a qualified crane operator looking for work',
    'kindly consider my application for a learnership in marine engineering',
    'I am unemployed and looking for a job opportunity at the port',
    'attached is my resume and certified copies of my qualifications',
    'request for vacation work or job shadowing at the harbour',
  ],
  donation: [
    'request for sponsorship of our school sports day',
    'we are requesting a donation for our community soup kitchen',
    'kindly sponsor our charity golf day fundraising event',
    'appeal for financial assistance for our church project',
    'request for corporate social responsibility funding for our NGO',
  ],
  relevant: [
    'container release delayed at the terminal please advise',
    'berth allocation for our vessel has changed',
    'invoice for cargo dues appears incorrect',
    'request for tariff clarification on reefer plug charges',
    'access permit for our truck driver to enter the port',
    'vessel arrival schedule and berthing window',
    'customs hold on our import containers',
    'query about storage charges on transhipment cargo',
    'damage to cargo during discharge claim',
    'billing account statement request',
    'our truck was turned away at the gate',
    'request to update company contact details',
  ],
};

let cache: { at: number; version: number; types: NaiveBayes; filter: NaiveBayes } | null = null;
let modelVersion = 0;

/** Called when a classification is confirmed/overridden or a filter decision is reviewed. */
export function invalidateModels() {
  modelVersion++;
}

async function models(tx: Tx) {
  if (cache && cache.version === modelVersion && Date.now() - cache.at < 5 * 60_000) return cache;
  const types = new NaiveBayes();
  const qts = await many<{ key: string; name: string; training_examples: string[] }>(
    tx, 'SELECT key, name, training_examples FROM query_types WHERE active',
  );
  for (const t of qts) {
    types.train(t.key, t.name, 2);
    for (const ex of t.training_examples) types.train(t.key, ex, 2);
  }
  const confirmed = await many<{ query_type_key: string; text: string }>(
    tx,
    `SELECT query_type_key, subject || ' ' || left(description, 2000) AS text FROM queries
      WHERE classification_confirmed AND query_type_key IS NOT NULL ORDER BY created_at DESC LIMIT 3000`,
  );
  for (const c of confirmed) types.train(c.query_type_key, c.text, 1);

  const filter = new NaiveBayes();
  for (const [label, exs] of Object.entries(IRRELEVANT_SEED)) for (const ex of exs) filter.train(label, ex, 2);
  for (const t of qts) for (const ex of t.training_examples) filter.train('relevant', ex, 1);
  const reviewed = await many<{ kind: string; text: string; category: string | null }>(
    tx,
    `SELECT s.kind, q.subject || ' ' || left(q.description, 2000) AS text, s.final->>'category' AS category
       FROM classification_signals s JOIN queries q ON q.id = s.query_id
      WHERE s.kind IN ('filter_release','filter_confirm') ORDER BY s.created_at DESC LIMIT 2000`,
  );
  for (const r of reviewed) filter.train(r.kind === 'filter_release' ? 'relevant' : (r.category ?? 'recruitment'), r.text, 3);

  cache = { at: Date.now(), version: modelVersion, types, filter };
  return cache;
}

export interface FilterVerdict {
  filtered: boolean;
  reason: string | null;
  category: string | null;
  layer: 'rule' | 'classifier' | null;
  confidence: number;
}

export async function evaluateFilter(tx: Tx, text: string): Promise<FilterVerdict> {
  const rules = await many<{ pattern: string; category: string }>(tx, 'SELECT pattern, category FROM filter_rules WHERE active');
  for (const r of rules) {
    const re = new RegExp(`\\b${escapeRegex(r.pattern)}\\b`, 'i');
    if (re.test(text)) return { filtered: true, reason: `Matched keyword rule "${r.pattern}"`, category: r.category, layer: 'rule', confidence: 1 };
  }
  const { filter } = await models(tx);
  const [best] = filter.predict(text);
  const threshold = await getSetting<number>(tx, 'filter.classifier_threshold');
  if (best && best.label !== 'relevant' && best.p >= threshold) {
    return { filtered: true, reason: `Intent classifier: ${best.label} (${Math.round(best.p * 100)}%)`, category: best.label, layer: 'classifier', confidence: best.p };
  }
  return { filtered: false, reason: null, category: null, layer: null, confidence: best?.label === 'relevant' ? best.p : 1 - (best?.p ?? 0) };
}

const URGENT = /\b(urgent|urgently|asap|immediately|emergency|critical|vessel (is )?waiting|demurrage|detention|stuck|blocked|stopped|safety|injur|spill|fire)\b/i;
const HIGH = /\b(today|tonight|delay(ed)?|escalat|third time|again|still (not|waiting)|penalt)/i;

export function detectUrgency(text: string, tier?: string | null, senti = 0): 'low' | 'normal' | 'high' | 'critical' {
  if (/\b(spill|fire|injur|safety incident|collision)\b/i.test(text)) return 'critical';
  if (URGENT.test(text)) return tier === 'top10' ? 'critical' : 'high';
  if (HIGH.test(text) || senti < -0.4) return 'high';
  if (/\b(no rush|whenever|for information|fyi)\b/i.test(text)) return 'low';
  return 'normal';
}

export interface Classification {
  query_type: string | null;
  confidence: number;
  alternatives: { query_type: string; confidence: number }[];
  urgency: 'low' | 'normal' | 'high' | 'critical';
  department_id: string | null;
  sentiment: number;
  auto_accepted: boolean;
}

export async function classify(tx: Tx, text: string, tier?: string | null): Promise<Classification> {
  const { types } = await models(tx);
  const preds = types.predict(text);
  const best = preds[0];
  const senti = sentiment(text);
  const dept = best ? await one<{ department_id: string }>(tx, 'SELECT department_id FROM query_types WHERE key = $1', [best.label]) : null;
  const autoAccept = await getSetting<number>(tx, 'classifier.auto_accept_confidence');
  return {
    query_type: best?.label ?? null,
    confidence: Number((best?.p ?? 0).toFixed(3)),
    alternatives: preds.slice(1, 4).map((p) => ({ query_type: p.label, confidence: Number(p.p.toFixed(3)) })),
    urgency: detectUrgency(text, tier, senti),
    department_id: dept?.department_id ?? null,
    sentiment: Number(senti.toFixed(3)),
    auto_accepted: Boolean(best && best.p >= autoAccept),
  };
}

/** Classification accuracy for the governance console: agreement of prediction with final decision. */
export async function classificationAccuracy(tx: Tx, days = 30) {
  return one(
    tx,
    `SELECT count(*)::int AS reviewed,
            count(*) FILTER (WHERE NOT overridden)::int AS agreed,
            CASE WHEN count(*) = 0 THEN NULL ELSE round(100.0 * count(*) FILTER (WHERE NOT overridden) / count(*), 1) END AS accuracy_percent
       FROM classification_signals WHERE kind = 'classification' AND created_at > now() - ($1 || ' days')::interval`,
    [String(days)],
  );
}
