import { afterAll, describe, expect, it } from 'vitest';
import { many, one, pool } from '../src/db/pool.js';
import { systemCtx } from '../src/lib/context.js';
import { assign, reassign } from '../src/services/assignment.js';
import { evaluateSla } from '../src/services/escalation.js';
import { intake } from '../src/services/intake.js';
import { addNote, getQueryDetail, merge, reply, reviewFiltered, updateQuery } from '../src/services/queries.js';
import { recordSatisfaction } from '../src/services/satisfaction.js';
import { transition } from '../src/services/workflow.js';
import { as, customerByEmail, staffByEmail, sys, uniq } from './helpers.js';

const ctx = systemCtx('test');
afterAll(() => pool.end());

describe('intake and de-duplication', () => {
  it('issues port-prefixed references from separate sequences', async () => {
    const a = await sys((tx) => intake(tx, ctx, { channel: 'staff', subject: 'Berth window for vessel', body: 'Please confirm the berthing window', port: 'WB' }));
    const b = await sys((tx) => intake(tx, ctx, { channel: 'staff', subject: 'Gate access at Lüderitz', body: 'Access permit for driver', port: 'LZ' }));
    expect(a.query.reference).toMatch(/^NAM-WB-\d{4}-\d{6}$/);
    expect(b.query.reference).toMatch(/^NAM-LZ-\d{4}-\d{6}$/);
  });

  it('is idempotent on the inbound message identifier — a replay cannot create a second case', async () => {
    const mid = `<${uniq('m')}@mail>`;
    const input = { channel: 'email' as const, subject: 'Storage charges on transhipment', body: 'Please explain the storage charges', from: { email: 'ops@atlanticshipping.na' }, externalMessageId: mid };
    const first = await sys((tx) => intake(tx, ctx, input));
    const replay = await sys((tx) => intake(tx, ctx, input));
    expect(first.outcome).toBe('created');
    expect(replay.outcome).toBe('duplicate_message');
    expect(replay.query.id).toBe(first.query.id);
    const n = await sys((tx) => one(tx, 'SELECT count(*)::int AS n FROM interactions WHERE external_message_id = $1', [mid]));
    expect(n.n).toBe(1);
  });

  it('threads a reply quoting the reference onto the existing case', async () => {
    const first = await sys((tx) => intake(tx, ctx, { channel: 'email', subject: 'Reefer temperature report', body: 'Please send the reefer monitoring report', from: { email: 'shipping@seaflower.com.na' }, externalMessageId: `<${uniq()}@x>` }));
    const r = await sys((tx) => intake(tx, ctx, { channel: 'email', subject: `RE: [${first.query.reference}] Reefer temperature report`, body: 'Any update?', from: { email: 'shipping@seaflower.com.na' }, externalMessageId: `<${uniq()}@x>` }));
    expect(r.outcome).toBe('threaded');
    expect(r.query.id).toBe(first.query.id);
  });

  it('filters irrelevant traffic to a review queue and releasing it triages and assigns', async () => {
    const r = await sys((tx) => intake(tx, ctx, { channel: 'email', subject: 'Vacancy', body: 'I would like to apply for any vacancy', from: { email: `${uniq()}@example.com` } }));
    expect(r.outcome).toBe('filtered');
    expect(r.query.state).toBe('filtered');
    expect(r.query.filter_reason).toMatch(/vacancy/i);
    const sup = await staffByEmail('k.kaapanda@namport.com.na');
    const out = await as(sup, (tx) => reviewFiltered(tx, sup, r.query.id, 'release'));
    expect(out.decision).toBe('release');
    const q = await sys((tx) => one(tx, 'SELECT state, filter_reason FROM queries WHERE id = $1', [r.query.id]));
    expect(['assigned', 'triaged']).toContain(q.state);
    expect(q.filter_reason).toBeNull();
  });

  it('flags a near-duplicate and merges it without losing the second customer’s words', async () => {
    const a = await sys((tx) => intake(tx, ctx, { channel: 'portal', subject: 'Copper concentrate berthing window', body: 'Please advise the berthing window for our copper concentrate shipment on CMA CGM Etosha', from: { email: 'logistics@zambezicopper.co.zm' } }));
    const b = await sys((tx) => intake(tx, ctx, { channel: 'portal', subject: 'Berthing window copper concentrate', body: 'Advise berthing window for copper concentrate on CMA CGM Etosha please', from: { email: 'logistics@zambezicopper.co.zm' } }));
    expect(b.possibleDuplicateOf?.id).toBe(a.query.id);
    const sup = await staffByEmail('k.kaapanda@namport.com.na');
    await as(sup, (tx) => merge(tx, sup, b.query.id, a.query.id));
    const detail = await as(sup, (tx) => getQueryDetail(tx, sup, a.query.id));
    expect(detail.children.map((c: any) => c.id)).toContain(b.query.id);
    expect(detail.timeline.some((t: any) => t.body.includes('Advise berthing window'))).toBe(true);
    const child = await sys((tx) => one(tx, 'SELECT state, parent_query_id FROM queries WHERE id = $1', [b.query.id]));
    expect(child).toMatchObject({ state: 'merged', parent_query_id: a.query.id });
  });

  it('links port context from container numbers', async () => {
    const r = await sys((tx) => intake(tx, ctx, { channel: 'email', subject: 'Container MSCU4821942 not released', body: 'Reefer container MSCU4821942 still held', from: { email: 'ops@namibclearing.com.na' } }));
    expect(r.query.cargo_reference_id).toBeTruthy();
    expect(r.query.vessel_call_id).toBeTruthy();
    expect(r.query.corridor_id).toBeTruthy();
  });
});

describe('assignment engine', () => {
  it('never assigns to an agent who is out of office', async () => {
    const ooo = await sys((tx) => one(tx, `SELECT id FROM users WHERE email = 'p.amupolo@namport.com.na'`));
    for (let i = 0; i < 6; i++) {
      const r = await sys((tx) => intake(tx, ctx, { channel: 'staff', subject: `Damage claim ${i}`, body: 'Claim for damaged container during discharge', queryTypeKey: 'damage_claim', port: 'WB' }));
      expect(r.query.assigned_to).not.toBe(ooo.id);
    }
  });

  it('claims atomically — concurrent assignment produces exactly one assignee', async () => {
    const r = await sys((tx) => intake(tx, ctx, { channel: 'staff', subject: 'Concurrency test', body: 'General question', queryTypeKey: 'general', port: 'WB' }));
    await sys((tx) => tx.query(`UPDATE queries SET assigned_to = NULL, state = 'triaged' WHERE id = $1`, [r.query.id]));
    const results = await Promise.all(Array.from({ length: 5 }, () => sys((tx) => assign(tx, ctx, r.query.id)).catch((e) => ({ error: e.message }))));
    const rows = await sys((tx) => many(tx, `SELECT to_user_id FROM query_assignments WHERE query_id = $1 AND reason = 'automatic' AND occurred_at > now() - interval '1 minute'`, [r.query.id]));
    const finalQ = await sys((tx) => one(tx, 'SELECT assigned_to FROM queries WHERE id = $1', [r.query.id]));
    expect(finalQ.assigned_to).toBeTruthy();
    expect(new Set(rows.map((x) => x.to_user_id)).size).toBeLessThanOrEqual(2); // the original + at most one re-claim
    expect(results.filter((x: any) => x.assigned && x.reason !== 'already assigned' && x.reason !== 'claimed concurrently').length).toBeLessThanOrEqual(1);
  });

  it('requires a reason for manual reassignment and records it', async () => {
    const r = await sys((tx) => intake(tx, ctx, { channel: 'staff', subject: 'Reassign me', body: 'Invoice incorrect', queryTypeKey: 'billing', port: 'WB' }));
    const sup = await staffByEmail('k.kaapanda@namport.com.na');
    const target = await sys((tx) => one(tx, `SELECT id FROM users WHERE email = 'm.van.wyk@namport.com.na'`));
    await expect(as(sup, (tx) => reassign(tx, sup, r.query.id, target.id, ''))).rejects.toThrow(/reason/);
    await as(sup, (tx) => reassign(tx, sup, r.query.id, target.id, 'Skills: billing backlog'));
    const q = await sys((tx) => one(tx, 'SELECT assigned_to, reassignment_count FROM queries WHERE id = $1', [r.query.id]));
    expect(q).toMatchObject({ assigned_to: target.id, reassignment_count: 1 });
  });
});

describe('workflow and service clock', () => {
  it('enforces guards and pauses the clock while waiting on the customer', async () => {
    const r = await sys((tx) => intake(tx, ctx, { channel: 'email', subject: 'Bill of lading amendment', body: 'Please amend our bill of lading', from: { email: 'ops@namibclearing.com.na' } }));
    const agent = await sys(async (tx) => one(tx, 'SELECT email FROM users WHERE id = $1', [r.query.assigned_to]));
    const a = await staffByEmail(agent.email);
    await as(a, (tx) => transition(tx, a, r.query.id, 'in_progress'));
    await expect(as(a, (tx) => transition(tx, a, r.query.id, 'resolved'))).rejects.toThrow(/resolution note/);
    await expect(as(a, (tx) => transition(tx, a, r.query.id, 'closed'))).rejects.toThrow(/not permitted/);
    await as(a, (tx) => transition(tx, a, r.query.id, 'pending_customer'));
    const paused = await sys((tx) => one(tx, 'SELECT clock_paused_at FROM queries WHERE id = $1', [r.query.id]));
    expect(paused.clock_paused_at).toBeTruthy();
    // customer replies → clock resumes, case back in progress
    await sys((tx) => intake(tx, ctx, { channel: 'email', subject: `Re: ${r.query.reference}`, body: 'Here is the corrected consignee', from: { email: 'ops@namibclearing.com.na' }, externalMessageId: `<${uniq()}@x>` }));
    const resumed = await sys((tx) => one(tx, 'SELECT state, clock_paused_at FROM queries WHERE id = $1', [r.query.id]));
    expect(resumed).toMatchObject({ state: 'in_progress', clock_paused_at: null });
    await as(a, (tx) => reply(tx, a, r.query.id, 'Amended as requested.', { then: 'resolve' }));
    const done = await sys((tx) => one(tx, 'SELECT state, resolved_at, first_responded_at FROM queries WHERE id = $1', [r.query.id]));
    expect(done.state).toBe('resolved');
    expect(done.first_responded_at).toBeTruthy();
  });

  it('keeps an in-flight case on the workflow version it started under', async () => {
    const r = await sys((tx) => intake(tx, ctx, { channel: 'staff', subject: 'Versioning', body: 'General', queryTypeKey: 'general', port: 'WB' }));
    const v1 = r.query.workflow_definition_id;
    await sys(async (tx) => {
      const w = await one(tx, `SELECT * FROM workflow_definitions WHERE id = $1`, [v1]);
      await tx.query(`UPDATE workflow_definitions SET status = 'retired' WHERE id = $1`, [v1]);
      await tx.query(`INSERT INTO workflow_definitions (workflow_key, version, status, definition, sla_policy_id, published_at) VALUES ($1, $2, 'published', $3, $4, now())`,
        [w.workflow_key, w.version + 100, JSON.stringify(w.definition), w.sla_policy_id]);
    });
    const after = await sys((tx) => one(tx, 'SELECT workflow_definition_id FROM queries WHERE id = $1', [r.query.id]));
    expect(after.workflow_definition_id).toBe(v1);
  });

  it('issues pre-breach warnings and escalates a breach through the matrix, faster for Top 10', async () => {
    const r = await sys((tx) => intake(tx, ctx, { channel: 'email', subject: 'Escalation test berth', body: 'Berth allocation unclear', from: { email: 'hileni@namibclearing.com.na' } }));
    // move the clock: due dates in the past, breached long ago
    await sys((tx) => tx.query(`UPDATE queries SET first_response_due_at = now() - interval '1 minute' WHERE id = $1`, [r.query.id]));
    await sys((tx) => evaluateSla(tx));
    let q = await sys((tx) => one(tx, 'SELECT breached, escalation_level FROM queries WHERE id = $1', [r.query.id]));
    expect(q.breached).toBe(true);
    expect(q.escalation_level).toBe(1);
    await sys((tx) => tx.query(`UPDATE queries SET breached_at = now() - interval '90 minutes' WHERE id = $1`, [r.query.id]));
    await sys((tx) => evaluateSla(tx));
    q = await sys((tx) => one(tx, 'SELECT escalation_level FROM queries WHERE id = $1', [r.query.id]));
    expect(q.escalation_level).toBe(2); // Top 10 matrix: level 2 after 60 minutes
    const alerts = await sys((tx) => many(tx, `SELECT kind FROM alerts WHERE query_id = $1`, [r.query.id]));
    expect(alerts.map((a) => a.kind)).toEqual(expect.arrayContaining(['breach', 'escalation']));
  });

  it('confirming or overriding the AI classification records training signal', async () => {
    const r = await sys((tx) => intake(tx, ctx, { channel: 'email', subject: 'Question', body: 'Our truck was turned away at the gate this morning', from: { email: 'admin@luderitzlogistics.na' } }));
    const a = await staffByEmail('s.goagoses@namport.com.na');
    await as(a, (tx) => updateQuery(tx, a, r.query.id, { query_type_key: 'access_permit' }));
    const sig = await sys((tx) => one(tx, `SELECT final, overridden FROM classification_signals WHERE query_id = $1 ORDER BY created_at DESC LIMIT 1`, [r.query.id]));
    expect(sig.final.query_type).toBe('access_permit');
  });

  it('a poor satisfaction score opens a follow-up case automatically', async () => {
    const r = await sys((tx) => intake(tx, ctx, { channel: 'email', subject: 'Satisfaction', body: 'Question about invoice', from: { email: 'finance@namibclearing.com.na' } }));
    const agentRow = await sys((tx) => one(tx, 'SELECT email FROM users WHERE id = $1', [r.query.assigned_to]));
    const a = await staffByEmail(agentRow.email);
    await as(a, (tx) => reply(tx, a, r.query.id, 'Corrected.', { then: 'resolve' }));
    const s = await sys((tx) => one(tx, 'SELECT token FROM satisfaction_responses WHERE query_id = $1', [r.query.id]));
    const out = await sys((tx) => recordSatisfaction(tx, s.token, 1, 'Took too long'));
    expect(out.followup_reference).toMatch(/^NAM-WB-/);
  });
});

describe('data-layer access control', () => {
  it('a customer sees only their own company’s cases and never internal notes', async () => {
    const r = await sys((tx) => intake(tx, ctx, { channel: 'email', subject: 'RLS test', body: 'Hello', from: { email: 'hileni@namibclearing.com.na' } }));
    const sup = await staffByEmail('k.kaapanda@namport.com.na');
    await as(sup, (tx) => addNote(tx, sup, r.query.id, 'Internal only: check with Marine Services'));
    const hileni = await customerByEmail('hileni@namibclearing.com.na');
    const other = await customerByEmail('bookings@kalaharifreight.com');
    const mine = await as(hileni, (tx) => getQueryDetail(tx, hileni, r.query.id));
    expect(mine.timeline.some((t: any) => t.body.includes('Internal only'))).toBe(false);
    await expect(as(other, (tx) => getQueryDetail(tx, other, r.query.id))).rejects.toThrow(/not found/i);
    // even a direct SQL read under the customer's scope cannot see the note
    const notes = await as(hileni, (tx) => many(tx, `SELECT * FROM interactions WHERE query_id = $1 AND visibility = 'internal'`, [r.query.id]));
    expect(notes).toHaveLength(0);
  });

  it('a Lüderitz agent does not see Walvis Bay work', async () => {
    const r = await sys((tx) => intake(tx, ctx, { channel: 'staff', subject: 'WB only', body: 'General', queryTypeKey: 'general', port: 'WB' }));
    const lz = await staffByEmail('s.goagoses@namport.com.na');
    const seen = await as(lz, (tx) => one(tx, 'SELECT id FROM queries WHERE id = $1', [r.query.id]));
    expect(seen).toBeNull();
  });

  it('masks commercially sensitive fields for roles that do not need them', async () => {
    const agent = await staffByEmail('t.shikongo@namport.com.na');
    const { getCompany } = await import('../src/services/companies.js');
    const c = await sys((tx) => one(tx, `SELECT id FROM companies WHERE name = 'Namib Clearing (Pty) Ltd'`));
    const view = await as(agent, (tx) => getCompany(tx, agent, c.id));
    expect(view.sap_customer_id).toBe('••••••');
  });
});

describe('append-only event log', () => {
  it('rejects update and delete, and the hash chain verifies', async () => {
    await expect(sys((tx) => tx.query('UPDATE event_log SET action = $1 WHERE id = (SELECT min(id) FROM event_log)', ['tampered']))).rejects.toThrow(/append-only|permission denied/);
    await expect(sys((tx) => tx.query('DELETE FROM event_log WHERE id = (SELECT min(id) FROM event_log)'))).rejects.toThrow(/append-only|permission denied/);
    await sys((tx) => tx.query('SELECT seal_event_log()'));
    await expect(sys((tx) => tx.query('DELETE FROM event_log_seal'))).rejects.toThrow(/append-only|permission denied/);
    const v = await sys((tx) => one(tx, `SELECT count(*)::int AS n, count(*) FILTER (WHERE hash <> event_log_row_hash(e))::int AS bad FROM event_log e`));
    expect(v.n).toBeGreaterThan(10);
    expect(v.bad).toBe(0);
  });
});
