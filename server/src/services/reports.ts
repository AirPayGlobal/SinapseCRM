import { many, one, type Tx, inSequence } from '../db/pool.js';
import type { Ctx } from '../lib/context.js';
import { badRequest } from '../lib/errors.js';
import { buildQueryWhere, type QueryFilters } from './queries.js';

/**
 * Insight and reporting (RA-01 .. RA-01.4). Every report runs under the caller's data scope (row-level
 * security), so a department head sees their own data without a separate report being built, and
 * reads the analytics replica so heavy dashboards never slow the agent console.
 */

export interface DashFilters { port?: string; department_id?: string; tier?: string; from?: string; to?: string; corridor_id?: string }

function dashWhere(f: DashFilters, alias = 'q') {
  const p: unknown[] = [];
  const w: string[] = [`${alias}.state <> 'filtered'`];
  if (f.port) { p.push(f.port); w.push(`${alias}.port_code = $${p.length}`); }
  if (f.department_id) { p.push(f.department_id); w.push(`${alias}.department_id = $${p.length}`); }
  if (f.corridor_id) { p.push(f.corridor_id); w.push(`${alias}.corridor_id = $${p.length}`); }
  if (f.tier) { p.push(f.tier); w.push(`EXISTS (SELECT 1 FROM companies tc WHERE tc.id = ${alias}.company_id AND tc.account_tier = $${p.length})`); }
  p.push(f.from ?? new Date(Date.now() - 30 * 86_400_000).toISOString()); w.push(`${alias}.created_at >= $${p.length}`);
  if (f.to) { p.push(f.to); w.push(`${alias}.created_at < $${p.length}`); }
  return { where: `WHERE ${w.join(' AND ')}`, params: p };
}

/** The four dashboards RA-01.2 names, plus attainment, satisfaction and channel mix. */
export async function dashboard(tx: Tx, f: DashFilters) {
  const { where, params } = dashWhere(f);
  const openWhere = dashWhere({ ...f, from: '1970-01-01' });
  const [kpis, byType, byDay, byCustomer, resolution, backlog, ageing, overdue, channels, satisfaction] = await inSequence([
    () => one(tx, `SELECT count(*)::int AS volume,
                    count(*) FILTER (WHERE resolved_at IS NOT NULL)::int AS resolved,
                    round(avg(extract(epoch FROM first_responded_at - created_at) / 60) FILTER (WHERE first_responded_at IS NOT NULL)::numeric, 0) AS avg_first_response_minutes,
                    round(avg(extract(epoch FROM resolved_at - created_at) / 3600) FILTER (WHERE resolved_at IS NOT NULL)::numeric, 1) AS avg_resolution_hours,
                    round(100.0 * count(*) FILTER (WHERE resolved_at IS NOT NULL AND NOT breached) / nullif(count(*) FILTER (WHERE resolved_at IS NOT NULL), 0), 1) AS sla_attainment,
                    count(*) FILTER (WHERE channel IN ('portal','widget','assist'))::int AS self_service,
                    round(100.0 * count(*) FILTER (WHERE channel IN ('portal','widget','assist')) / nullif(count(*), 0), 1) AS self_service_share,
                    sum(paused_business_minutes)::int AS paused_minutes
               FROM queries q ${where}`, params),
    () => many(tx, `SELECT coalesce(qt.name, 'Unclassified') AS label, q.query_type_key AS key, count(*)::int AS value FROM queries q LEFT JOIN query_types qt ON qt.key = q.query_type_key ${where} GROUP BY 1, 2 ORDER BY 3 DESC`, params),
    () => many(tx, `SELECT date_trunc('day', q.created_at AT TIME ZONE 'Africa/Windhoek')::date AS day, count(*)::int AS created,
                     count(*) FILTER (WHERE q.resolved_at IS NOT NULL)::int AS resolved FROM queries q ${where} GROUP BY 1 ORDER BY 1`, params),
    () => many(tx, `SELECT coalesce(co.name, 'Unlinked') AS label, q.company_id AS key, co.account_tier, count(*)::int AS value FROM queries q LEFT JOIN companies co ON co.id = q.company_id ${where} GROUP BY 1, 2, 3 ORDER BY 4 DESC LIMIT 10`, params),
    () => many(tx, `SELECT coalesce(qt.name, 'Unclassified') AS label,
                     round(avg(extract(epoch FROM q.first_responded_at - q.created_at) / 60) FILTER (WHERE q.first_responded_at IS NOT NULL)::numeric, 0) AS first_response_minutes,
                     round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM q.resolved_at - q.created_at) / 3600) FILTER (WHERE q.resolved_at IS NOT NULL))::numeric, 1) AS median_resolution_hours,
                     round(avg(extract(epoch FROM q.resolved_at - q.created_at) / 3600) FILTER (WHERE q.resolved_at IS NOT NULL)::numeric, 1) AS avg_resolution_hours
                FROM queries q LEFT JOIN query_types qt ON qt.key = q.query_type_key ${where} GROUP BY 1 ORDER BY 1`, params),
    () => many(tx, `SELECT q.state AS label, count(*)::int AS value FROM queries q ${openWhere.where} AND q.state NOT IN ('resolved','closed','merged') GROUP BY 1 ORDER BY 2 DESC`, openWhere.params),
    () => many(tx, `SELECT CASE WHEN now() - q.created_at < interval '1 day' THEN '< 1 day' WHEN now() - q.created_at < interval '3 days' THEN '1–3 days'
                          WHEN now() - q.created_at < interval '7 days' THEN '3–7 days' ELSE '> 7 days' END AS label, count(*)::int AS value
                FROM queries q ${openWhere.where} AND q.state NOT IN ('resolved','closed','merged') GROUP BY 1 ORDER BY min(q.created_at) DESC`, openWhere.params),
    () => many(tx, `SELECT q.id, q.reference, q.subject, q.urgency, q.escalation_level, co.name AS company_name, u.name AS assigned_to_name,
                     coalesce(CASE WHEN q.first_responded_at IS NULL THEN q.first_response_due_at END, q.resolution_due_at) AS due_at
                FROM queries q LEFT JOIN companies co ON co.id = q.company_id LEFT JOIN users u ON u.id = q.assigned_to
                ${openWhere.where} AND q.resolved_at IS NULL AND q.clock_paused_at IS NULL AND q.state NOT IN ('closed','merged')
                 AND (q.breached OR coalesce(CASE WHEN q.first_responded_at IS NULL THEN q.first_response_due_at END, q.resolution_due_at) < now())
               ORDER BY due_at LIMIT 25`, openWhere.params),
    () => many(tx, `SELECT q.channel AS label, count(*)::int AS value FROM queries q ${where} GROUP BY 1 ORDER BY 2 DESC`, params),
    () => one(tx, `SELECT round(avg(s.score)::numeric, 2) AS average, count(s.score)::int AS responses,
                    count(*) FILTER (WHERE s.score <= 2)::int AS poor FROM satisfaction_responses s JOIN queries q ON q.id = s.query_id ${where}`, params),
  ]);
  const overdueCount = await one<{ n: number }>(tx,
    `SELECT count(*)::int AS n FROM queries q ${openWhere.where} AND q.resolved_at IS NULL AND q.clock_paused_at IS NULL AND q.state NOT IN ('closed','merged')
       AND (q.breached OR coalesce(CASE WHEN q.first_responded_at IS NULL THEN q.first_response_due_at END, q.resolution_due_at) < now())`, openWhere.params);
  return {
    generated_at: new Date().toISOString(),
    kpis: { ...kpis, backlog: (backlog as any[]).reduce((s: number, b: any) => s + b.value, 0), overdue: overdueCount?.n ?? 0 },
    volumes: { by_type: byType, by_day: byDay, by_customer: byCustomer, by_channel: channels },
    resolution, backlog: { by_state: backlog, by_age: ageing }, overdue, satisfaction,
  };
}

/** RA-01.3 — per agent and per department: volume, first response, resolution, SLA, reopen rate, backlog age; with weekly trend. */
export async function performance(tx: Tx, f: DashFilters) {
  const { where, params } = dashWhere(f);
  const agents = await many(tx,
    `SELECT u.id, u.name, u.port_code, d.name AS department,
            count(q.id)::int AS handled,
            count(q.id) FILTER (WHERE q.resolved_at IS NOT NULL)::int AS resolved,
            round(avg(extract(epoch FROM q.first_responded_at - q.created_at) / 60) FILTER (WHERE q.first_responded_at IS NOT NULL)::numeric, 0) AS avg_first_response_minutes,
            round(avg(extract(epoch FROM q.resolved_at - q.created_at) / 3600) FILTER (WHERE q.resolved_at IS NOT NULL)::numeric, 1) AS avg_resolution_hours,
            round(100.0 * count(q.id) FILTER (WHERE q.resolved_at IS NOT NULL AND NOT q.breached) / nullif(count(q.id) FILTER (WHERE q.resolved_at IS NOT NULL), 0), 1) AS sla_attainment,
            round(100.0 * count(q.id) FILTER (WHERE q.reopen_count > 0) / nullif(count(q.id) FILTER (WHERE q.resolved_at IS NOT NULL OR q.reopen_count > 0), 0), 1) AS reopen_rate,
            (SELECT count(*)::int FROM queries o WHERE o.assigned_to = u.id AND o.state NOT IN ('resolved','closed','merged','filtered')) AS open_now,
            (SELECT round(avg(extract(epoch FROM now() - o.created_at) / 3600)::numeric, 1) FROM queries o WHERE o.assigned_to = u.id AND o.state NOT IN ('resolved','closed','merged','filtered')) AS backlog_age_hours,
            (SELECT round(avg(s.score)::numeric, 2) FROM satisfaction_responses s JOIN queries sq ON sq.id = s.query_id WHERE sq.assigned_to = u.id AND s.score IS NOT NULL) AS satisfaction
       FROM users u LEFT JOIN departments d ON d.id = u.department_id
       LEFT JOIN queries q ON q.assigned_to = u.id AND q.id IN (SELECT q.id FROM queries q ${where})
      WHERE u.active AND u.role_key IN ('agent','supervisor')
      GROUP BY u.id, u.name, u.port_code, d.name ORDER BY handled DESC`, params);
  const departments = await many(tx,
    `SELECT coalesce(d.name, 'Unassigned') AS department, count(q.id)::int AS handled,
            round(avg(extract(epoch FROM q.first_responded_at - q.created_at) / 60) FILTER (WHERE q.first_responded_at IS NOT NULL)::numeric, 0) AS avg_first_response_minutes,
            round(avg(extract(epoch FROM q.resolved_at - q.created_at) / 3600) FILTER (WHERE q.resolved_at IS NOT NULL)::numeric, 1) AS avg_resolution_hours,
            round(100.0 * count(q.id) FILTER (WHERE q.resolved_at IS NOT NULL AND NOT q.breached) / nullif(count(q.id) FILTER (WHERE q.resolved_at IS NOT NULL), 0), 1) AS sla_attainment,
            round(100.0 * count(q.id) FILTER (WHERE q.reopen_count > 0) / nullif(count(q.id), 0), 1) AS reopen_rate,
            count(q.id) FILTER (WHERE q.state NOT IN ('resolved','closed','merged'))::int AS backlog
       FROM queries q LEFT JOIN departments d ON d.id = q.department_id ${where} GROUP BY 1 ORDER BY 2 DESC`, params);
  const trend = await many(tx,
    `SELECT date_trunc('week', q.created_at)::date AS week, u.name AS agent, count(*)::int AS handled,
            round(100.0 * count(*) FILTER (WHERE q.resolved_at IS NOT NULL AND NOT q.breached) / nullif(count(*) FILTER (WHERE q.resolved_at IS NOT NULL), 0), 1) AS sla_attainment
       FROM queries q JOIN users u ON u.id = q.assigned_to ${where} GROUP BY 1, 2 ORDER BY 1`, params);
  return { agents, departments, trend };
}

/** Reassignment patterns: surfaces skills gaps and queue mis-configuration. */
export async function reassignmentPatterns(tx: Tx, days = 30) {
  return {
    by_type: await many(tx,
      `SELECT coalesce(qt.name, 'Unclassified') AS query_type, count(*)::int AS reassignments, count(DISTINCT a.query_id)::int AS cases
         FROM query_assignments a JOIN queries q ON q.id = a.query_id LEFT JOIN query_types qt ON qt.key = q.query_type_key
        WHERE a.strategy = 'manual' AND a.occurred_at > now() - ($1 || ' days')::interval GROUP BY 1 ORDER BY 2 DESC`, [String(days)]),
    flows: await many(tx,
      `SELECT coalesce(fu.name, 'Queue') AS from_agent, coalesce(tu.name, 'Queue') AS to_agent, count(*)::int AS n, array_agg(DISTINCT a.reason) AS reasons
         FROM query_assignments a JOIN queries q ON q.id = a.query_id LEFT JOIN users fu ON fu.id = a.from_user_id LEFT JOIN users tu ON tu.id = a.to_user_id
        WHERE a.strategy = 'manual' AND a.occurred_at > now() - ($1 || ' days')::interval GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 25`, [String(days)]),
  };
}

// ---------------------------------------------------------------------------
// Report builder — users define their own reports without development (RA-01.1)
// ---------------------------------------------------------------------------

export const DIMENSIONS: Record<string, { label: string; sql: string; join?: string }> = {
  query_type: { label: 'Query type', sql: `coalesce(qt.name, 'Unclassified')`, join: 'LEFT JOIN query_types qt ON qt.key = q.query_type_key' },
  urgency: { label: 'Urgency', sql: 'q.urgency' },
  department: { label: 'Department', sql: `coalesce(d.name, 'Unassigned')`, join: 'LEFT JOIN departments d ON d.id = q.department_id' },
  port: { label: 'Port', sql: 'q.port_code' },
  channel: { label: 'Channel', sql: 'q.channel' },
  state: { label: 'Status', sql: 'q.state' },
  customer: { label: 'Customer', sql: `coalesce(co.name, 'Unlinked')`, join: 'LEFT JOIN companies co ON co.id = q.company_id' },
  tier: { label: 'Customer tier', sql: `coalesce(co.account_tier, 'n/a')`, join: 'LEFT JOIN companies co ON co.id = q.company_id' },
  corridor: { label: 'Corridor', sql: `coalesce(cor.name, 'Unattributed')`, join: 'LEFT JOIN corridors cor ON cor.id = q.corridor_id' },
  agent: { label: 'Agent', sql: `coalesce(u.name, 'Unassigned')`, join: 'LEFT JOIN users u ON u.id = q.assigned_to' },
  day: { label: 'Day', sql: `to_char(q.created_at AT TIME ZONE 'Africa/Windhoek', 'YYYY-MM-DD')` },
  week: { label: 'Week', sql: `to_char(date_trunc('week', q.created_at AT TIME ZONE 'Africa/Windhoek'), 'YYYY-MM-DD')` },
  month: { label: 'Month', sql: `to_char(q.created_at AT TIME ZONE 'Africa/Windhoek', 'YYYY-MM')` },
};

export const METRICS: Record<string, { label: string; sql: string }> = {
  count: { label: 'Queries', sql: 'count(*)::int' },
  open: { label: 'Open', sql: `count(*) FILTER (WHERE q.state NOT IN ('resolved','closed','merged','filtered'))::int` },
  resolved: { label: 'Resolved', sql: 'count(*) FILTER (WHERE q.resolved_at IS NOT NULL)::int' },
  avg_first_response_minutes: { label: 'Avg first response (min)', sql: 'round(avg(extract(epoch FROM q.first_responded_at - q.created_at) / 60)::numeric, 0)' },
  avg_resolution_hours: { label: 'Avg resolution (h)', sql: 'round(avg(extract(epoch FROM q.resolved_at - q.created_at) / 3600)::numeric, 1)' },
  sla_attainment: { label: 'SLA attainment %', sql: 'round(100.0 * count(*) FILTER (WHERE q.resolved_at IS NOT NULL AND NOT q.breached) / nullif(count(*) FILTER (WHERE q.resolved_at IS NOT NULL), 0), 1)' },
  breaches: { label: 'Breaches', sql: 'count(*) FILTER (WHERE q.breached)::int' },
  reopen_rate: { label: 'Reopen rate %', sql: 'round(100.0 * count(*) FILTER (WHERE q.reopen_count > 0) / nullif(count(*), 0), 1)' },
  paused_hours: { label: 'Time paused on others (h)', sql: 'round(sum(q.paused_business_minutes) / 60.0, 1)' },
  escalated: { label: 'Escalated', sql: 'count(*) FILTER (WHERE q.escalation_level > 0)::int' },
};

export interface ReportDefinition {
  dimensions: string[];
  metrics: string[];
  filters?: QueryFilters;
  period_days?: number;
  sort?: { by: string; dir?: 'asc' | 'desc' };
  limit?: number;
}

export async function runReport(tx: Tx, ctx: Ctx, def: ReportDefinition) {
  const dims = (def.dimensions ?? []).filter((d) => DIMENSIONS[d]);
  const mets = (def.metrics ?? []).filter((m) => METRICS[m]);
  if (!mets.length) throw badRequest('Choose at least one metric');
  if (dims.length > 3) throw badRequest('At most three dimensions');
  const joins = [...new Set(dims.map((d) => DIMENSIONS[d].join).filter(Boolean))];
  const filters: QueryFilters = { ...(def.filters ?? {}) };
  if (def.period_days && !filters.created_from) filters.created_from = new Date(Date.now() - def.period_days * 86_400_000).toISOString();
  const needsCompany = filters.tier || (filters.q && true);
  if (needsCompany && !joins.some((j) => j?.includes('companies co'))) joins.push('LEFT JOIN companies co ON co.id = q.company_id');
  if (filters.q && !joins.some((j) => j?.includes('contacts ct'))) joins.push('LEFT JOIN contacts ct ON ct.id = q.contact_id');
  const { where, params } = buildQueryWhere(filters, ctx);
  const baseWhere = where ? `${where} AND q.state <> 'filtered'` : `WHERE q.state <> 'filtered'`;
  const select = [...dims.map((d) => `${DIMENSIONS[d].sql} AS "${d}"`), ...mets.map((m) => `${METRICS[m].sql} AS "${m}"`)].join(', ');
  const sortBy = def.sort?.by && (dims.includes(def.sort.by) || mets.includes(def.sort.by)) ? `"${def.sort.by}" ${def.sort.dir === 'asc' ? 'ASC' : 'DESC'} NULLS LAST` : dims.length ? '1' : null;
  const sql = `SELECT ${select} FROM queries q ${joins.join(' ')} ${baseWhere} ${dims.length ? `GROUP BY ${dims.map((_, i) => i + 1).join(', ')}` : ''} ${sortBy ? `ORDER BY ${sortBy}` : ''} LIMIT ${Math.min(def.limit ?? 1000, 5000)}`;
  const rows = await many(tx, sql, params);
  const columns = [...dims.map((d) => ({ key: d, label: DIMENSIONS[d].label })), ...mets.map((m) => ({ key: m, label: METRICS[m].label }))];
  return { columns, rows };
}

// ---------------------------------------------------------------------------
// Export: CSV, Excel (SpreadsheetML) and PDF — no third-party dependency
// ---------------------------------------------------------------------------

type Table = { columns: { key: string; label: string }[]; rows: Record<string, unknown>[] };

export function toCsv(t: Table) {
  const esc = (v: unknown) => {
    const s = v == null ? '' : v instanceof Date ? v.toISOString() : String(v);
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; // neutralise spreadsheet formula injection
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [t.columns.map((c) => esc(c.label)).join(','), ...t.rows.map((r) => t.columns.map((c) => esc(r[c.key])).join(','))].join('\r\n');
}

export function toExcelXml(t: Table, title: string) {
  const x = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const cell = (v: unknown) => (typeof v === 'number' ? `<Cell><Data ss:Type="Number">${v}</Data></Cell>` : `<Cell><Data ss:Type="String">${x(v instanceof Date ? v.toISOString() : v)}</Data></Cell>`);
  return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Styles><Style ss:ID="h"><Font ss:Bold="1"/></Style></Styles>
<Worksheet ss:Name="${x(title).slice(0, 31)}"><Table>
<Row>${t.columns.map((c) => `<Cell ss:StyleID="h"><Data ss:Type="String">${x(c.label)}</Data></Cell>`).join('')}</Row>
${t.rows.map((r) => `<Row>${t.columns.map((c) => cell(r[c.key])).join('')}</Row>`).join('\n')}
</Table></Worksheet></Workbook>`;
}

/** Minimal, standards-conformant PDF (Helvetica, landscape A4, paginated table). */
export function toPdf(t: Table, title: string): Buffer {
  const W = 842, H = 595, M = 36, LH = 14;
  const esc = (s: string) => s.replace(/[^\x20-\x7E]/g, '?').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const colW = (W - 2 * M) / Math.max(1, t.columns.length);
  const maxChars = Math.max(4, Math.floor(colW / 5.2));
  const clip = (v: unknown) => { const s = v == null ? '' : v instanceof Date ? v.toISOString().slice(0, 16) : String(v); return s.length > maxChars ? `${s.slice(0, maxChars - 1)}~` : s; };
  const rowsPerPage = Math.floor((H - 2 * M - 3 * LH) / LH);
  const pages: string[] = [];
  const chunks = t.rows.length ? Array.from({ length: Math.ceil(t.rows.length / rowsPerPage) }, (_, i) => t.rows.slice(i * rowsPerPage, (i + 1) * rowsPerPage)) : [[]];
  chunks.forEach((chunk, pi) => {
    const ops: string[] = ['BT', '/F2 13 Tf', `${M} ${H - M} Td`, `(${esc(`${title}  -  page ${pi + 1}/${chunks.length}  -  generated ${new Date().toISOString().slice(0, 16)} UTC`)}) Tj`, 'ET'];
    const line = (y: number, cells: string[], font: string) => cells.forEach((c, i) => ops.push('BT', `${font} 8 Tf`, `${(M + i * colW).toFixed(1)} ${y} Td`, `(${esc(c)}) Tj`, 'ET'));
    let y = H - M - 2 * LH;
    line(y, t.columns.map((c) => clip(c.label)), '/F2');
    ops.push(`${M} ${y - 4} m ${W - M} ${y - 4} l S`);
    for (const r of chunk) { y -= LH; line(y, t.columns.map((c) => clip(r[c.key])), '/F1'); }
    pages.push(ops.join('\n'));
  });
  const objs: string[] = [];
  const add = (s: string) => { objs.push(s); return objs.length; };
  const catalog = add('');
  const pagesObj = add('');
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
  const kids: number[] = [];
  for (const content of pages) {
    const c = add(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${c} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

export function exportTable(t: Table, format: 'csv' | 'xlsx' | 'pdf', title: string) {
  if (format === 'csv') return { body: Buffer.from('﻿' + toCsv(t), 'utf8'), type: 'text/csv; charset=utf-8', ext: 'csv' };
  if (format === 'xlsx') return { body: Buffer.from(toExcelXml(t, title), 'utf8'), type: 'application/vnd.ms-excel', ext: 'xls' };
  return { body: toPdf(t, title), type: 'application/pdf', ext: 'pdf' };
}
