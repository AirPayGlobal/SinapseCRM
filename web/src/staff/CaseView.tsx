import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, qs } from '../api';
import { Badge, Card, ErrorBox, Loading, Modal, SlaBadge, StateBadge, UrgencyBadge } from '../components/ui';
import { bytes, fmtDateTime, fmtMinutes, fmtTime, label } from '../format';
import { useAction, useLoad } from '../hooks';
import { useCan, useStaff } from './context';
import { ReassignDialog } from './Queue';

function QueueRail({ activeId }: { activeId?: string }) {
  const list = useLoad(() => api.get(`/queries${qs({ mine: true, open: true, sort: 'sla', limit: 50 })}`), [], { refreshMs: 30_000 });
  const items = list.data?.items ?? [];
  return (
    <Card eyebrow={`My queue · ${list.data?.total ?? '…'}`}>
      {items.map((q: any) => {
        const cls = q.sla?.status === 'paused' ? 'paused' : q.sla?.status === 'breached' ? 'breach' : q.sla?.minutesRemaining != null && q.sla.minutesRemaining < 120 ? 'warn' : '';
        return (
          <Link key={q.id} to={`/cases/${q.id}`} className={`qitem ${cls} ${q.id === activeId ? 'active' : ''}`}>
            <div className="ref">{q.reference}</div>
            <div className="title">{q.subject}</div>
            <div className="small muted">{q.company_name ?? q.contact_name ?? 'Unlinked'}</div>
            <div className="due">{q.sla?.status === 'paused' ? `Paused — ${label(q.state).toLowerCase()}` : q.sla?.status === 'breached' ? 'Target missed' : q.sla?.minutesRemaining != null ? `Due in ${fmtMinutes(q.sla.minutesRemaining)}` : label(q.state)}</div>
          </Link>
        );
      })}
      {!items.length && !list.loading && <div className="empty">Nothing assigned to you</div>}
    </Card>
  );
}

function AssistPanel({ id, onInsert }: { id: string; onInsert: (t: string) => void }) {
  const s = useLoad(() => api.get(`/queries/${id}/assist`), [id]);
  if (!s.data?.draft) return null;
  return (
    <Card gold eyebrow="Sinapse Assist — suggested response">
      <div style={{ whiteSpace: 'pre-wrap' }}>{s.data.draft}</div>
      <div className="small muted" style={{ marginTop: 6 }}>Sources: {s.data.sources.map((x: any) => x.type === 'case' ? <Link key={x.id} to={`/cases/${x.id}`}>{x.title}</Link> : <span key={x.id}>{x.title}</span>).reduce((a: any[], b: any, i: number) => (i ? [...a, ' · ', b] : [b]), [])}</div>
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn primary" onClick={() => onInsert(s.data.draft)}>Insert draft</button>
        <button className="btn" onClick={() => s.setData(null)}>Not relevant</button>
      </div>
    </Card>
  );
}

function Composer({ q, onDone }: { q: any; onDone: () => void }) {
  const [mode, setMode] = useState<'email' | 'note' | 'call' | 'attach'>('email');
  const [text, setText] = useState('');
  const [call, setCall] = useState({ direction: 'inbound', duration: '', outcome: '' });
  const [file, setFile] = useState<File | null>(null);
  const [internalFile, setInternalFile] = useState(false);
  const a = useAction();
  useEffect(() => {
    const h = (e: Event) => { setMode('email'); setText((e as CustomEvent).detail); };
    window.addEventListener('sinapse:insert', h);
    return () => window.removeEventListener('sinapse:insert', h);
  }, []);
  const done = () => { setText(''); setFile(null); onDone(); };
  const closed = ['closed', 'merged'].includes(q.state);
  return (
    <Card eyebrow={mode === 'email' ? 'Reply — customer email' : mode === 'note' ? 'Internal note — staff only' : mode === 'call' ? 'Log a call' : 'Attach a document'}>
      <div className="tabs">
        {(['email', 'note', 'call', 'attach'] as const).map((m) => <button key={m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>{({ email: 'Email', note: 'Internal note', call: 'Log a call', attach: 'Attach' })[m]}</button>)}
      </div>
      <ErrorBox error={a.error} />
      {mode === 'email' && <div className="small muted" style={{ marginBottom: 6 }}>To: {q.customer?.contact?.name ?? 'customer'} {q.customer?.company ? `· ${q.customer.company.name}` : ''} — subject carries [{q.reference}]</div>}
      {mode === 'note' && <div className="small muted" style={{ marginBottom: 6 }}>Never delivered to the customer. Mention a colleague with @firstname.lastname to give them a task.</div>}
      {mode !== 'attach' && <textarea aria-label="Message" value={text} onChange={(e) => setText(e.target.value)} rows={6} disabled={closed} />}
      {mode === 'call' && (
        <div className="row" style={{ marginTop: 8 }}>
          <select value={call.direction} onChange={(e) => setCall({ ...call, direction: e.target.value })} style={{ width: 'auto' }}><option value="inbound">Inbound</option><option value="outbound">Outbound</option></select>
          <input placeholder="Duration (min)" value={call.duration} onChange={(e) => setCall({ ...call, duration: e.target.value })} style={{ width: 130 }} />
          <input placeholder="Outcome" value={call.outcome} onChange={(e) => setCall({ ...call, outcome: e.target.value })} style={{ width: 200 }} />
        </div>
      )}
      {mode === 'attach' && (
        <div className="stack">
          <input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <label className="inline-check"><input type="checkbox" checked={internalFile} onChange={(e) => setInternalFile(e.target.checked)} />Staff only (not visible in the portal)</label>
        </div>
      )}
      <div className="row" style={{ marginTop: 10 }}>
        {mode === 'email' && <>
          <button className="btn primary" disabled={!text || a.busy || closed} onClick={async () => { if (await a.run(() => api.post(`/queries/${q.id}/reply`, { body: text, then: 'resolve', resolution_note: text }))) done(); }}>Send and resolve</button>
          <button className="btn" disabled={!text || a.busy || closed} onClick={async () => { if (await a.run(() => api.post(`/queries/${q.id}/reply`, { body: text }))) done(); }}>Send only</button>
          <button className="btn" disabled={!text || a.busy || closed} title="Send and pause the service clock while the customer replies" onClick={async () => { if (await a.run(() => api.post(`/queries/${q.id}/reply`, { body: text, then: 'pending_customer' }))) done(); }}>Send and pause the clock</button>
        </>}
        {mode === 'note' && <button className="btn primary" disabled={!text || a.busy} onClick={async () => { if (await a.run(() => api.post(`/queries/${q.id}/notes`, { body: text }))) done(); }}>Add internal note</button>}
        {mode === 'call' && <button className="btn primary" disabled={a.busy} onClick={async () => { if (await a.run(() => api.post(`/queries/${q.id}/calls`, { direction: call.direction, duration_seconds: call.duration ? Number(call.duration) * 60 : undefined, outcome: call.outcome, notes: text }))) done(); }}>Log call</button>}
        {mode === 'attach' && <button className="btn primary" disabled={!file || a.busy} onClick={async () => {
          const fd = new FormData(); fd.append('file', file!); fd.append('visibility', internalFile ? 'internal' : 'public');
          if (await a.run(() => api.post(`/queries/${q.id}/attachments`, fd))) done();
        }}>Upload (virus-scanned)</button>}
      </div>
    </Card>
  );
}

function Conversation({ q }: { q: any }) {
  return (
    <Card eyebrow="Conversation — all channels">
      {q.timeline.map((t: any) => {
        const cls = t.visibility === 'internal' ? 'internal' : t.channel === 'system' ? 'system' : t.direction === 'outbound' ? 'outbound' : '';
        if (cls === 'system') return <div key={t.id} className="msg system">{fmtDateTime(t.occurred_at)} · {t.body}{t.reference !== q.reference ? ` (${t.reference})` : ''}</div>;
        return (
          <div key={t.id} className={`msg ${cls}`}>
            {t.visibility === 'internal' && <div className="small" style={{ fontWeight: 700 }}>🔒 Internal note · Staff only · Not delivered to customer</div>}
            <div className="small"><span className="who">{t.actor_name ?? 'Customer'}</span> · {fmtDateTime(t.occurred_at)} · {label(t.channel)}{t.direction === 'outbound' ? ' (sent)' : ''}{t.call_duration_seconds ? ` · ${Math.round(t.call_duration_seconds / 60)} min${t.call_outcome ? ` · ${t.call_outcome}` : ''}` : ''}{t.reference !== q.reference ? ` · from ${t.reference}` : ''}</div>
            <div className="body">{t.body}</div>
            {t.attachments?.length > 0 && <div className="row small">{t.attachments.map((a: any) => <a key={a.id} href="#" onClick={(e) => { e.preventDefault(); void api.download(`/attachments/${a.id}`); }}>📎 {a.filename}</a>)}</div>}
          </div>
        );
      })}
    </Card>
  );
}

function Context({ q, reload }: { q: any; reload: () => void }) {
  const pc = q.port_context;
  const s = q.customer?.summary;
  return (
    <div className="context">
      <Card eyebrow="Customer">
        {q.customer?.company ? <>
          <h2><Link to={`/customers/companies/${q.customer.company.id}`}>{q.customer.company.name}</Link></h2>
          <div className="small muted">{q.customer.company.company_type} · {q.customer.company.registration_no}</div>
          <div className="row" style={{ margin: '8px 0' }}>{q.customer.company.account_tier === 'top10' && <Badge tone="gold">Top 10 customer</Badge>}{q.customer.company.account_tier === 'priority' && <Badge tone="gold">Priority</Badge>}<span className="small">{q.customer.company.ports_served?.join(' + ')}</span></div>
        </> : <p className="muted">No company linked{q.customer?.contact ? '' : ' — sender not matched to a contact'}</p>}
        {q.customer?.contact && <div className="small">Contact: <Link to={`/customers/contacts/${q.customer.contact.id}`}>{q.customer.contact.name}</Link> · {q.customer.contact.email}</div>}
        {s && <dl className="kv" style={{ marginTop: 10 }}>
          <dt>Open cases</dt><dd>{s.open_cases}</dd>
          <dt>Resolved · 90 days</dt><dd>{s.resolved_90d}</dd>
          <dt>Average resolution</dt><dd>{s.avg_resolution_hours != null ? `${s.avg_resolution_hours} h` : '—'}</dd>
          <dt>SLA attainment</dt><dd>{s.sla_attainment != null ? `${s.sla_attainment}%` : '—'}</dd>
          <dt>Satisfaction</dt><dd>{s.satisfaction != null ? `${s.satisfaction} / 5` : '—'}</dd>
        </dl>}
      </Card>
      <Card gold eyebrow="Port context — Module 6">
        {pc.vessel_call ? <>
          <h2>{pc.vessel_call.vessel_name}</h2>
          <div>Voyage <b>{pc.vessel_call.voyage_no}</b> · {label(pc.vessel_call.status)}</div>
          <dl className="kv" style={{ marginTop: 8 }}>
            <dt>Berth</dt><dd>{pc.vessel_call.berth}{pc.vessel_call.previous_berth ? ` (was ${pc.vessel_call.previous_berth})` : ''}</dd>
            <dt>Window</dt><dd>{fmtTime(pc.vessel_call.window_from)}–{fmtTime(pc.vessel_call.window_to)}</dd>
            {pc.cargo && <><dt>Cargo</dt><dd>{pc.cargo.container_no} · {pc.cargo.cargo_type}{pc.cargo.reefer ? ' · reefer' : ''}</dd></>}
            {pc.corridor && <><dt>Corridor</dt><dd>{pc.corridor.name}</dd></>}
          </dl>
        </> : <PortLinker q={q} onDone={reload} />}
      </Card>
      <Card eyebrow="Timeline — all channels">
        <ul className="timeline">
          {[...q.timeline].reverse().slice(0, 12).map((t: any) => (
            <li key={t.id} className={t.visibility === 'internal' ? 'internal' : ''}>
              <div style={{ fontWeight: 600 }}>{label(t.channel)} · {t.channel === 'system' ? t.body.slice(0, 60) : t.subject?.slice(0, 50) || (t.direction === 'outbound' ? 'Reply sent' : t.visibility === 'internal' ? 'Internal note' : 'Message')}</div>
              <div className="small muted">{fmtDateTime(t.occurred_at)}</div>
            </li>
          ))}
        </ul>
      </Card>
      {q.assignments?.length > 0 && <Card eyebrow="Assignment history">
        {q.assignments.map((x: any) => <div key={x.id} className="small">{fmtDateTime(x.occurred_at)} · {x.from_name ? `${x.from_name} → ` : ''}{x.to_name ?? 'queue'} · {x.strategy}{x.reason && x.reason !== 'automatic' ? ` — ${x.reason}` : ''}</div>)}
      </Card>}
    </div>
  );
}

function PortLinker({ q, onDone }: { q: any; onDone: () => void }) {
  const calls = useLoad(() => api.get<any[]>('/port/vessel-calls'), []);
  return (
    <div className="stack">
      <p className="muted small">No vessel or cargo linked. Link a vessel call so the operational facts travel with the case.</p>
      <select aria-label="Vessel call" defaultValue="" onChange={(e) => e.target.value && api.patch(`/queries/${q.id}`, { vessel_call_id: e.target.value }).then(onDone)}>
        <option value="">Link a vessel call…</option>
        {(calls.data ?? []).map((v) => <option key={v.id} value={v.id}>{v.vessel_name} · {v.voyage_no} · {v.port_code}</option>)}
      </select>
    </div>
  );
}

export default function CaseView() {
  const { id } = useParams();
  const { ref } = useStaff();
  const can = useCan();
  const nav = useNavigate();
  const q = useLoad(() => api.get(`/queries/${id}`), [id], { refreshMs: 60_000 });
  const a = useAction();
  const [resolve, setResolve] = useState(false);
  const [reasonFor, setReasonFor] = useState<string | null>(null);
  const [reassign, setReassign] = useState(false);
  const [merge, setMerge] = useState(false);
  const reload = () => void q.reload(true);
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data) return <Loading />;
  const d = q.data;
  const move = async (to: string, extra: any = {}) => { if (await a.run(() => api.post(`/queries/${d.id}/transition`, { to, ...extra }))) reload(); };
  return (
    <div className="console">
      <QueueRail activeId={d.id} />
      <div>
        <Card eyebrow="Query & case management">
          <div className="small muted">{d.reference} · {fmtDateTime(d.created_at)} · {label(d.channel)} · {ref.ports.find((p) => p.code === d.port_code)?.name} · {d.department_name ?? 'No department'} · workflow {d.workflow.key} v{d.workflow.version}</div>
          <h1 style={{ margin: '6px 0 10px' }}>{d.subject}</h1>
          <div className="row">
            <StateBadge state={d.state} /><UrgencyBadge u={d.urgency} />
            {d.account_tier === 'top10' && <Badge tone="gold">Top 10 customer</Badge>}
            <SlaBadge sla={d.sla} />
            {d.escalation_level > 0 && <Badge tone="red">Escalated · level {d.escalation_level}</Badge>}
            {d.vessel_call_id && <Badge>Vessel linked</Badge>}
            {d.sentiment != null && d.sentiment < -0.3 && <Badge tone="red" title="Detected by the AI layer">Frustrated customer</Badge>}
            {d.parent_query_id && <Badge>Merged into another case</Badge>}
          </div>
          <ErrorBox error={a.error} />
          <div className="grid cols-3" style={{ marginTop: 12 }}>
            <label className="field"><span>Query type {!d.classification_confirmed && d.ai_classification && <Badge tone="gold">AI {Math.round(d.ai_classification.confidence * 100)}%</Badge>}</span>
              <select value={d.query_type_key ?? ''} onChange={(e) => a.run(() => api.patch(`/queries/${d.id}`, { query_type_key: e.target.value })).then(reload)}>
                {ref.query_types.map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}
              </select></label>
            <label className="field"><span>Urgency</span>
              <select value={d.urgency} onChange={(e) => a.run(() => api.patch(`/queries/${d.id}`, { urgency: e.target.value })).then(reload)}>
                {ref.urgencies.map((u) => <option key={u} value={u}>{label(u)}</option>)}
              </select></label>
            <label className="field"><span>Assigned to</span>
              <div className="row"><b>{d.assigned_to_name ?? 'Unassigned'}</b>{can('query.reassign') && <button className="btn sm" onClick={() => setReassign(true)}>Reassign</button>}</div></label>
          </div>
          {!d.classification_confirmed && d.ai_classification && (
            <div className="row small" style={{ marginTop: 8 }}>
              <span className="muted">The AI layer proposed this classification.</span>
              <button className="btn sm" onClick={() => a.run(() => api.patch(`/queries/${d.id}`, { confirm_classification: true })).then(reload)}>Confirm</button>
            </div>
          )}
          {d.custom_field_definitions?.length > 0 && <div className="grid cols-3" style={{ marginTop: 8 }}>
            {d.custom_field_definitions.map((f: any) => (
              <label key={f.key} className="field"><span>{f.label}</span>
                {f.field_type === 'select' ? (
                  <select defaultValue={d.custom_fields?.[f.key] ?? ''} onChange={(e) => a.run(() => api.patch(`/queries/${d.id}`, { custom_fields: { [f.key]: e.target.value } })).then(reload)}>
                    <option value="">—</option>{f.options.map((o: string) => <option key={o}>{o}</option>)}
                  </select>
                ) : <input defaultValue={d.custom_fields?.[f.key] ?? ''} type={f.field_type === 'number' ? 'number' : f.field_type === 'date' ? 'date' : 'text'}
                  onBlur={(e) => e.target.value !== String(d.custom_fields?.[f.key] ?? '') && a.run(() => api.patch(`/queries/${d.id}`, { custom_fields: { [f.key]: e.target.value } })).then(reload)} />}
                {f.help_text && <small>{f.help_text}</small>}
              </label>
            ))}
          </div>}
          <div className="row" style={{ marginTop: 12 }}>
            {d.transitions.map((t: any) => (
              <button key={t.to} className={`btn ${t.to === 'resolved' ? 'primary' : ''}`} disabled={a.busy} onClick={() => {
                if (t.to === 'resolved') setResolve(true);
                else if (t.to === 'merged') setMerge(true);
                else if (t.guards?.includes('has_reason')) setReasonFor(t.to);
                else void move(t.to);
              }}>{t.label}</button>
            ))}
            {d.state === 'resolved' && can('kb.write') && <button className="btn" onClick={() => a.run(() => api.post(`/queries/${d.id}/propose-knowledge`)).then((r) => r && alert('Draft article proposed for approval in Knowledge.'))}>Propose as knowledge</button>}
          </div>
        </Card>
        {d.duplicate_candidate && (
          <Card gold eyebrow="Near-duplicate detected">
            <p>This looks like the same matter as <Link to={`/cases/${d.duplicate_candidate.id}`}>{d.duplicate_candidate.reference}</Link> — “{d.duplicate_candidate.subject}” (similarity {Math.round(d.duplicate_candidate.score * 100)}%).</p>
            <div className="row">
              {can('query.merge') && <button className="btn primary" onClick={() => a.run(() => api.post(`/queries/${d.id}/merge`, { into: d.duplicate_candidate.id })).then((r) => r && nav(`/cases/${d.duplicate_candidate.id}`))}>Merge into {d.duplicate_candidate.reference}</button>}
              <button className="btn" onClick={() => a.run(() => api.post(`/queries/${d.id}/dismiss-duplicate`)).then(reload)}>Not a duplicate</button>
            </div>
          </Card>
        )}
        <AssistPanel id={d.id} onInsert={(t) => window.dispatchEvent(new CustomEvent('sinapse:insert', { detail: t }))} />
        <Conversation q={d} />
        {d.attachments.length > 0 && <Card eyebrow="Documents">
          {d.attachments.map((x: any) => <div key={x.id} className="row small"><a href="#" onClick={(e) => { e.preventDefault(); void api.download(`/attachments/${x.id}`); }}>📎 {x.filename}</a><span className="muted">{bytes(x.size_bytes)}</span><Badge tone={x.scan_status === 'clean' ? 'green' : 'red'}>{x.scan_status}</Badge>{x.visibility === 'internal' && <Badge tone="gold">Staff only</Badge>}</div>)}
        </Card>}
        <Composer q={d} onDone={reload} />
      </div>
      <Context q={d} reload={reload} />
      {resolve && <Modal title="Resolve case" onClose={() => setResolve(false)}>
        <ResolveForm onSubmit={async (note) => { setResolve(false); await move('resolved', { resolution_note: note }); }} />
      </Modal>}
      {reasonFor && <Modal title={label(reasonFor)} onClose={() => setReasonFor(null)}>
        <ResolveForm label="Reason" onSubmit={async (reason) => { const to = reasonFor; setReasonFor(null); await move(to, { reason }); }} />
      </Modal>}
      {merge && <Modal title="Merge into the original case" onClose={() => setMerge(false)}>
        <ResolveForm label="Reference or id of the original case" onSubmit={async (into) => { setMerge(false); const r = await a.run(() => api.post(`/queries/${d.id}/merge`, { into })); if (r) reload(); }} />
      </Modal>}
      {reassign && <ReassignDialog q={d} onClose={(c) => { setReassign(false); if (c) reload(); }} />}
    </div>
  );
}

function ResolveForm({ onSubmit, label: l = 'Resolution note (shown to the customer)' }: { onSubmit: (v: string) => void; label?: string }) {
  const [v, setV] = useState('');
  return (
    <div className="stack">
      <label className="field"><span>{l}</span><textarea value={v} onChange={(e) => setV(e.target.value)} autoFocus /></label>
      <button className="btn primary" disabled={!v.trim()} onClick={() => onSubmit(v)}>Confirm</button>
    </div>
  );
}
