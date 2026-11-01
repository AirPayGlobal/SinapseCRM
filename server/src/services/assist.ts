import { asSystem, many, one, type Tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import type { Ctx } from '../lib/context.js';
import { badRequest, notFound } from '../lib/errors.js';
import { sentiment, similarity } from '../lib/text.js';
import { intake } from './intake.js';
import { recordGap, retrieve } from './kb.js';
import { phraseGroundedAnswer } from './llm.js';
import { notify, raiseAlert } from './notifications.js';
import { REFERENCE_PATTERN } from './reference.js';
import { getSetting } from './settings.js';

/**
 * Sinapse Assist — an agent, not a chatbot (CB-01 .. CB-01.6). It answers only from approved
 * knowledge with the source shown, declines rather than guesses, acts through the same services
 * the console uses (so every action has the same permissions and audit trail), and hands over to
 * a person carrying the whole conversation and what it already attempted.
 *
 * Hard-locked safeguards (cannot be configured off):
 *   1. never answers outside the approved knowledge base;
 *   2. never quotes tariffs, commits to dates or interprets contractual terms — routes to a person;
 *   3. never acts for an unauthenticated customer or surfaces data the customer may not see
 *      (enforced by row-level security on every read);
 *   4. never learns without a named Namport approver publishing the article;
 *   5. stops the moment a customer asks for a person.
 */

export interface AssistTurn {
  role: 'customer' | 'assist';
  text: string;
  at: string;
  intent?: string;
  confidence?: number;
  sources?: { id: string; title: string }[];
  action?: Record<string, unknown>;
}

export interface AssistReply {
  session_id: string;
  reply: string;
  intent: string;
  confidence: number | null;
  sources: { id: string; title: string; score: number }[];
  action: null | { type: 'case_created' | 'handover' | 'status' | 'info_added' | 'escalation_requested' | 'reference_lookup' | 'routed' | 'offer_case'; reference?: string; references?: string[]; department?: string; queryType?: string; reason?: string };
  suggestions: string[];
}

const GUARDRAILS: { key: string; re: RegExp; reply: string; department: string; queryType: string }[] = [
  {
    key: 'tariff', department: 'Commercial', queryType: 'tariff',
    re: /\b(tariff|tariffs|price|pricing|rate card|rates|how much (does|do|will|is)|cost of|quote|quotation|discount)\b/i,
    reply: 'I can\'t quote tariffs or charges — those must come from our Commercial team so that the figure you receive is authoritative.',
  },
  {
    key: 'commitment', department: 'Operations', queryType: 'vessel_operations',
    re: /\b(guarantee|promise|commit|confirm (that|the) .* (will|by)|will .* be (released|berthed|ready|delivered) by|exact (time|date))\b/i,
    reply: 'I can\'t commit Namport to a date or time — an agent with access to the live operational plan needs to confirm that for you.',
  },
  {
    key: 'contract', department: 'Legal & Compliance', queryType: 'general',
    re: /\b(contract|agreement|clause|liabilit|indemn|legal|lawyer|claim against|breach of)\b/i,
    reply: 'I can\'t interpret contractual or legal terms — that needs a person in the relevant team.',
  },
];

const HUMAN_RE = /\b(speak|talk|chat|connect|transfer|put)\b.{0,12}\b(to|with)\b.{0,8}\b(a |an )?(human|person|someone|somebody|agent|operator|representative|consultant)\b|\b(real|actual|live) (person|human|agent)\b|\bhuman\b|\bcall me( back)?\b|\bi want (a|an) (person|agent|human)\b/i;
const CREATE_RE = /\b(log|raise|open|create|submit|lodge|report)\b.*\b(query|case|complaint|ticket|request|issue|problem)\b/i;
const LOST_REF_RE = /\b(lost|forgot|forgotten|don'?t have|can'?t find|cannot find|what is|which is)\b.*\b(reference|ticket|case number|number)\b/i;
const ESCALATE_RE = /\b(escalate|escalation|urgent attention|manager|supervisor)\b/i;
const ADD_INFO_RE = /\b(add|attach|update|more information|additional|also)\b/i;
const YES_RE = /^\s*(yes|yes please|please do|ok|okay|sure|go ahead|do it|y)\b/i;

async function loadSession(tx: Tx, ctx: Ctx, sessionId: string | null, channel: string) {
  // Session persistence is engine work; what the customer can *see* is still governed by their scope.
  return asSystem(tx, () => loadSessionInner(tx, ctx, sessionId, channel));
}

async function loadSessionInner(tx: Tx, ctx: Ctx, sessionId: string | null, channel: string) {
  if (sessionId) {
    const s = await one(tx, 'SELECT * FROM assist_sessions WHERE id = $1', [sessionId]);
    if (s && (s.contact_id ?? null) === (ctx.customer?.id ?? null)) return s;
  }
  return one(tx,
    `INSERT INTO assist_sessions (contact_id, company_id, channel) VALUES ($1,$2,$3) RETURNING *`,
    [ctx.customer?.id ?? null, ctx.customer?.companies[0]?.companyId ?? null, channel]);
}

function transcript(turns: AssistTurn[]) {
  return turns.map((t) => `${t.role === 'customer' ? 'Customer' : 'Assist'} (${t.at.slice(11, 16)}): ${t.text}`).join('\n');
}

function attempted(turns: AssistTurn[]) {
  const a = turns.filter((t) => t.role === 'assist' && t.intent).map((t) =>
    `${t.intent}${t.confidence != null ? ` (confidence ${Math.round(t.confidence * 100)}%)` : ''}${t.sources?.length ? ` using ${t.sources.map((s) => `"${s.title}"`).join(', ')}` : ''}`);
  return a.length ? a.join('; ') : 'no answer attempted';
}

async function save(tx: Tx, session: any, turns: AssistTurn[], outcome?: string, extra: Record<string, string | null> = {}) {
  await asSystem(tx, () => tx.query(
    `UPDATE assist_sessions SET turns = $2, outcome = coalesce($3, outcome), updated_at = now(),
            created_query_id = coalesce($4, created_query_id), handed_over_query_id = coalesce($5, handed_over_query_id)
      WHERE id = $1`,
    [session.id, JSON.stringify(turns), outcome ?? null, extra.created ?? null, extra.handed ?? null],
  ));
}

/** Hand over to a person: create a case carrying the whole conversation and what was attempted. */
async function handover(tx: Tx, ctx: Ctx, turns: AssistTurn[], reason: string, opts: { visitor?: { name?: string; email?: string }; department?: string; queryType?: string; urgency?: 'high' | 'normal' } = {}) {
  const firstQuestion = turns.find((t) => t.role === 'customer')?.text ?? 'Customer conversation';
  const subject = firstQuestion.length > 90 ? `${firstQuestion.slice(0, 87)}…` : firstQuestion;
  const r = await intake(tx, { ...ctx, actorType: 'assist', actorName: 'Sinapse Assist' }, {
    channel: 'assist',
    subject,
    body: turns.filter((t) => t.role === 'customer').map((t) => t.text).join('\n\n'),
    contactId: ctx.customer?.id ?? null,
    companyId: ctx.customer?.companies[0]?.companyId ?? null,
    from: opts.visitor?.email ? { email: opts.visitor.email, name: opts.visitor.name } : undefined,
    queryTypeKey: opts.queryType,
    urgency: opts.urgency,
    transcript: transcript(turns),
  });
  await asSystem(tx, () => tx.query(
    `INSERT INTO interactions (query_id, company_id, contact_id, channel, direction, visibility, body, actor_type, actor_name)
     VALUES ($1,$2,$3,'assist','internal','internal',$4,'assist','Sinapse Assist')`,
    [r.query.id, r.query.company_id, r.query.contact_id,
     `Handover from Sinapse Assist — reason: ${reason}.\nWhat Assist already attempted: ${attempted(turns)}.\nThe full conversation is on this case; the customer should not need to repeat themselves.`],
  ));
  return r.query;
}

export async function converse(
  tx: Tx, ctx: Ctx,
  input: { session_id?: string | null; message: string; channel?: 'portal' | 'website' | 'email'; visitor?: { name?: string; email?: string } },
): Promise<AssistReply> {
  const message = (input.message ?? '').trim();
  if (!message) throw badRequest('Message is empty');
  if (message.length > 4000) throw badRequest('Message is too long');
  const session = await loadSession(tx, ctx, input.session_id ?? null, input.channel ?? 'portal');
  const turns: AssistTurn[] = session.turns ?? [];
  const now = () => new Date().toISOString();
  turns.push({ role: 'customer', text: message, at: now() });
  const authenticated = Boolean(ctx.customer);
  const canAct = authenticated || Boolean(input.visitor?.email);

  const respond = async (r: Omit<AssistReply, 'session_id' | 'suggestions'> & { suggestions?: string[] }, outcome?: string, extra: Record<string, string | null> = {}) => {
    turns.push({ role: 'assist', text: r.reply, at: now(), intent: r.intent, confidence: r.confidence ?? undefined, sources: r.sources.map((s) => ({ id: s.id, title: s.title })), action: r.action ?? undefined });
    await save(tx, session, turns, outcome, extra);
    await audit(tx, ctx, `assist.${r.intent}`, 'assist_session', session.id, undefined, { action: r.action, confidence: r.confidence });
    return { session_id: session.id, suggestions: r.suggestions ?? [], ...r };
  };
  const lastAssist = [...turns].reverse().find((t) => t.role === 'assist');

  // 5. Stops the moment a customer asks for a person. Frustration also hands over.
  const senti = sentiment(message);
  if (HUMAN_RE.test(message) || senti <= -0.5) {
    const reason = senti <= -0.5 ? 'customer frustration detected' : 'customer asked for a person';
    if (!canAct) {
      return respond({ reply: 'Of course. Please sign in to the Namport customer portal, or give me your email address, and I will pass this conversation to a customer care agent straight away. You can also call Namport Customer Care during business hours.', intent: 'handover_needs_identity', confidence: null, sources: [], action: null }, 'open');
    }
    const q = await handover(tx, ctx, turns, reason, { visitor: input.visitor, urgency: senti <= -0.5 ? 'high' : undefined });
    return respond({ reply: `I've passed this to a customer care agent with our whole conversation, so you won't need to repeat anything. Your reference is ${q.reference}.${q.first_response_due_at ? ` You can expect a response by ${fmt(q.first_response_due_at)}.` : ''}`,
      intent: 'handover', confidence: null, sources: [], action: { type: 'handover', reference: q.reference } }, 'handed_over', { handed: q.id });
  }

  // Accepting an earlier offer to open a case
  if (YES_RE.test(message) && lastAssist?.action?.type === 'offer_case') {
    const offer = lastAssist.action as { department?: string; queryType?: string; reason?: string };
    if (!canAct) return respond({ reply: 'Please sign in to the portal first so I can open a case in your company\'s name.', intent: 'needs_sign_in', confidence: null, sources: [], action: null });
    const q = await handover(tx, ctx, turns.slice(0, -1), offer.reason ?? 'customer accepted case creation', { visitor: input.visitor, queryType: offer.queryType });
    return respond({ reply: `Done — I've opened case ${q.reference}${offer.department ? ` and routed it to ${offer.department}` : ''}.${q.first_response_due_at ? ` You can expect a response by ${fmt(q.first_response_due_at)}.` : ''} You can follow it in the portal.`,
      intent: 'case_created', confidence: null, sources: [], action: { type: 'case_created', reference: q.reference } }, 'acted', { created: q.id });
  }

  // 2. Tariffs, date commitments and contract interpretation route to a person, every time.
  const guard = GUARDRAILS.find((g) => g.re.test(message));
  if (guard) {
    if (canAct) {
      return respond({ reply: `${guard.reply} Would you like me to open a case for ${guard.department}? Reply "yes" and I'll do it with this conversation attached.`,
        intent: `declined_${guard.key}`, confidence: null, sources: [],
        action: { type: 'offer_case', department: guard.department, queryType: guard.queryType, reason: `guardrail: ${guard.key}` }, suggestions: ['Yes, open a case'] }, 'declined');
    }
    return respond({ reply: `${guard.reply} Please sign in to the Namport customer portal and log a query, and the ${guard.department} team will respond.`, intent: `declined_${guard.key}`, confidence: null, sources: [], action: { type: 'routed', department: guard.department } }, 'declined');
  }

  // Track an existing case by reference (row-level security decides what the customer may see)
  const ref = message.toUpperCase().match(REFERENCE_PATTERN)?.[0];
  if (ref) {
    if (!authenticated) {
      return respond({ reply: `To protect your information I can only share the status of ${ref} once you are signed in to the customer portal.`, intent: 'track_needs_sign_in', confidence: null, sources: [], action: null });
    }
    const q = await one(tx, `SELECT q.id, q.reference, q.subject, q.state, q.first_response_due_at, q.first_responded_at, q.resolved_at, q.resolution_note,
                                    q.company_id, q.contact_id, q.assigned_to, w.definition FROM queries q JOIN workflow_definitions w ON w.id = q.workflow_definition_id WHERE q.reference = $1`, [ref]);
    if (!q) return respond({ reply: `I couldn't find a case ${ref} on your account. Please check the reference, or ask me to look it up by describing it.`, intent: 'track_not_found', confidence: null, sources: [], action: null });
    if (ESCALATE_RE.test(message)) {
      await asSystem(tx, async () => {
        await tx.query(`UPDATE queries SET urgency = CASE WHEN urgency IN ('low','normal') THEN 'high' ELSE urgency END WHERE id = $1`, [q.id]);
        await tx.query(`INSERT INTO interactions (query_id, company_id, contact_id, channel, direction, visibility, body, actor_type, actor_name)
                        VALUES ($1,$2,$3,'assist','inbound','public',$4,'assist','Sinapse Assist')`, [q.id, q.company_id, q.contact_id, `Customer requested escalation via Sinapse Assist: "${message}"`]);
        await raiseAlert(tx, { kind: 'escalation', message: `${q.reference}: customer requested escalation via Sinapse Assist`, queryId: q.id, targetRole: 'supervisor', dedupeKey: `assist-escalation:${q.id}:${new Date().toISOString().slice(0, 13)}` });
        if (q.assigned_to) await notify(tx, { template: 'customer_replied', to: { type: 'user', id: q.assigned_to }, vars: { reference: q.reference, query: q }, queryId: q.id, channels: ['in_app'] });
      });
      return respond({ reply: `I've recorded your request to escalate ${q.reference} and alerted a supervisor. The case keeps its full history.`, intent: 'escalation_requested', confidence: null, sources: [], action: { type: 'escalation_requested', reference: q.reference } }, 'acted');
    }
    if (ADD_INFO_RE.test(message) && message.replace(ref, '').trim().length > 25) {
      await intake(tx, { ...ctx, actorType: 'contact', actorId: ctx.customer!.id, actorName: ctx.customer!.name }, { channel: 'assist', subject: `Re: ${q.reference}`, body: message.replace(ref, '').trim(), contactId: ctx.customer!.id, companyId: q.company_id });
      return respond({ reply: `I've added that to ${q.reference}. The agent handling it has been notified.`, intent: 'info_added', confidence: null, sources: [], action: { type: 'info_added', reference: q.reference } }, 'acted');
    }
    const st = (q.definition.states as any[]).find((s) => s.key === q.state);
    const status = st?.customer_label ?? st?.label ?? q.state;
    let reply = `${q.reference} — "${q.subject}" — is currently: ${status}.`;
    if (q.resolved_at && q.resolution_note) reply += ` Outcome: ${q.resolution_note.slice(0, 300)}`;
    else if (!q.first_responded_at && q.first_response_due_at) reply += ` Our response target is ${fmt(q.first_response_due_at)}.`;
    return respond({ reply, intent: 'track', confidence: null, sources: [], action: { type: 'status', reference: q.reference } }, 'acted');
  }

  // Reference lookup by description, for the customer who has lost the number
  if (LOST_REF_RE.test(message)) {
    if (!authenticated) return respond({ reply: 'Sign in to the customer portal and I can find your case references for you — every case on your account is listed under "My queries".', intent: 'lookup_needs_sign_in', confidence: null, sources: [], action: null });
    const mine = await many(tx, `SELECT reference, subject, description, state, created_at FROM queries WHERE state NOT IN ('merged','filtered') ORDER BY created_at DESC LIMIT 100`);
    const ranked = mine.map((m) => ({ ...m, s: similarity(message, `${m.subject} ${m.description}`, mine.map((x) => x.subject)) })).sort((a, b) => b.s - a.s).slice(0, 3);
    if (!ranked.length) return respond({ reply: 'I couldn\'t find any cases on your account yet.', intent: 'reference_lookup', confidence: null, sources: [], action: null });
    return respond({
      reply: `These are the cases on your account that best match what you described:\n${ranked.map((r) => `• ${r.reference} — ${r.subject} (${new Date(r.created_at).toISOString().slice(0, 10)})`).join('\n')}`,
      intent: 'reference_lookup', confidence: null, sources: [], action: { type: 'reference_lookup', references: ranked.map((r) => r.reference) },
    }, 'acted');
  }

  // Explicit request to log a case
  if (CREATE_RE.test(message) && message.split(/\s+/).length > 6) {
    if (!canAct) return respond({ reply: 'I can log that for you once you sign in to the customer portal (or give me your email address on the website).', intent: 'needs_sign_in', confidence: null, sources: [], action: null });
    const q = await handover(tx, ctx, turns, 'customer asked Assist to log a case', { visitor: input.visitor });
    return respond({ reply: `I've logged your query. Your reference is ${q.reference}${q.first_response_due_at ? ` and you can expect a response by ${fmt(q.first_response_due_at)}` : ''}. I've attached our conversation so nobody will ask you to repeat yourself.`,
      intent: 'case_created', confidence: null, sources: [], action: { type: 'case_created', reference: q.reference } }, 'acted', { created: q.id });
  }

  // 1. Grounded answer from the approved knowledge base, or decline.
  const threshold = await getSetting<number>(tx, 'assist.confidence_threshold');
  const hits = await retrieve(tx, message, 3);
  const best = hits[0];
  if (best && best.score >= threshold) {
    const supporting = hits.filter((h) => h.score >= threshold * 0.9).slice(0, 2);
    const phrased = await phraseGroundedAnswer(message, supporting.map((h) => ({ title: h.title, text: h.body })));
    const reply = `${phrased ?? best.passage}\n\nSource: ${supporting.map((s) => s.title).join('; ')}`;
    await asSystem(tx, () => tx.query(`UPDATE knowledge_articles SET answered_count = answered_count + 1 WHERE id = ANY($1)`, [supporting.map((s) => s.id)]));
    return respond({ reply, intent: 'answered', confidence: best.score, sources: supporting.map((s) => ({ id: s.id, title: s.title, score: s.score })), action: null,
      suggestions: ['That answered my question', 'I still need help'] }, 'answered');
  }

  // Decline rather than guess; record the gap for the knowledge team
  await asSystem(tx, () => recordGap(tx, message));
  const maxTurns = await getSetting<number>(tx, 'assist.max_turns_before_handover');
  const failures = turns.filter((t) => t.role === 'assist' && t.intent === 'declined_no_grounding').length;
  if (canAct && failures + 1 >= Math.max(2, Math.floor(maxTurns / 3))) {
    const q = await handover(tx, ctx, turns, 'Assist could not find a grounded answer after repeated attempts', { visitor: input.visitor });
    return respond({ reply: `I don't have an approved answer for that, so I've passed it to a customer care agent with our conversation. Your reference is ${q.reference}.`, intent: 'handover', confidence: best?.score ?? 0, sources: [], action: { type: 'handover', reference: q.reference } }, 'handed_over', { handed: q.id });
  }
  return respond({
    reply: canAct
      ? 'I don\'t have an approved answer for that, and I won\'t guess. Would you like me to open a case so a customer care agent can answer? Reply "yes" and I\'ll do it.'
      : 'I don\'t have an approved answer for that, and I won\'t guess. Please sign in to the Namport customer portal to log a query, and a customer care agent will respond.',
    intent: 'declined_no_grounding', confidence: best?.score ?? 0, sources: [],
    action: canAct ? { type: 'offer_case', reason: 'no grounded answer' } : null, suggestions: canAct ? ['Yes, open a case'] : [],
  }, 'declined');
}

const fmt = (d: string | Date) => new Date(d).toLocaleString('en-GB', { timeZone: 'Africa/Windhoek', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export async function feedback(tx: Tx, sessionId: string, helpful: boolean) {
  const s = await one(tx, 'SELECT turns FROM assist_sessions WHERE id = $1', [sessionId]);
  if (!s) throw notFound();
  const last = [...(s.turns as AssistTurn[])].reverse().find((t) => t.role === 'assist' && t.sources?.length);
  if (last && helpful) await asSystem(tx, () => tx.query(`UPDATE knowledge_articles SET helpful_count = helpful_count + 1 WHERE id = ANY($1)`, [last.sources!.map((x) => x.id)]));
  return { ok: true };
}

/** Deflection analytics: what Assist resolved with no person involved. */
export async function deflection(tx: Tx, days = 30) {
  return one(tx,
    `SELECT count(*)::int AS sessions,
            count(*) FILTER (WHERE outcome = 'answered')::int AS answered,
            count(*) FILTER (WHERE outcome = 'acted')::int AS acted,
            count(*) FILTER (WHERE outcome = 'handed_over')::int AS handed_over,
            count(*) FILTER (WHERE outcome = 'declined')::int AS declined,
            round(100.0 * count(*) FILTER (WHERE outcome IN ('answered','acted')) / nullif(count(*), 0), 1) AS deflection_rate
       FROM assist_sessions WHERE created_at > now() - ($1 || ' days')::interval`, [String(days)]);
}
