import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, qs } from '../api';
import { Badge, Card, ErrorBox, Loading, Modal, PageHead, SlaBadge, StateBadge, Table, UrgencyBadge } from '../components/ui';
import { fmtDateTime, label } from '../format';
import { useAction, useLoad } from '../hooks';
import { useCan, useStaff } from './context';

/** My queue (S-02) and team queue (S-03): SLA state on every row, inline update and reassignment. */
export default function Queue({ team = false }: { team?: boolean }) {
  const { ref, reload: reloadMe } = useStaff();
  const can = useCan();
  const [sp, setSp] = useSearchParams();
  const f = Object.fromEntries(sp.entries());
  const filters = { ...(team ? {} : { mine: true }), open: f.state ? undefined : true, sort: f.sort ?? 'sla', ...f };
  const list = useLoad(() => api.get(`/queries${qs({ ...filters, limit: 200 })}`), [team, sp.toString()], { refreshMs: 30_000 });
  const saved = useLoad(() => api.get<any[]>('/me/saved-searches'), []);
  const [reassign, setReassign] = useState<any | null>(null);
  const a = useAction();
  const set = (k: string, v?: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n); };
  const inline = async (id: string, patch: any) => { await a.run(() => api.patch(`/queries/${id}`, patch)); void list.reload(true); };

  return (
    <>
      <PageHead title={team ? 'Team queue' : 'My queue'} sub={team ? 'Every open case in your scope, ordered by service target. Reassign inline with a reason.' : 'Your assigned work, most urgent first. Paused cases are waiting on someone else.'}
        actions={<>
          <button className="btn" onClick={() => api.download(`/queries/export${qs({ ...filters, format: 'csv' })}`)}>Export CSV</button>
          <button className="btn" onClick={async () => { const name = prompt('Name this view'); if (name) { await api.post('/me/saved-searches', { name, filters: f, shared: team, is_queue: team }); void saved.reload(); } }}>Save view</button>
          {can('query.create') && <Link className="btn primary" to="/capture">Log query</Link>}
        </>} />
      <Card>
        <div className="row" style={{ marginBottom: 10 }}>
          <input placeholder="Search reference, subject, customer, correspondence, documents…" style={{ maxWidth: 380 }} defaultValue={f.q ?? ''} onKeyDown={(e) => e.key === 'Enter' && set('q', (e.target as HTMLInputElement).value)} aria-label="Search" />
          <select value={f.sla ?? ''} onChange={(e) => set('sla', e.target.value)} style={{ width: 'auto' }} aria-label="SLA">
            <option value="">Any SLA state</option><option value="breached">Breached</option><option value="at_risk">At risk</option><option value="paused">Paused</option>
          </select>
          <select value={f.query_type ?? ''} onChange={(e) => set('query_type', e.target.value)} style={{ width: 'auto' }} aria-label="Type">
            <option value="">All types</option>{ref.query_types.map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}
          </select>
          {team && <>
            <select value={f.port ?? ''} onChange={(e) => set('port', e.target.value)} style={{ width: 'auto' }} aria-label="Port"><option value="">Both ports</option>{ref.ports.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</select>
            <select value={f.tier ?? ''} onChange={(e) => set('tier', e.target.value)} style={{ width: 'auto' }} aria-label="Tier"><option value="">All tiers</option><option value="top10">Top 10</option><option value="priority">Priority</option><option value="standard">Standard</option></select>
            <label className="inline-check"><input type="checkbox" checked={f.unassigned === 'true'} onChange={(e) => set('unassigned', e.target.checked ? 'true' : undefined)} />Unassigned</label>
            <label className="inline-check"><input type="checkbox" checked={f.duplicates === 'true'} onChange={(e) => set('duplicates', e.target.checked ? 'true' : undefined)} />Possible duplicates</label>
          </>}
          {(saved.data ?? []).filter((s) => s.is_queue || !team).map((s) => (
            <button key={s.id} className="btn sm" onClick={() => setSp(new URLSearchParams(s.filters))} title={`Saved by ${s.owner_name}`}>{s.name}</button>
          ))}
        </div>
        <ErrorBox error={list.error ?? a.error} />
        {list.loading && !list.data ? <Loading /> : (
          <Table rows={list.data?.items ?? []} empty="No cases match" cols={[
            { key: 'reference', label: 'Reference', render: (r) => <Link to={`/cases/${r.id}`}>{r.reference}</Link> },
            { key: 'subject', label: 'Subject', render: (r) => <div><div style={{ fontWeight: 600 }}>{r.subject}</div><div className="small muted">{r.company_name ?? r.contact_name ?? 'Unlinked sender'} · {r.query_type_name ?? 'Unclassified'}{!r.classification_confirmed && r.ai_classification ? ' (AI)' : ''}</div></div> },
            { key: 'sla', label: 'SLA', render: (r) => <div className="stack"><SlaBadge sla={r.sla} />{r.account_tier === 'top10' && <Badge tone="gold">Top 10</Badge>}{r.escalation_level > 0 && <Badge tone="red">Esc. L{r.escalation_level}</Badge>}{r.possible_duplicate_of && <Badge tone="amber">Possible duplicate</Badge>}</div> },
            { key: 'state', label: 'Status', render: (r) => <StateBadge state={r.state} /> },
            { key: 'urgency', label: 'Urgency', render: (r) => (
              <select aria-label="Urgency" value={r.urgency} style={{ width: 'auto', padding: '3px 6px' }} onClick={(e) => e.stopPropagation()} onChange={(e) => inline(r.id, { urgency: e.target.value })}>
                {ref.urgencies.map((u) => <option key={u} value={u}>{label(u)}</option>)}
              </select>) },
            { key: 'assigned_to_name', label: 'Agent', render: (r) => (
              <div className="row"><span>{r.assigned_to_name ?? <Badge tone="amber">Unassigned</Badge>}</span>{can('query.reassign') && <button className="btn sm" onClick={() => setReassign(r)}>Reassign</button>}</div>) },
            { key: 'port_code', label: 'Port' },
            { key: 'created_at', label: 'Received', render: (r) => <span className="small">{fmtDateTime(r.created_at)}</span> },
          ]} onRow={undefined} />
        )}
        <div className="small muted" style={{ marginTop: 8 }}>{list.data?.total ?? 0} case(s)</div>
      </Card>
      {reassign && <ReassignDialog q={reassign} onClose={(changed) => { setReassign(null); if (changed) { void list.reload(true); reloadMe(); } }} />}
    </>
  );
}

export function ReassignDialog({ q, onClose }: { q: any; onClose: (changed: boolean) => void }) {
  const cand = useLoad(() => api.get(`/queries/${q.id}/candidates`), [q.id]);
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');
  const a = useAction();
  return (
    <Modal title={`Reassign ${q.reference}`} onClose={() => onClose(false)}>
      <p className="muted small">The assignment engine's view of every agent right now. Choose an agent, or return the case to the engine.</p>
      <ErrorBox error={a.error ?? cand.error} />
      {cand.data && (
        <Table rows={cand.data.candidates} cols={[
          { key: 'pick', label: '', render: (c: any) => <input type="radio" name="to" disabled={!!c.excluded && c.excluded.startsWith('on leave')} checked={to === c.id} onChange={() => setTo(c.id)} aria-label={`Choose ${c.name}`} /> },
          { key: 'name', label: 'Agent' },
          { key: 'load', label: 'Load', num: true, render: (c: any) => `${c.load.toFixed(1)} / ${c.capacity}` },
          { key: 'excluded', label: 'Engine', render: (c: any) => (c.excluded ? <span className="small muted">{c.excluded}</span> : <Badge tone="green">Eligible</Badge>) },
        ]} />
      )}
      <div className="stack" style={{ marginTop: 10 }}>
        <label className="inline-check"><input type="radio" name="to" checked={to === 'auto'} onChange={() => setTo('auto')} />Return to the engine (exclude current agent)</label>
        <input placeholder="Reason (required — reassignment patterns are reported)" value={reason} onChange={(e) => setReason(e.target.value)} />
        <div className="row">
          <button className="btn primary" disabled={!to || !reason || a.busy} onClick={async () => {
            const r = await a.run(() => api.post(`/queries/${q.id}/assign`, { user_id: to === 'auto' ? null : to, reason }));
            if (r) onClose(true);
          }}>Reassign</button>
          <button className="btn" onClick={() => onClose(false)}>Cancel</button>
        </div>
      </div>
    </Modal>
  );
}
