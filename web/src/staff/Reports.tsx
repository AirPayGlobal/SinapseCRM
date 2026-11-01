import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, qs } from '../api';
import { Badge, Bars, Card, ErrorBox, Field, LineChart, Loading, PageHead, Stat, Table, Tabs } from '../components/ui';
import { fmtDateTime, fmtNum, label } from '../format';
import { useAction, useLoad } from '../hooks';
import { useCan, useStaff } from './context';

type Tab = 'dashboard' | 'performance' | 'corridors' | 'assist' | 'adoption' | 'builder' | 'alerts';

export default function Reports() {
  const can = useCan();
  const [tab, setTab] = useState<Tab>('dashboard');
  const { ref } = useStaff();
  const [f, setF] = useState({ port: '', department_id: '', tier: '', days: '30' });
  const filters = { port: f.port, department_id: f.department_id, tier: f.tier, from: new Date(Date.now() - Number(f.days) * 86_400_000).toISOString() };
  return (
    <>
      <PageHead title="Insight and reporting" sub="Live operational data — the figure on screen is the figure now. Every figure drills through to the cases behind it." />
      <Tabs value={tab} onChange={setTab} tabs={[
        { key: 'dashboard', label: 'Dashboard' }, { key: 'performance', label: 'Agents & departments' }, { key: 'corridors', label: 'Corridors' },
        { key: 'assist', label: 'Assist deflection' }, { key: 'adoption', label: 'Adoption' }, ...(can('report.read') ? [{ key: 'builder' as Tab, label: 'Report builder' }] : []), { key: 'alerts', label: 'Alerts' },
      ]} />
      {['dashboard', 'performance'].includes(tab) && (
        <div className="row" style={{ marginBottom: 12 }}>
          <select value={f.port} onChange={(e) => setF({ ...f, port: e.target.value })} style={{ width: 'auto' }} aria-label="Port"><option value="">Both ports</option>{ref.ports.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</select>
          <select value={f.department_id} onChange={(e) => setF({ ...f, department_id: e.target.value })} style={{ width: 'auto' }} aria-label="Department"><option value="">All departments</option>{ref.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
          <select value={f.tier} onChange={(e) => setF({ ...f, tier: e.target.value })} style={{ width: 'auto' }} aria-label="Tier"><option value="">All tiers</option><option value="top10">Top 10</option><option value="priority">Priority</option><option value="standard">Standard</option></select>
          <select value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })} style={{ width: 'auto' }} aria-label="Period"><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option><option value="365">12 months</option></select>
        </div>
      )}
      {tab === 'dashboard' && <Dashboard filters={filters} />}
      {tab === 'performance' && <Performance filters={filters} />}
      {tab === 'corridors' && <Corridors />}
      {tab === 'assist' && <Deflection />}
      {tab === 'adoption' && <Adoption />}
      {tab === 'builder' && <Builder />}
      {tab === 'alerts' && <Alerts />}
    </>
  );
}

function Dashboard({ filters }: { filters: Record<string, string> }) {
  const nav = useNavigate();
  const d = useLoad(() => api.get(`/reports/dashboard${qs(filters)}`), [JSON.stringify(filters)], { refreshMs: 30_000 });
  const corridors = useLoad(() => api.get('/reports/corridors?days=90'), []);
  if (d.error) return <ErrorBox error={d.error} />;
  if (!d.data) return <Loading />;
  const k = d.data.kpis;
  const drill = (o: Record<string, string | undefined>) => nav(`/team${qs(o)}`);
  return (
    <>
      <div className="grid cols-4">
        <Stat label="Queries in period" value={fmtNum(k.volume)} sub={`${k.self_service_share ?? 0}% self-service`} />
        <Stat label="Open backlog" value={fmtNum(k.backlog)} />
        <Stat label="Overdue now" value={<button className="btn link" style={{ fontSize: 26, fontWeight: 800, padding: 0, color: 'inherit' }} onClick={() => drill({ sla: 'breached' })}>{k.overdue}</button>} warn={k.overdue > 0} />
        <Stat label="SLA attainment" value={k.sla_attainment != null ? `${k.sla_attainment}%` : '—'} sub={`Avg first response ${k.avg_first_response_minutes ?? '—'} min · resolution ${k.avg_resolution_hours ?? '—'} h`} />
      </div>
      <div className="grid cols-2" style={{ marginTop: 14 }}>
        <Card eyebrow="Volume by query type"><Bars rows={d.data.volumes.by_type.map((r: any) => ({ label: r.label, value: r.value, key: r.key }))} onPick={(key) => drill({ query_type: key, state: undefined })} /></Card>
        <Card eyebrow="Volume over time"><LineChart series={[
          { name: 'Created', points: d.data.volumes.by_day.map((r: any) => ({ x: String(r.day).slice(0, 10), y: r.created })) },
          { name: 'Resolved', points: d.data.volumes.by_day.map((r: any) => ({ x: String(r.day).slice(0, 10), y: r.resolved })) },
        ]} /></Card>
        <Card eyebrow="Top customers by volume"><Bars rows={d.data.volumes.by_customer.map((r: any) => ({ label: `${r.label}${r.account_tier === 'top10' ? ' ★' : ''}`, value: r.value, key: r.key }))} onPick={(key) => key && nav(`/customers/companies/${key}`)} /></Card>
        <Card eyebrow="Resolution time by type">
          <Table rows={d.data.resolution} cols={[{ key: 'label', label: 'Type' }, { key: 'first_response_minutes', label: 'First response (min)', num: true }, { key: 'median_resolution_hours', label: 'Median resolution (h)', num: true }, { key: 'avg_resolution_hours', label: 'Average (h)', num: true }]} />
        </Card>
        <Card eyebrow="Backlog by status and age">
          <Bars rows={d.data.backlog.by_state.map((r: any) => ({ label: r.label, value: r.value, key: r.label }))} onPick={(key) => drill({ state: key })} />
          <hr /><Bars rows={d.data.backlog.by_age.map((r: any) => ({ label: r.label, value: r.value }))} />
        </Card>
        <Card eyebrow="Overdue queries">
          <Table rows={d.data.overdue} empty="Nothing overdue" cols={[
            { key: 'reference', label: 'Case', render: (r: any) => <Link to={`/cases/${r.id}`}>{r.reference}</Link> }, { key: 'company_name', label: 'Customer' },
            { key: 'assigned_to_name', label: 'Agent' }, { key: 'escalation_level', label: 'Esc.', num: true }, { key: 'due_at', label: 'Was due', render: (r: any) => fmtDateTime(r.due_at) },
          ]} />
        </Card>
        <Card gold eyebrow="Corridors — Module 6">
          {corridors.data ? <Bars rows={corridors.data.summary.map((r: any) => ({ label: r.corridor, value: r.volume, key: r.corridor_id }))} onPick={(key) => key && drill({ corridor_id: key })} /> : <Loading />}
        </Card>
        <Card eyebrow="Channels and satisfaction">
          <Bars rows={d.data.volumes.by_channel.map((r: any) => ({ label: r.label, value: r.value, key: r.label }))} onPick={(key) => drill({ channel: key })} />
          <hr />
          <div className="row"><Stat label="Average satisfaction" value={d.data.satisfaction?.average ?? '—'} /><Stat label="Responses" value={d.data.satisfaction?.responses ?? 0} /><Stat label="Poor scores (follow-up opened)" value={d.data.satisfaction?.poor ?? 0} /></div>
        </Card>
      </div>
      <p className="small muted">Updated {fmtDateTime(d.data.generated_at)} · refreshes every 30 seconds</p>
    </>
  );
}

function Performance({ filters }: { filters: Record<string, string> }) {
  const p = useLoad(() => api.get(`/reports/performance${qs(filters)}`), [JSON.stringify(filters)]);
  const r = useLoad(() => api.get('/reports/reassignments'), []);
  if (!p.data) return p.error ? <ErrorBox error={p.error} /> : <Loading />;
  const agents = [...new Set(p.data.trend.map((t: any) => t.agent))] as string[];
  return (
    <>
      <Card eyebrow="Performance by agent">
        <Table rows={p.data.agents} cols={[
          { key: 'name', label: 'Agent', render: (a: any) => <Link to={`/team?assigned_to=${a.id}`}>{a.name}</Link> }, { key: 'port_code', label: 'Port' },
          { key: 'handled', label: 'Handled', num: true }, { key: 'resolved', label: 'Resolved', num: true },
          { key: 'avg_first_response_minutes', label: 'First resp. (min)', num: true }, { key: 'avg_resolution_hours', label: 'Resolution (h)', num: true },
          { key: 'sla_attainment', label: 'SLA %', num: true }, { key: 'reopen_rate', label: 'Reopen %', num: true },
          { key: 'open_now', label: 'Open now', num: true }, { key: 'backlog_age_hours', label: 'Backlog age (h)', num: true }, { key: 'satisfaction', label: 'CSAT', num: true },
        ]} />
      </Card>
      <div className="grid cols-2" style={{ marginTop: 14 }}>
        <Card eyebrow="Weekly trend — cases handled"><LineChart series={agents.slice(0, 6).map((a) => ({ name: a, points: p.data.trend.filter((t: any) => t.agent === a).map((t: any) => ({ x: String(t.week).slice(0, 10), y: t.handled })) }))} /></Card>
        <Card eyebrow="By department"><Table rows={p.data.departments} cols={[{ key: 'department', label: 'Department' }, { key: 'handled', label: 'Handled', num: true }, { key: 'avg_resolution_hours', label: 'Resolution (h)', num: true }, { key: 'sla_attainment', label: 'SLA %', num: true }, { key: 'backlog', label: 'Backlog', num: true }]} /></Card>
        <Card eyebrow="Reassignment patterns — skills gaps and queue mis-configuration">
          <Table rows={r.data?.by_type ?? []} empty="No manual reassignments in 30 days" cols={[{ key: 'query_type', label: 'Type' }, { key: 'reassignments', label: 'Reassignments', num: true }, { key: 'cases', label: 'Cases', num: true }]} />
          <Table rows={r.data?.flows ?? []} empty="" cols={[{ key: 'from_agent', label: 'From' }, { key: 'to_agent', label: 'To' }, { key: 'n', label: 'Times', num: true }, { key: 'reasons', label: 'Reasons', render: (x: any) => <span className="small">{(x.reasons ?? []).join('; ')}</span> }]} />
        </Card>
      </div>
    </>
  );
}

function Corridors() {
  const nav = useNavigate();
  const c = useLoad(() => api.get('/reports/corridors?days=90'), []);
  if (!c.data) return c.error ? <ErrorBox error={c.error} /> : <Loading />;
  const names = [...new Set(c.data.trend.map((t: any) => t.corridor))] as string[];
  return (
    <div className="grid cols-2">
      <Card gold eyebrow="Corridor analytics · 90 days" className="">
        <Table rows={c.data.summary} onRow={(r: any) => r.corridor_id && nav(`/team?corridor_id=${r.corridor_id}`)} cols={[
          { key: 'corridor', label: 'Corridor' }, { key: 'volume', label: 'Queries', num: true }, { key: 'open', label: 'Open', num: true },
          { key: 'avg_resolution_hours', label: 'Resolution (h)', num: true }, { key: 'sla_attainment', label: 'SLA %', num: true },
        ]} />
      </Card>
      <Card eyebrow="Weekly volume by corridor"><LineChart series={names.map((n) => ({ name: n, points: c.data.trend.filter((t: any) => t.corridor === n).map((t: any) => ({ x: String(t.week).slice(0, 10), y: t.n })) }))} /></Card>
      <Card eyebrow="Query-type mix by corridor">
        <Table rows={c.data.mix} cols={[{ key: 'corridor', label: 'Corridor' }, { key: 'query_type', label: 'Type' }, { key: 'n', label: 'Queries', num: true }]} />
      </Card>
    </div>
  );
}

function Deflection() {
  const d = useLoad(() => api.get('/reports/deflection'), []);
  if (!d.data) return d.error ? <ErrorBox error={d.error} /> : <Loading />;
  const s = d.data.summary;
  return (
    <>
      <div className="grid cols-4">
        <Stat label="Assist conversations · 30 days" value={s.sessions} />
        <Stat label="Resolved with no person (deflection)" value={s.deflection_rate != null ? `${s.deflection_rate}%` : '—'} />
        <Stat label="Handed over with full context" value={s.handed_over} />
        <Stat label="Declined rather than guessed" value={s.declined} />
      </div>
      <div className="grid cols-2" style={{ marginTop: 14 }}>
        <Card eyebrow="Weekly"><LineChart series={[
          { name: 'Sessions', points: d.data.by_week.map((w: any) => ({ x: String(w.week).slice(0, 10), y: w.sessions })) },
          { name: 'Deflected', points: d.data.by_week.map((w: any) => ({ x: String(w.week).slice(0, 10), y: w.deflected })) },
          { name: 'Handed over', points: d.data.by_week.map((w: any) => ({ x: String(w.week).slice(0, 10), y: w.handed_over })) },
        ]} /></Card>
        <Card eyebrow="Most-used approved articles"><Table rows={d.data.top_articles} cols={[{ key: 'title', label: 'Article' }, { key: 'answered_count', label: 'Answers', num: true }, { key: 'helpful_count', label: 'Helpful', num: true }]} /></Card>
      </div>
    </>
  );
}

function Adoption() {
  const d = useLoad(() => api.get<any[]>('/reports/adoption'), []);
  if (!d.data) return d.error ? <ErrorBox error={d.error} /> : <Loading />;
  return (
    <Card eyebrow="Adoption measured weekly through hypercare">
      <LineChart series={[
        { name: 'Portal registrations', points: d.data.map((w) => ({ x: String(w.week).slice(0, 10), y: w.portal_registrations })) },
        { name: 'Self-service share %', points: d.data.map((w) => ({ x: String(w.week).slice(0, 10), y: Number(w.self_service_share ?? 0) })) },
        { name: 'Assist deflection %', points: d.data.map((w) => ({ x: String(w.week).slice(0, 10), y: Number(w.assist_deflection ?? 0) })) },
        { name: 'Self-service updates', points: d.data.map((w) => ({ x: String(w.week).slice(0, 10), y: w.self_service_updates })) },
      ]} />
      <Table rows={d.data} cols={[{ key: 'week', label: 'Week', render: (w: any) => String(w.week).slice(0, 10) }, { key: 'portal_registrations', label: 'Registrations', num: true }, { key: 'queries', label: 'Queries', num: true }, { key: 'self_service_share', label: 'Portal-logged %', num: true }, { key: 'assist_deflection', label: 'Deflection %', num: true }, { key: 'self_service_updates', label: 'Self-service updates', num: true }]} />
    </Card>
  );
}

function Builder() {
  const schema = useLoad(() => api.get('/reports/builder/schema'), []);
  const saved = useLoad(() => api.get<any[]>('/reports/saved'), []);
  const [def, setDef] = useState<any>({ dimensions: ['query_type'], metrics: ['count', 'avg_resolution_hours', 'sla_attainment'], period_days: 30 });
  const [out, setOut] = useState<any | null>(null);
  const [save, setSave] = useState({ name: '', schedule: '', format: 'pdf', recipients: '', shared: false });
  const a = useAction();
  if (!schema.data) return <Loading />;
  const toggle = (k: 'dimensions' | 'metrics', v: string) => setDef({ ...def, [k]: def[k].includes(v) ? def[k].filter((x: string) => x !== v) : [...def[k], v] });
  return (
    <div className="grid cols-2">
      <Card eyebrow="Define a report">
        <ErrorBox error={a.error} />
        <h3>Group by (up to three)</h3>
        <div className="row">{schema.data.dimensions.map((d: any) => <label key={d.key} className="inline-check"><input type="checkbox" checked={def.dimensions.includes(d.key)} onChange={() => toggle('dimensions', d.key)} />{d.label}</label>)}</div>
        <h3 style={{ marginTop: 12 }}>Measures</h3>
        <div className="row">{schema.data.metrics.map((m: any) => <label key={m.key} className="inline-check"><input type="checkbox" checked={def.metrics.includes(m.key)} onChange={() => toggle('metrics', m.key)} />{m.label}</label>)}</div>
        <div className="grid cols-2" style={{ marginTop: 12 }}>
          <Field label="Period"><select value={def.period_days} onChange={(e) => setDef({ ...def, period_days: Number(e.target.value) })}><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option><option value={365}>12 months</option></select></Field>
          <Field label="Port"><select value={def.filters?.port ?? ''} onChange={(e) => setDef({ ...def, filters: { ...def.filters, port: e.target.value || undefined } })}><option value="">Both</option><option value="WB">Walvis Bay</option><option value="LZ">Lüderitz</option></select></Field>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn primary" onClick={async () => setOut(await a.run(() => api.post('/reports/builder/run', def)))}>Run</button>
          {(['csv', 'xlsx', 'pdf'] as const).map((fmt) => <button key={fmt} className="btn" onClick={() => a.run(() => api.download('/reports/builder/export', { definition: def, format: fmt, title: save.name || 'Report' }))}>{fmt === 'xlsx' ? 'Excel' : fmt.toUpperCase()}</button>)}
        </div>
        <hr />
        <h3>Save and schedule</h3>
        <div className="grid cols-2">
          <Field label="Name"><input value={save.name} onChange={(e) => setSave({ ...save, name: e.target.value })} /></Field>
          <Field label="Email schedule"><select value={save.schedule} onChange={(e) => setSave({ ...save, schedule: e.target.value })}><option value="">Not scheduled</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></Field>
          <Field label="Format"><select value={save.format} onChange={(e) => setSave({ ...save, format: e.target.value })}><option value="pdf">PDF</option><option value="xlsx">Excel</option><option value="csv">CSV</option></select></Field>
          <Field label="Recipients (comma-separated)"><input value={save.recipients} onChange={(e) => setSave({ ...save, recipients: e.target.value })} /></Field>
        </div>
        <label className="inline-check" style={{ marginTop: 8 }}><input type="checkbox" checked={save.shared} onChange={(e) => setSave({ ...save, shared: e.target.checked })} />Share with colleagues</label>
        <div><button className="btn" style={{ marginTop: 8 }} disabled={!save.name} onClick={() => a.run(() => api.post('/reports/saved', { ...save, definition: def, recipients: save.recipients.split(',').map((s) => s.trim()).filter(Boolean) })).then(() => saved.reload(true))}>Save report</button></div>
      </Card>
      <div>
        <Card eyebrow="Result">
          {out ? <Table rows={out.rows} cols={out.columns.map((c: any) => ({ key: c.key, label: c.label, num: schema.data.metrics.some((m: any) => m.key === c.key), render: (r: any) => (typeof r[c.key] === 'string' ? label(r[c.key]) : r[c.key] ?? '—') }))} /> : <div className="empty">Run the report to see results</div>}
        </Card>
        <Card eyebrow="Saved reports">
          <Table rows={saved.data ?? []} empty="No saved reports yet" cols={[
            { key: 'name', label: 'Report', render: (r: any) => <button className="btn link" onClick={() => setDef(r.definition)}>{r.name}</button> },
            { key: 'schedule', label: 'Schedule', render: (r: any) => r.schedule ? <Badge tone="gold">{r.schedule} · {r.format}</Badge> : '—' },
            { key: 'owner_name', label: 'Owner' }, { key: 'last_run_at', label: 'Last sent', render: (r: any) => fmtDateTime(r.last_run_at) },
          ]} />
        </Card>
      </div>
    </div>
  );
}

export function Alerts() {
  const al = useLoad(() => api.get<any[]>('/admin/alerts?open=true'), [], { refreshMs: 30_000 });
  const a = useAction();
  return (
    <Card eyebrow="Breach and pre-breach alert centre">
      <ErrorBox error={a.error ?? al.error} />
      <Table rows={al.data ?? []} empty="No open alerts" cols={[
        { key: 'severity', label: '', render: (r: any) => <Badge tone={r.severity === 'critical' ? 'red' : r.severity === 'warning' ? 'amber' : undefined}>{label(r.kind)}</Badge> },
        { key: 'message', label: 'Alert', render: (r: any) => <div>{r.message}{r.reference && <> · <Link to={`/cases/${r.query_id}`}>{r.reference}</Link></>}{r.finding_reference && <> · <Link to={`/findings/${r.finding_id}`}>{r.finding_reference}</Link></>}</div> },
        { key: 'target_role', label: 'For', render: (r: any) => label(r.target_role) },
        { key: 'created_at', label: 'Raised', render: (r: any) => fmtDateTime(r.created_at) },
        { key: 'ack', label: '', render: (r: any) => <button className="btn sm" onClick={() => a.run(() => api.post(`/admin/alerts/${r.id}/ack`)).then(() => al.reload(true))}>Acknowledge</button> },
      ]} />
    </Card>
  );
}
