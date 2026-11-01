import { useEffect, useState } from 'react';
import { api } from '../../api';
import { Badge, Card, ErrorBox, Loading, Table } from '../../components/ui';
import { fmtDateTime, label } from '../../format';
import { useAction, useLoad } from '../../hooks';

const CATEGORIES = ['intake', 'open', 'paused', 'resolved', 'closed', 'filtered', 'merged'];
const CLOCKS = ['running', 'paused', 'stopped'];
const GUARDS = ['has_assignee', 'has_resolution_note', 'classification_confirmed', 'has_customer', 'has_reason', 'within_review_window'];
const ACTIONS = ['notify_customer:query_resolved', 'notify_customer:awaiting_customer', 'notify_customer:query_assigned_customer', 'notify_assignee:query_assigned', 'record_first_response', 'request_satisfaction', 'increment_reopen', 'run_assignment'];

/**
 * Workflow designer (S-16). States, transitions, guards, automated actions and the SLA-pause
 * behaviour of each state are edited here and published as a new version. In-flight cases
 * complete on the version they started under.
 */
export function Workflows() {
  const list = useLoad(() => api.get<any[]>('/admin/workflows'), []);
  const policies = useLoad(() => api.get<any[]>('/admin/sla-policies'), []);
  const [sel, setSel] = useState<string | null>(null);
  const [w, setW] = useState<any | null>(null);
  const [preview, setPreview] = useState<any | null>(null);
  const a = useAction();
  useEffect(() => { if (!sel && list.data?.length) setSel(list.data.find((x) => x.status === 'published')?.id ?? list.data[0].id); }, [list.data, sel]);
  useEffect(() => { if (sel) api.get(`/admin/workflows/${sel}`).then((x) => { setW(x); setPreview(null); }); }, [sel]);
  if (!list.data) return <Loading />;
  const draft = w?.status === 'draft';
  const def = w?.definition;
  const update = (d: any) => setW({ ...w, definition: d });
  const setState = (i: number, patch: any) => update({ ...def, states: def.states.map((s: any, j: number) => (i === j ? { ...s, ...patch } : s)) });
  const setTr = (i: number, patch: any) => update({ ...def, transitions: def.transitions.map((t: any, j: number) => (i === j ? { ...t, ...patch } : t)) });
  const keys = def?.states.map((s: any) => s.key) ?? [];

  return (
    <div className="grid" style={{ gridTemplateColumns: 'minmax(220px, 280px) minmax(0, 1fr)' }}>
      <Card eyebrow="Versions">
        {list.data.map((v) => (
          <button key={v.id} className={`qitem ${sel === v.id ? 'active' : ''}`} style={{ width: '100%', textAlign: 'left', cursor: 'pointer' }} onClick={() => setSel(v.id)}>
            <div className="title">{v.workflow_key} · v{v.version}</div>
            <div className="row small"><Badge tone={v.status === 'published' ? 'green' : v.status === 'draft' ? 'gold' : undefined}>{v.status}</Badge>{v.open_cases > 0 && <span className="muted">{v.open_cases} open cases</span>}</div>
            {v.published_at && <div className="small muted">Published {fmtDateTime(v.published_at)}{v.published_by_name ? ` by ${v.published_by_name}` : ''}</div>}
          </button>
        ))}
        <hr />
        <button className="btn" onClick={async () => { const key = prompt('New workflow key (for a new query-type lifecycle)'); if (key && w) { const r = await a.run(() => api.post('/admin/workflows', { workflow_key: key, definition: w.definition, sla_policy_id: w.sla_policy_id })); if (r) { await list.reload(true); setSel(r.id); } } }}>New workflow</button>
      </Card>
      {w && def && (
        <div>
          <Card title={`${w.workflow_key} · version ${w.version}`} actions={<>
            {!draft && <button className="btn primary" onClick={async () => { const r = await a.run(() => api.post('/admin/workflows', { workflow_key: w.workflow_key, from_id: w.id })); if (r) { await list.reload(true); setSel(r.id); } }}>Create draft from this version</button>}
            {draft && <>
              <button className="btn" onClick={async () => { const r = await a.run(() => api.patch(`/admin/workflows/${w.id}`, { definition: def, sla_policy_id: w.sla_policy_id })); if (r) setPreview({ validation_errors: r.validation_errors, saved: true }); }}>Save draft</button>
              <button className="btn" onClick={async () => setPreview(await a.run(() => api.post(`/admin/workflows/${w.id}/preview`, { definition: def })))}>Preview against history</button>
              <button className="btn gold" onClick={async () => { if (!confirm('Publish? New cases use this version; in-flight cases keep theirs.')) return; await a.run(() => api.patch(`/admin/workflows/${w.id}`, { definition: def })); const r = await a.run(() => api.post(`/admin/workflows/${w.id}/publish`)); if (r) { await list.reload(true); setSel(r.id); api.get(`/admin/workflows/${r.id}`).then(setW); } }}>Publish</button>
            </>}
          </>}>
            <ErrorBox error={a.error} />
            {!draft && <div className="alert info small">Published and retired versions are immutable. Create a draft to change the lifecycle.</div>}
            <div className="row">
              <label className="field" style={{ maxWidth: 320 }}><span>SLA policy</span>
                <select disabled={!draft} value={w.sla_policy_id ?? ''} onChange={(e) => setW({ ...w, sla_policy_id: e.target.value })}>{(policies.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
              </label>
              <label className="field" style={{ maxWidth: 220 }}><span>Initial state</span>
                <select disabled={!draft} value={def.initial} onChange={(e) => update({ ...def, initial: e.target.value })}>{keys.map((k: string) => <option key={k}>{k}</option>)}</select>
              </label>
            </div>
            {preview && (
              <div className={`alert ${preview.validation_errors?.length || preview.incompatible_transitions?.length ? 'error' : 'ok'}`} style={{ marginTop: 10 }}>
                {preview.validation_errors?.length ? <div><b>Validation:</b> {preview.validation_errors.join('; ')}</div> : <div>Definition is valid.{preview.saved && ' Draft saved.'}</div>}
                {preview.cases_examined != null && <div>Replayed {preview.transitions_examined} transitions from {preview.cases_examined} recent cases: {preview.incompatible_transitions.length ? preview.incompatible_transitions.map((t: any) => `${t.transition} (${t.occurrences}×)`).join(', ') + ' would no longer be permitted' : 'all remain permitted'}.</div>}
              </div>
            )}
          </Card>
          <Card eyebrow="States — the clock column decides whether time counts against Namport" className="wf-table">
            <Table rows={def.states.map((s: any, i: number) => ({ ...s, i }))} cols={[
              { key: 'key', label: 'Key', render: (s: any) => <input disabled={!draft} value={s.key} onChange={(e) => setState(s.i, { key: e.target.value })} /> },
              { key: 'label', label: 'Staff label', render: (s: any) => <input disabled={!draft} value={s.label} onChange={(e) => setState(s.i, { label: e.target.value })} /> },
              { key: 'customer_label', label: 'Customer sees', render: (s: any) => <input disabled={!draft} value={s.customer_label ?? ''} onChange={(e) => setState(s.i, { customer_label: e.target.value })} /> },
              { key: 'category', label: 'Category', render: (s: any) => <select disabled={!draft} value={s.category} onChange={(e) => setState(s.i, { category: e.target.value })}>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select> },
              { key: 'clock', label: 'Service clock', render: (s: any) => <select disabled={!draft} value={s.clock} onChange={(e) => setState(s.i, { clock: e.target.value })}>{CLOCKS.map((c) => <option key={c}>{c}</option>)}</select> },
              { key: 'x', label: '', render: (s: any) => draft && <button className="btn sm danger" onClick={() => update({ ...def, states: def.states.filter((_: any, j: number) => j !== s.i) })}>Remove</button> },
            ]} />
            {draft && <button className="btn" style={{ marginTop: 8 }} onClick={() => update({ ...def, states: [...def.states, { key: 'new_state', label: 'New state', category: 'open', clock: 'running' }] })}>Add state</button>}
          </Card>
          <Card eyebrow="Transitions — guards must hold; actions run automatically" className="wf-table">
            <Table rows={def.transitions.map((t: any, i: number) => ({ ...t, i }))} cols={[
              { key: 'from', label: 'From', render: (t: any) => <select disabled={!draft} value={t.from} onChange={(e) => setTr(t.i, { from: e.target.value })}><option value="*">any open</option>{keys.map((k: string) => <option key={k}>{k}</option>)}</select> },
              { key: 'to', label: 'To', render: (t: any) => <select disabled={!draft} value={t.to} onChange={(e) => setTr(t.i, { to: e.target.value })}>{keys.map((k: string) => <option key={k}>{k}</option>)}</select> },
              { key: 'label', label: 'Button label', render: (t: any) => <input disabled={!draft} value={t.label} onChange={(e) => setTr(t.i, { label: e.target.value })} /> },
              { key: 'guards', label: 'Guards', render: (t: any) => <MultiPick disabled={!draft} options={GUARDS} value={t.guards ?? []} onChange={(v) => setTr(t.i, { guards: v })} /> },
              { key: 'actions', label: 'Actions', render: (t: any) => <MultiPick disabled={!draft} options={ACTIONS} value={t.actions ?? []} onChange={(v) => setTr(t.i, { actions: v })} /> },
              { key: 'who', label: 'Who', render: (t: any) => <div className="stack small">
                <label className="inline-check"><input type="checkbox" disabled={!draft} checked={!!t.customer_allowed} onChange={(e) => setTr(t.i, { customer_allowed: e.target.checked })} />Customer</label>
                <label className="inline-check"><input type="checkbox" disabled={!draft} checked={!!t.system_only} onChange={(e) => setTr(t.i, { system_only: e.target.checked })} />Engine only</label></div> },
              { key: 'x', label: '', render: (t: any) => draft && <button className="btn sm danger" onClick={() => update({ ...def, transitions: def.transitions.filter((_: any, j: number) => j !== t.i) })}>Remove</button> },
            ]} />
            {draft && <button className="btn" style={{ marginTop: 8 }} onClick={() => update({ ...def, transitions: [...def.transitions, { from: keys[0], to: keys[1] ?? keys[0], label: 'New transition', guards: [], actions: [] }] })}>Add transition</button>}
          </Card>
        </div>
      )}
    </div>
  );
}

function MultiPick({ options, value, onChange, disabled }: { options: string[]; value: string[]; onChange: (v: string[]) => void; disabled?: boolean }) {
  return (
    <div className="row" style={{ gap: 4 }}>
      {value.map((v) => <span key={v} className="badge">{label(v)}{!disabled && <button className="btn link sm" aria-label={`Remove ${v}`} onClick={() => onChange(value.filter((x) => x !== v))}>✕</button>}</span>)}
      {!disabled && <select value="" onChange={(e) => e.target.value && onChange([...value, e.target.value])} style={{ width: 'auto', padding: '2px 4px' }} aria-label="Add"><option value="">+</option>{options.filter((o) => !value.includes(o)).map((o) => <option key={o} value={o}>{label(o)}</option>)}</select>}
    </div>
  );
}
