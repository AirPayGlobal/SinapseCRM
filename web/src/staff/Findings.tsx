import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, qs } from '../api';
import { Badge, Card, ErrorBox, Field, Loading, Modal, PageHead, Table } from '../components/ui';
import { fmtDate, fmtDateTime, label } from '../format';
import { useAction, useLoad } from '../hooks';
import { useCan, useStaff } from './context';

const sevTone = (s: string) => (s === 'critical' || s === 'high' ? 'red' : s === 'medium' ? 'amber' : undefined) as any;

/** Audit findings register (S-09). */
export function Findings() {
  const can = useCan();
  const nav = useNavigate();
  const { ref } = useStaff();
  const [f, setF] = useState({ state: '', severity: '', overdue: '' });
  const list = useLoad(() => api.get<any[]>(`/findings${qs(f)}`), [f.state, f.severity, f.overdue]);
  const [create, setCreate] = useState<any | null>(null);
  const [rec, setRec] = useState<any | null>(null);
  const a = useAction();
  return (
    <>
      <PageHead title="Audit findings" sub="Findings, remediation tasks and closure evidence in one register. Overdue tasks escalate like overdue queries."
        actions={can('finding.write') && <button className="btn primary" onClick={() => setCreate({ title: '', description: '', source: '', severity: 'medium', finding_type_key: 'internal_audit', owner_id: '', due_date: '' })}>Record finding</button>} />
      <Card actions={<>
        <select value={f.state} onChange={(e) => setF({ ...f, state: e.target.value })} style={{ width: 'auto' }}><option value="">Any state</option>{['open', 'accepted', 'in_remediation', 'pending_verification', 'closed'].map((s) => <option key={s} value={s}>{label(s)}</option>)}</select>
        <select value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })} style={{ width: 'auto' }}><option value="">Any severity</option>{['critical', 'high', 'medium', 'low'].map((s) => <option key={s} value={s}>{label(s)}</option>)}</select>
        <label className="inline-check"><input type="checkbox" checked={!!f.overdue} onChange={(e) => setF({ ...f, overdue: e.target.checked ? 'true' : '' })} />Overdue</label>
      </>}>
        <Table rows={list.data ?? []} onRow={(r: any) => nav(`/findings/${r.id}`)} cols={[
          { key: 'reference', label: 'Reference' },
          { key: 'title', label: 'Finding', render: (r: any) => <div><b>{r.title}</b><div className="small muted">{r.source}{r.recurrence_reference && <> · <Badge tone="amber">Recurrence of {r.recurrence_reference}</Badge></>}</div></div> },
          { key: 'severity', label: 'Severity', render: (r: any) => <Badge tone={sevTone(r.severity)}>{label(r.severity)}</Badge> },
          { key: 'owner_name', label: 'Owner' }, { key: 'state', label: 'State', render: (r: any) => label(r.state) },
          { key: 'progress', label: 'Tasks', render: (r: any) => <>{r.tasks_done}/{r.task_count}{r.tasks_overdue > 0 && <Badge tone="red">{r.tasks_overdue} overdue</Badge>}</> },
          { key: 'due_date', label: 'Due', render: (r: any) => fmtDate(r.due_date) },
        ]} />
      </Card>
      {create && <Modal title="Record an audit finding" onClose={() => setCreate(null)}>
        <ErrorBox error={a.error} />
        <div className="stack">
          <Field label="Title"><input value={create.title} onChange={(e) => setCreate({ ...create, title: e.target.value })} onBlur={() => create.title && api.post('/findings/check-recurrence', create).then(setRec)} /></Field>
          <Field label="Description"><textarea value={create.description} onChange={(e) => setCreate({ ...create, description: e.target.value })} /></Field>
          {rec && <div className="alert info small">Materially similar to closed finding {rec.reference} ({Math.round(rec.score * 100)}%) — it will be flagged as a recurrence.</div>}
          <div className="grid cols-2">
            <Field label="Source"><input value={create.source} onChange={(e) => setCreate({ ...create, source: e.target.value })} placeholder="e.g. Internal audit Q3" /></Field>
            <Field label="Type"><select value={create.finding_type_key} onChange={(e) => setCreate({ ...create, finding_type_key: e.target.value })}>{ref.finding_types.map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}</select></Field>
            <Field label="Severity"><select value={create.severity} onChange={(e) => setCreate({ ...create, severity: e.target.value })}>{['low', 'medium', 'high', 'critical'].map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></Field>
            <Field label="Responsible owner"><select value={create.owner_id} onChange={(e) => setCreate({ ...create, owner_id: e.target.value })}><option value="">—</option>{ref.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
            <Field label="Due date"><input type="date" value={create.due_date} onChange={(e) => setCreate({ ...create, due_date: e.target.value })} /></Field>
            <Field label="Linked case reference (optional)"><input value={create.linked_ref ?? ''} onChange={(e) => setCreate({ ...create, linked_ref: e.target.value })} /></Field>
          </div>
          <button className="btn primary" disabled={!create.title || !create.source} onClick={async () => {
            let linked_query_id: string | undefined;
            if (create.linked_ref) linked_query_id = (await api.get(`/queries/${create.linked_ref}`).catch(() => null))?.id;
            const { linked_ref, ...body } = create;
            const r = await a.run(() => api.post('/findings', { ...body, owner_id: body.owner_id || undefined, due_date: body.due_date || undefined, linked_query_id }));
            if (r) { setCreate(null); nav(`/findings/${r.id}`); }
          }}>Record</button>
        </div>
      </Modal>}
    </>
  );
}

/** Finding detail with remediation tasks (S-10). */
export function Finding() {
  const { id } = useParams();
  const { ref, me } = useStaff();
  const can = useCan();
  const f = useLoad(() => api.get(`/findings/${id}`), [id]);
  const a = useAction();
  const [task, setTask] = useState({ title: '', owner_id: '', due_date: '' });
  if (f.error) return <ErrorBox error={f.error} />;
  if (!f.data) return <Loading />;
  const d = f.data;
  const reload = () => void f.reload(true);
  const move = async (to: string) => { if (await a.run(() => api.post(`/findings/${d.id}/transition`, { to }))) reload(); };
  const upload = async (taskId: string, file: File) => { const fd = new FormData(); fd.append('file', file); fd.append('task_id', taskId); if (await a.run(() => api.post(`/findings/${d.id}/evidence`, fd))) reload(); };
  return (
    <>
      <PageHead title={`${d.reference} — ${d.title}`} sub={<>{d.source} · owner {d.owner_name ?? 'unassigned'} · due {fmtDate(d.due_date)} <Badge tone={sevTone(d.severity)}>{label(d.severity)}</Badge> <Badge>{label(d.state)}</Badge></>}
        actions={<>
          {d.state === 'open' && d.owner_id === me.id && <button className="btn primary" onClick={() => move('accepted')}>Accept ownership</button>}
          {d.state === 'pending_verification' && can('finding.write') && <button className="btn primary" onClick={() => move('closed')}>Verify and close</button>}
          {d.state === 'pending_verification' && <button className="btn" onClick={() => move('in_remediation')}>Return to remediation</button>}
          {d.state === 'closed' && can('finding.write') && <button className="btn" onClick={() => move('in_remediation')}>Reopen</button>}
        </>} />
      <ErrorBox error={a.error} />
      <div className="grid cols-2">
        <Card eyebrow={`Remediation · ${d.progress}% complete`}>
          <div className="bar" style={{ gridTemplateColumns: '1fr 48px', marginBottom: 12 }}><div className="track"><div className="fill" style={{ width: `${d.progress}%` }} /></div><span className="n">{d.progress}%</span></div>
          <Table rows={d.tasks} empty="No remediation tasks yet" cols={[
            { key: 'title', label: 'Task', render: (t: any) => <div><b>{t.title}</b><div className="small muted">{t.owner_name ?? 'Unassigned'} · due {fmtDate(t.due_date)}{t.overdue_escalated && t.state !== 'done' ? ' · overdue (escalated)' : ''}</div>{t.evidence_filename && <div className="small">📎 {t.evidence_filename}</div>}{t.completion_note && <div className="small">{t.completion_note}</div>}</div> },
            { key: 'state', label: 'State', render: (t: any) => (
              <select value={t.state} style={{ width: 'auto' }} onChange={async (e) => {
                const next = e.target.value;
                const note = next === 'done' && !t.evidence_attachment_id ? prompt('Completion note (or attach evidence first)') ?? undefined : undefined;
                if (await a.run(() => api.patch(`/findings/tasks/${t.id}`, { state: next, completion_note: note }))) reload();
              }}>{['open', 'in_progress', 'done', 'cancelled'].map((s) => <option key={s} value={s}>{label(s)}</option>)}</select>) },
            { key: 'ev', label: 'Evidence', render: (t: any) => <input type="file" aria-label="Attach evidence" onChange={(e) => e.target.files?.[0] && upload(t.id, e.target.files[0])} style={{ maxWidth: 180 }} /> },
          ]} />
          {can('finding.write') && d.state !== 'closed' && <div className="row" style={{ marginTop: 10 }}>
            <input placeholder="New remediation task" value={task.title} onChange={(e) => setTask({ ...task, title: e.target.value })} style={{ flex: 2 }} />
            <select value={task.owner_id} onChange={(e) => setTask({ ...task, owner_id: e.target.value })} style={{ flex: 1 }}><option value="">Owner…</option>{ref.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
            <input type="date" value={task.due_date} onChange={(e) => setTask({ ...task, due_date: e.target.value })} style={{ width: 150 }} />
            <button className="btn primary" disabled={!task.title} onClick={async () => { if (await a.run(() => api.post(`/findings/${d.id}/tasks`, { ...task, owner_id: task.owner_id || undefined, due_date: task.due_date || undefined }))) { setTask({ title: '', owner_id: '', due_date: '' }); reload(); } }}>Add</button>
          </div>}
        </Card>
        <div>
          <Card eyebrow="Finding">
            <p style={{ whiteSpace: 'pre-wrap' }}>{d.description}</p>
            <dl className="kv left">
              {d.linked_query_reference && <><dt>Linked case</dt><dd><Link to={`/cases/${d.linked_query_id}`}>{d.linked_query_reference}</Link></dd></>}
              {d.linked_company_name && <><dt>Customer</dt><dd><Link to={`/customers/companies/${d.linked_company_id}`}>{d.linked_company_name}</Link></dd></>}
              {d.recurrence_reference && <><dt>Recurrence of</dt><dd><Link to={`/findings/${d.recurrence_of}`}>{d.recurrence_reference}</Link> ({Math.round(d.recurrence_score * 100)}% similar)</dd></>}
              <dt>Owner accepted</dt><dd>{fmtDateTime(d.owner_accepted_at)}</dd>
            </dl>
          </Card>
          <Card eyebrow="History">
            <ul className="timeline">{d.history.map((h: any, i: number) => <li key={i}><b>{label(h.action.replace('finding.', ''))}</b> {h.after?.state ? `→ ${label(h.after.state)}` : ''}<div className="small muted">{h.actor_name} · {fmtDateTime(h.occurred_at)}</div></li>)}</ul>
          </Card>
        </div>
      </div>
    </>
  );
}
