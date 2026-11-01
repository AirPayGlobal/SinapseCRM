import { useState } from 'react';
import { api, qs } from '../../api';
import { Badge, Card, ErrorBox, Field, JsonEditor, Loading, Modal, PageHead, Table, Tabs } from '../../components/ui';
import { fmtDateTime, label } from '../../format';
import { useAction, useLoad } from '../../hooks';
import { useCan, useStaff } from '../context';
import { Workflows } from './Workflows';

type Tab = 'workflows' | 'sla' | 'escalation' | 'queues' | 'types' | 'fields' | 'filters' | 'templates' | 'roles' | 'users' | 'availability' | 'integrations' | 'audit' | 'settings';

export default function Admin() {
  const can = useCan();
  const tabs: { key: Tab; label: string; perm: string[] }[] = [
    { key: 'workflows', label: 'Workflows', perm: ['admin.config'] },
    { key: 'sla', label: 'SLA & calendar', perm: ['admin.config'] },
    { key: 'escalation', label: 'Escalation matrix', perm: ['admin.config'] },
    { key: 'queues', label: 'Queues & assignment', perm: ['admin.config'] },
    { key: 'types', label: 'Query types', perm: ['admin.config'] },
    { key: 'fields', label: 'Custom fields', perm: ['admin.config'] },
    { key: 'filters', label: 'Filter rules', perm: ['admin.config'] },
    { key: 'templates', label: 'Templates', perm: ['admin.config'] },
    { key: 'roles', label: 'Roles & masking', perm: ['admin.security'] },
    { key: 'users', label: 'Users', perm: ['admin.users'] },
    { key: 'availability', label: 'Availability', perm: ['admin.users', 'query.reassign'] },
    { key: 'integrations', label: 'Integrations & API', perm: ['integration.manage'] },
    { key: 'audit', label: 'Audit log', perm: ['audit.read'] },
    { key: 'settings', label: 'Settings', perm: ['admin.config'] },
  ].filter((t) => can(...t.perm)) as any;
  const [tab, setTab] = useState<Tab>(tabs[0]?.key ?? 'availability');
  return (
    <>
      <PageHead title="Administration" sub="Fields, taxonomies, workflows, templates, the escalation matrix and service targets are data — changed here, effective immediately, recorded in the audit log." />
      <Tabs value={tab} onChange={setTab} tabs={tabs} />
      {tab === 'workflows' && <Workflows />}
      {tab === 'sla' && <Sla />}
      {tab === 'escalation' && <ConfigTable path="/admin/escalation-matrices" title="Escalation matrices — resolved by query type, department and tier; targets are roles"
        json={['levels']} defaults={{ name: '', account_tier: '', levels: [{ level: 1, after_minutes: 0, target_role: 'supervisor', template: 'escalation', channels: ['in_app', 'teams'] }], active: true }}
        cols={[{ key: 'name', label: 'Matrix' }, { key: 'account_tier', label: 'Tier', render: (r) => r.account_tier ?? 'Any' }, { key: 'query_type_key', label: 'Type', render: (r) => r.query_type_key ?? 'Any' },
          { key: 'levels', label: 'Levels', render: (r) => r.levels.map((l: any) => `L${l.level}: ${label(l.target_role)} +${l.after_minutes} min`).join(' → ') }]} />}
      {tab === 'queues' && <ConfigTable path="/admin/queues" title="Queues — strategy per queue: round robin, least loaded or skills-based"
        defaults={{ key: '', name: '', strategy: 'least_loaded', eligible_roles: ['agent', 'supervisor'], required_skills: [], active: true }}
        cols={[{ key: 'name', label: 'Queue' }, { key: 'strategy', label: 'Strategy', render: (r) => label(r.strategy) }, { key: 'eligible_roles', label: 'Eligible roles', render: (r) => r.eligible_roles.join(', ') }, { key: 'required_skills', label: 'Required skills', render: (r) => r.required_skills.join(', ') || '—' }, { key: 'port_code', label: 'Port', render: (r) => r.port_code ?? 'Both' }]} />}
      {tab === 'types' && <ConfigTable path="/admin/query-types" pk="key" title="Query types — drive workflow, queue, weight and the service clock"
        defaults={{ key: '', name: '', workflow_key: 'default', queue_key: 'customer-care', default_urgency: 'normal', weight: 1, skill: '', assist_routable: true, active: true, training_examples: [] }}
        cols={[{ key: 'name', label: 'Type' }, { key: 'workflow_key', label: 'Workflow' }, { key: 'queue_key', label: 'Queue' }, { key: 'weight', label: 'Load weight', num: true }, { key: 'skill', label: 'Skill' }, { key: 'training_examples', label: 'Training examples', num: true, render: (r) => r.training_examples.length }]} />}
      {tab === 'fields' && <ConfigTable path="/admin/custom-fields" title="Custom fields — type, validation, default, help text, visibility by role and query type"
        json={['validation', 'default_value']} defaults={{ entity: 'query', key: '', label: '', field_type: 'text', required: false, options: [], validation: {}, default_value: null, help_text: '', visible_roles: [], query_types: [], customer_visible: false, sort_order: 0, active: true }}
        cols={[{ key: 'entity', label: 'Entity' }, { key: 'label', label: 'Field' }, { key: 'field_type', label: 'Type' }, { key: 'query_types', label: 'Query types', render: (r) => r.query_types.join(', ') || 'All' }, { key: 'visible_roles', label: 'Visible to', render: (r) => r.visible_roles.join(', ') || 'All staff' }, { key: 'customer_visible', label: 'Portal', render: (r) => (r.customer_visible ? 'Yes' : 'No') }]} />}
      {tab === 'filters' && <ConfigTable path="/admin/filter-rules" title="Irrelevant-traffic keyword rules (the intent classifier sits behind these)"
        defaults={{ pattern: '', category: 'recruitment', active: true }} cols={[{ key: 'pattern', label: 'Keyword or phrase' }, { key: 'category', label: 'Category' }, { key: 'active', label: 'Active', render: (r) => (r.active ? 'Yes' : 'No') }]} />}
      {tab === 'templates' && <ConfigTable path="/admin/templates" pk="key" title="Notification templates — {{placeholders}} are filled per event"
        defaults={{ key: '', subject: '', body: '', channels: ['email'] }} cols={[{ key: 'key', label: 'Event' }, { key: 'subject', label: 'Subject' }, { key: 'channels', label: 'Channels', render: (r) => r.channels.join(', ') }]} />}
      {tab === 'roles' && <ConfigTable path="/admin/roles" pk="key" title="Roles — permissions, record scope by port and department, and field masks (applied to screens, exports and reports alike)"
        defaults={{ key: '', name: '', permissions: [], port_scope: 'own', dept_scope: 'all', field_masks: [], landing_view: 'queue' }}
        cols={[{ key: 'name', label: 'Role' }, { key: 'permissions', label: 'Permissions', render: (r) => <span className="small">{r.permissions.join(', ')}</span> }, { key: 'port_scope', label: 'Ports' }, { key: 'dept_scope', label: 'Departments' }, { key: 'field_masks', label: 'Masked fields', render: (r) => r.field_masks.join(', ') || '—' }]} />}
      {tab === 'users' && <Users />}
      {tab === 'availability' && <Availability />}
      {tab === 'integrations' && <Integrations />}
      {tab === 'audit' && <Audit />}
      {tab === 'settings' && <Settings />}
    </>
  );
}

/** Generic, audited editor for a configuration table. */
function ConfigTable({ path, title, cols, defaults, json = [], pk = 'id' }: { path: string; title: string; cols: { key: string; label: string; render?: (r: any) => any; num?: boolean }[]; defaults: Record<string, any>; json?: string[]; pk?: string }) {
  const rows = useLoad(() => api.get<any[]>(path), [path]);
  const [edit, setEdit] = useState<any | null>(null);
  const a = useAction();
  return (
    <Card title={title} actions={<button className="btn primary" onClick={() => setEdit({ ...defaults, __new: true })}>Add</button>}>
      <ErrorBox error={rows.error} />
      {rows.loading ? <Loading /> : <Table rows={rows.data ?? []} onRow={(r) => setEdit(r)} cols={cols} />}
      {edit && <Modal title={edit.__new ? 'Add' : `Edit ${edit.name ?? edit.label ?? edit.key ?? edit.pattern ?? ''}`} onClose={() => setEdit(null)}>
        <ErrorBox error={a.error} />
        <div className="stack">
          {Object.keys(defaults).map((k) => {
            const v = edit[k];
            if (json.includes(k) || (typeof defaults[k] === 'object' && defaults[k] !== null && !Array.isArray(defaults[k]))) return <Field key={k} label={label(k)}><JsonEditor value={v} onChange={(x) => setEdit({ ...edit, [k]: x })} rows={k === 'levels' ? 12 : 5} /></Field>;
            if (Array.isArray(defaults[k])) return <Field key={k} label={`${label(k)} (comma-separated)`}>{k === 'training_examples' ? <textarea value={(v ?? []).join('\n')} onChange={(e) => setEdit({ ...edit, [k]: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })} placeholder="One example per line" /> : <input value={(v ?? []).join(', ')} onChange={(e) => setEdit({ ...edit, [k]: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />}</Field>;
            if (typeof defaults[k] === 'boolean') return <label key={k} className="inline-check"><input type="checkbox" checked={!!v} onChange={(e) => setEdit({ ...edit, [k]: e.target.checked })} />{label(k)}</label>;
            if (k === 'body') return <Field key={k} label="Body"><textarea rows={8} value={v ?? ''} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} /></Field>;
            return <Field key={k} label={label(k)}><input value={v ?? ''} type={typeof defaults[k] === 'number' ? 'number' : 'text'} disabled={!edit.__new && k === pk} onChange={(e) => setEdit({ ...edit, [k]: typeof defaults[k] === 'number' ? Number(e.target.value) : e.target.value || (k.endsWith('_key') || k === 'account_tier' || k === 'skill' ? null : '') })} /></Field>;
          })}
          <div className="row">
            <button className="btn primary" onClick={async () => {
              const body = Object.fromEntries(Object.keys(defaults).map((k) => [k, edit[k] === '' && (k === 'account_tier' || k === 'skill') ? null : edit[k]]));
              const r = await a.run(() => (edit.__new ? api.post(path, body) : api.patch(`${path}/${encodeURIComponent(edit[pk])}`, body)));
              if (r) { setEdit(null); void rows.reload(true); }
            }}>Save</button>
            {!edit.__new && <button className="btn danger" onClick={async () => {
              if (!confirm('Delete this entry?')) return;
              const ok = await a.run(() => api.del(`${path}/${encodeURIComponent(edit[pk])}`).then(() => true));
              if (ok) { setEdit(null); void rows.reload(true); }
            }}>Delete</button>}
          </div>
        </div>
      </Modal>}
    </Card>
  );
}

function Sla() {
  const cals = useLoad(() => api.get<any[]>('/admin/calendars'), []);
  const [cal, setCal] = useState('');
  const calId = cal || cals.data?.[0]?.id;
  const hol = useLoad(() => (calId ? api.get<any[]>(`/admin/calendars/${calId}/holidays`) : Promise.resolve([])), [calId]);
  const [nh, setNh] = useState({ day: '', name: '' });
  const a = useAction();
  return (
    <>
      <ConfigTable path="/admin/sla-policies" title="SLA policies — business minutes; Top 10 and priority tiers carry shorter targets"
        json={['tier_overrides', 'urgency_multipliers']} defaults={{ name: '', calendar_id: '', first_response_minutes: 240, resolution_minutes: 1440, tier_overrides: {}, urgency_multipliers: { low: 1.5, normal: 1, high: 0.5, critical: 0.25 }, pre_breach_percent: 80 }}
        cols={[{ key: 'name', label: 'Policy' }, { key: 'first_response_minutes', label: 'First response (min)', num: true }, { key: 'resolution_minutes', label: 'Resolution (min)', num: true }, { key: 'pre_breach_percent', label: 'Pre-breach at %', num: true }, { key: 'tier_overrides', label: 'Tier overrides', render: (r) => <span className="small mono">{JSON.stringify(r.tier_overrides)}</span> }]} />
      <ConfigTable path="/admin/calendars" title="Service calendars — business hours in local time (CAT, UTC+2)" json={['business_hours']}
        defaults={{ name: '', utc_offset_minutes: 120, business_hours: { 1: [['07:30', '16:30']] } }} cols={[{ key: 'name', label: 'Calendar' }, { key: 'business_hours', label: 'Hours', render: (r) => <span className="small mono">{Object.entries(r.business_hours).map(([d, h]: any) => `${'SMTWTFS'[Number(d)]}:${h.map((x: string[]) => x.join('–')).join(',') || 'closed'}`).join(' ')}</span> }]} />
      <Card title="Public holidays" actions={<>
        <select value={calId ?? ''} onChange={(e) => setCal(e.target.value)} style={{ width: 'auto' }}>{(cals.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <button className="btn" onClick={() => { const y = prompt('Generate Namibian public holidays for year', String(new Date().getFullYear() + 1)); if (y) void a.run(() => api.post(`/admin/calendars/${calId}/holidays/generate`, { year: Number(y) })).then(() => hol.reload(true)); }}>Generate Namibian holidays</button>
      </>}>
        <ErrorBox error={a.error} />
        <div className="row" style={{ marginBottom: 8 }}>
          <input type="date" value={nh.day} onChange={(e) => setNh({ ...nh, day: e.target.value })} style={{ width: 170 }} />
          <input placeholder="Name (e.g. special public holiday)" value={nh.name} onChange={(e) => setNh({ ...nh, name: e.target.value })} style={{ width: 300 }} />
          <button className="btn primary" disabled={!nh.day || !nh.name} onClick={() => a.run(() => api.post(`/admin/calendars/${calId}/holidays`, nh)).then(() => { setNh({ day: '', name: '' }); void hol.reload(true); })}>Add holiday</button>
        </div>
        <Table rows={(hol.data ?? []).filter((h) => h.day >= new Date().toISOString().slice(0, 10)).slice(0, 40)} cols={[
          { key: 'day', label: 'Date' }, { key: 'name', label: 'Holiday' },
          { key: 'x', label: '', render: (h: any) => <button className="btn sm danger" onClick={() => a.run(() => api.del(`/admin/calendars/${calId}/holidays/${h.day}`)).then(() => hol.reload(true))}>Remove</button> },
        ]} />
      </Card>
    </>
  );
}

function Users() {
  const { ref } = useStaff();
  const u = useLoad(() => api.get<any[]>('/admin/users'), []);
  const [edit, setEdit] = useState<any | null>(null);
  const a = useAction();
  return (
    <Card title="Staff users" actions={<button className="btn primary" onClick={() => setEdit({ __new: true, email: '', name: '', role_key: 'agent', port_code: 'WB', department_id: '', skills: [], capacity: 20, active: true })}>Add user</button>}>
      <p className="small muted">With Entra ID SCIM provisioning enabled, joiners, movers and leavers flow automatically; a leaver loses access on their next request.</p>
      <Table rows={u.data ?? []} onRow={(r) => setEdit(r)} cols={[
        { key: 'name', label: 'Name', render: (r: any) => <div><b>{r.name}</b><div className="small muted">{r.email}</div></div> },
        { key: 'role_key', label: 'Role', render: (r: any) => label(r.role_key) }, { key: 'port_code', label: 'Port', render: (r: any) => r.port_code ?? 'Both' },
        { key: 'department_name', label: 'Department' }, { key: 'skills', label: 'Skills', render: (r: any) => r.skills.join(', ') }, { key: 'capacity', label: 'Capacity', num: true },
        { key: 'flags', label: '', render: (r: any) => <div className="row">{!r.active && <Badge tone="red">Inactive</Badge>}{r.sso_linked && <Badge>SSO</Badge>}{r.scim_managed && <Badge>SCIM</Badge>}</div> },
      ]} />
      {edit && <Modal title={edit.__new ? 'Add user' : edit.name} onClose={() => setEdit(null)}>
        <ErrorBox error={a.error} />
        <div className="stack">
          {edit.__new && <Field label="Email"><input value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></Field>}
          <Field label="Name"><input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
          <div className="grid cols-2">
            <Field label="Role"><select value={edit.role_key} onChange={(e) => setEdit({ ...edit, role_key: e.target.value })}>{ref.roles.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}</select></Field>
            <Field label="Port"><select value={edit.port_code ?? ''} onChange={(e) => setEdit({ ...edit, port_code: e.target.value || null })}><option value="">Both</option>{ref.ports.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</select></Field>
            <Field label="Department"><select value={edit.department_id ?? ''} onChange={(e) => setEdit({ ...edit, department_id: e.target.value || null })}><option value="">—</option>{ref.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
            <Field label="Weighted capacity"><input type="number" value={edit.capacity} onChange={(e) => setEdit({ ...edit, capacity: Number(e.target.value) })} /></Field>
          </div>
          <Field label="Skills (comma-separated)"><input value={edit.skills.join(', ')} onChange={(e) => setEdit({ ...edit, skills: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} /></Field>
          <Field label="Password (local sign-in only; leave blank to keep)"><input type="password" value={edit.password ?? ''} onChange={(e) => setEdit({ ...edit, password: e.target.value })} /></Field>
          {!edit.__new && <label className="inline-check"><input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} />Active</label>}
          <button className="btn primary" onClick={async () => {
            const { __new, id, email, name, role_key, port_code, department_id, skills, capacity, active, password } = edit;
            const r = await a.run(() => (__new ? api.post('/admin/users', { email, name, role_key, port_code, department_id, skills, capacity, password }) : api.patch(`/admin/users/${id}`, { name, role_key, port_code, department_id, skills, capacity, active, password: password || undefined })));
            if (r) { setEdit(null); void u.reload(true); }
          }}>Save</button>
        </div>
      </Modal>}
    </Card>
  );
}

/** Agent availability board (S-20): presence, Outlook out-of-office, leave and live weighted load. */
export function Availability() {
  const av = useLoad(() => api.get<any[]>('/admin/availability'), [], { refreshMs: 30_000 });
  const a = useAction();
  const set = async (id: string, body: any) => { await a.run(() => api.patch(`/admin/availability/${id}`, body)); void av.reload(true); };
  return (
    <Card title="Agent availability" actions={<span className="small muted">Out-of-office and leave are read from Outlook calendars through Microsoft Graph</span>}>
      <ErrorBox error={a.error} />
      <Table rows={av.data ?? []} cols={[
        { key: 'name', label: 'Agent', render: (r: any) => <div><b>{r.name}</b><div className="small muted">{r.port_code} · {r.department_name} · {r.skills.join(', ')}</div></div> },
        { key: 'presence', label: 'Presence', render: (r: any) => <select value={r.presence} style={{ width: 'auto' }} onChange={(e) => set(r.id, { presence: e.target.value })}>{['available', 'busy', 'away', 'offline'].map((p) => <option key={p}>{p}</option>)}</select> },
        { key: 'ooo', label: 'Out of office', render: (r: any) => r.out_of_office ? <div><Badge tone="amber">OOO{r.source === 'graph' ? ' (Outlook)' : ''}</Badge><div className="small muted">until {fmtDateTime(r.ooo_until)}</div><button className="btn sm" onClick={() => set(r.id, { out_of_office: false })}>Clear</button></div> : <button className="btn sm" onClick={() => { const d = prompt('Out of office until (YYYY-MM-DD)'); if (d) void set(r.id, { out_of_office: true, ooo_until: new Date(d).toISOString() }); }}>Set OOO</button> },
        { key: 'leave', label: 'Leave', render: (r: any) => (r.leave ?? []).map((l: any, i: number) => <div key={i} className="small">{fmtDateTime(l.starts_at)} – {fmtDateTime(l.ends_at)}</div>) },
        { key: 'load', label: 'Weighted load', render: (r: any) => <div className="bar" style={{ gridTemplateColumns: '100px 70px' }}><div className="track"><div className="fill" style={{ width: `${Math.min(100, (100 * r.load) / r.capacity)}%`, background: r.load >= r.capacity ? 'var(--red)' : undefined }} /></div><span className="n">{r.load.toFixed(1)}/{r.capacity}</span></div> },
        { key: 'open_cases', label: 'Open', num: true },
      ]} />
    </Card>
  );
}

function Integrations() {
  const { ref } = useStaff();
  const health = useLoad(() => api.get<any[]>('/admin/integrations'), [], { refreshMs: 30_000 });
  const hooks = useLoad(() => api.get<any[]>('/admin/webhooks'), []);
  const keys = useLoad(() => api.get<any[]>('/admin/api-clients'), []);
  const [log, setLog] = useState<string | null>(null);
  const logRows = useLoad(() => (log ? api.get<any[]>(`/admin/integrations/${log}/log`) : Promise.resolve([])), [log]);
  const [secret, setSecret] = useState<string | null>(null);
  const a = useAction();
  const tone = (s: string) => (s === 'healthy' ? 'green' : s === 'degraded' ? 'amber' : s === 'down' || s === 'revoked' ? 'red' : undefined) as any;
  return (
    <>
      <ErrorBox error={a.error} />
      {secret && <div className="alert ok">Copy this now — it will not be shown again: <code>{secret}</code></div>}
      <Card title="Integration health" actions={<a className="btn" href="/api/v1/openapi.json" target="_blank" rel="noreferrer">REST API (OpenAPI)</a>}>
        <Table rows={health.data ?? []} cols={[
          { key: 'name', label: 'Connector' }, { key: 'status', label: 'Status', render: (r: any) => <Badge tone={tone(r.status)}>{label(r.status)}</Badge> },
          { key: 'last_success_at', label: 'Last success', render: (r: any) => fmtDateTime(r.last_success_at) }, { key: 'calls_24h', label: 'Calls 24 h', num: true },
          { key: 'failures_24h', label: 'Failures 24 h', num: true }, { key: 'dead_letters', label: 'Dead letters', num: true },
          { key: 'last_error', label: 'Last error', render: (r: any) => <span className="small">{r.last_error ?? '—'}</span> },
          { key: 'x', label: '', render: (r: any) => <div className="row">
            <button className="btn sm" onClick={() => setLog(r.key)}>Log</button>
            {r.enabled && r.status !== 'revoked' ? <button className="btn sm danger" onClick={() => confirm(`Revoke ${r.name}? It stops immediately, without a release.`) && a.run(() => api.post(`/admin/integrations/${r.key}/revoke`)).then(() => health.reload(true))}>Revoke</button>
              : <button className="btn sm" onClick={() => a.run(() => api.post(`/admin/integrations/${r.key}/enable`)).then(() => health.reload(true))}>Enable</button>}
          </div> },
        ]} />
      </Card>
      {log && <Card title={`Integration log — ${log}`} actions={<button className="btn" onClick={() => setLog(null)}>Close</button>}>
        <Table rows={logRows.data ?? []} cols={[{ key: 'created_at', label: 'When', render: (r: any) => fmtDateTime(r.created_at) }, { key: 'direction', label: 'Dir.' }, { key: 'operation', label: 'Operation' },
          { key: 'status', label: 'Status', render: (r: any) => <Badge tone={r.status === 'success' ? 'green' : r.status === 'duplicate' ? undefined : 'red'}>{r.status}</Badge> }, { key: 'correlation_id', label: 'Correlation', render: (r: any) => <span className="mono small">{r.correlation_id}</span> },
          { key: 'error', label: 'Detail', render: (r: any) => <span className="small">{r.error ?? (r.payload ? JSON.stringify(r.payload).slice(0, 120) : '')}</span> }]} />
      </Card>}
      <Card title="Outbound webhooks — HMAC-signed, retried, dead-lettered" actions={<button className="btn primary" onClick={async () => {
        const name = prompt('Name'); const url = name && prompt('HTTPS URL'); const events = url && prompt(`Events (comma-separated):\n${ref.webhook_events.join(', ')}`, 'query.created,query.resolved');
        if (name && url && events) { const r = await a.run(() => api.post('/admin/webhooks', { name, url, events: events.split(',').map((s) => s.trim()) })); if (r) { setSecret(r.secret); void hooks.reload(true); } }
      }}>Add webhook</button>}>
        <Table rows={hooks.data ?? []} cols={[{ key: 'name', label: 'Name' }, { key: 'url', label: 'URL', render: (r: any) => <span className="mono small">{r.url}</span> }, { key: 'events', label: 'Events', render: (r: any) => r.events.join(', ') },
          { key: 'dead_letters', label: 'Dead letters', num: true }, { key: 'x', label: '', render: (r: any) => <button className="btn sm danger" onClick={() => a.run(() => api.del(`/admin/webhooks/${r.id}`)).then(() => hooks.reload(true))}>Delete</button> }]} />
      </Card>
      <Card title="API keys for system integrations" actions={<button className="btn primary" onClick={async () => {
        const name = prompt('System name'); const role = name && prompt(`Role (${ref.roles.map((r) => r.key).join(', ')})`, 'auditor');
        if (name && role) { const r = await a.run(() => api.post('/admin/api-clients', { name, role_key: role })); if (r) { setSecret(r.api_key); void keys.reload(true); } }
      }}>Issue key</button>}>
        <Table rows={keys.data ?? []} cols={[{ key: 'name', label: 'System' }, { key: 'role_key', label: 'Role' }, { key: 'active', label: 'Active', render: (r: any) => (r.active ? 'Yes' : 'Revoked') }, { key: 'created_at', label: 'Issued', render: (r: any) => fmtDateTime(r.created_at) },
          { key: 'x', label: '', render: (r: any) => r.active && <button className="btn sm danger" onClick={() => a.run(() => api.post(`/admin/api-clients/${r.id}/revoke`)).then(() => keys.reload(true))}>Revoke</button> }]} />
      </Card>
    </>
  );
}

function Audit() {
  const [f, setF] = useState({ action: '', entity: '', entity_id: '', actor: '', from: '', to: '' });
  const [applied, setApplied] = useState(f);
  const rows = useLoad(() => api.get<any[]>(`/admin/audit${qs(applied)}`), [JSON.stringify(applied)]);
  const [verify, setVerify] = useState<any | null>(null);
  const [open, setOpen] = useState<any | null>(null);
  const a = useAction();
  return (
    <Card title="Audit log — append-only, hash-sealed" actions={<>
      <button className="btn" onClick={async () => setVerify(await a.run(() => api.get('/admin/audit/verify')))}>Verify integrity</button>
      <button className="btn" onClick={() => api.download(`/admin/audit/export${qs({ ...applied, format: 'csv' })}`)}>Export CSV</button>
      <button className="btn" onClick={() => api.download(`/admin/audit/export${qs({ ...applied, format: 'jsonl' })}`)}>Export JSONL (SIEM)</button>
    </>}>
      <ErrorBox error={a.error ?? rows.error} />
      {verify && <div className={`alert ${verify.intact ? 'ok' : 'error'}`}>{verify.intact ? `Intact: ${verify.entries} entries, ${verify.sealed} sealed, chain head ${String(verify.head).slice(0, 16)}…` : `Integrity failure: ${verify.tampered_rows} altered row(s), ${verify.broken_links} broken link(s). First affected: ${verify.first_tampered_id ?? verify.first_broken_seq}`} · checked {fmtDateTime(verify.verified_at)}</div>}
      <div className="row" style={{ marginBottom: 10 }}>
        {(['action', 'entity', 'entity_id', 'actor'] as const).map((k) => <input key={k} placeholder={label(k)} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} style={{ width: 160 }} />)}
        <input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} style={{ width: 150 }} aria-label="From" />
        <input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} style={{ width: 150 }} aria-label="To" />
        <button className="btn primary" onClick={() => setApplied(f)}>Filter</button>
      </div>
      <Table rows={rows.data ?? []} onRow={setOpen} cols={[
        { key: 'id', label: '#', num: true }, { key: 'occurred_at', label: 'When', render: (r: any) => fmtDateTime(r.occurred_at) },
        { key: 'actor_name', label: 'Actor', render: (r: any) => `${r.actor_name ?? ''} (${r.actor_type})` }, { key: 'action', label: 'Action', render: (r: any) => <span className="mono">{r.action}</span> },
        { key: 'entity', label: 'Record', render: (r: any) => <span className="small">{r.entity} {r.entity_id?.slice(0, 8)}</span> }, { key: 'ip', label: 'IP' },
      ]} />
      {open && <Modal title={`${open.action} #${open.id}`} onClose={() => setOpen(null)}>
        <div className="grid cols-2"><div><h3>Before</h3><pre>{JSON.stringify(open.before, null, 2)}</pre></div><div><h3>After</h3><pre>{JSON.stringify(open.after, null, 2)}</pre></div></div>
        <div className="small muted mono">hash {open.hash} · request {open.request_id}</div>
      </Modal>}
    </Card>
  );
}

function Settings() {
  const s = useLoad(() => api.get<Record<string, any>>('/admin/settings'), []);
  const a = useAction();
  const [saved, setSaved] = useState<string | null>(null);
  if (!s.data) return <Loading />;
  return (
    <Card title="System settings">
      <ErrorBox error={a.error} />
      {saved && <div className="alert ok">Saved {saved}</div>}
      <Table rows={Object.entries(s.data).filter(([k]) => !k.startsWith('graph.')).map(([key, value]) => ({ key, value }))} cols={[
        { key: 'key', label: 'Setting', render: (r: any) => <span className="mono">{r.key}</span> },
        { key: 'value', label: 'Value', render: (r: any) => <input defaultValue={typeof r.value === 'string' ? r.value : JSON.stringify(r.value)} onBlur={async (e) => {
          let v: any = e.target.value; try { v = JSON.parse(v); } catch { /* keep as string */ }
          if (JSON.stringify(v) !== JSON.stringify(r.value) && (await a.run(() => api.put(`/admin/settings/${r.key}`, { value: v }).then(() => true)))) setSaved(r.key);
        }} /> },
      ]} />
    </Card>
  );
}
