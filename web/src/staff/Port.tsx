import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../api';
import { Badge, Card, ErrorBox, Field, Modal, PageHead, Table, Tabs } from '../components/ui';
import { fmtDateTime, label } from '../format';
import { useAction, useLoad } from '../hooks';
import { useCan, useStaff } from './context';

/** Module 6 — vessel call board (S-38), cargo lookup (S-39) and proactive notification (S-41). */
export default function Port() {
  const [tab, setTab] = useState<'vessels' | 'cargo' | 'notices'>('vessels');
  return (
    <>
      <PageHead title="Port context" sub="Vessel, berth, cargo and corridor facts travel with the case. Tell customers about a change before they ask." />
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'vessels', label: 'Vessel call board' }, { key: 'cargo', label: 'Cargo lookup' }, { key: 'notices', label: 'Proactive notices' }]} />
      {tab === 'vessels' && <Vessels />}
      {tab === 'cargo' && <Cargo />}
      {tab === 'notices' && <Notices />}
    </>
  );
}

function Vessels() {
  const { ref } = useStaff();
  const can = useCan();
  const [port, setPort] = useState('');
  const v = useLoad(() => api.get<any[]>(`/port/vessel-calls${qs({ port })}`), [port], { refreshMs: 60_000 });
  const [edit, setEdit] = useState<any | null>(null);
  const [notice, setNotice] = useState<any | null>(null);
  const a = useAction();
  return (
    <Card actions={<>
      <select value={port} onChange={(e) => setPort(e.target.value)} style={{ width: 'auto' }}><option value="">Both ports</option>{ref.ports.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</select>
      {can('port.write') && <button className="btn primary" onClick={() => setEdit({ vessel_name: '', voyage_no: '', port_code: 'WB', berth: '', status: 'expected' })}>New vessel call</button>}
    </>}>
      <ErrorBox error={a.error} />
      <Table rows={v.data ?? []} cols={[
        { key: 'vessel_name', label: 'Vessel', render: (r: any) => <div><b>{r.vessel_name}</b><div className="small muted">Voyage {r.voyage_no} · {r.port_code}</div></div> },
        { key: 'berth', label: 'Berth', render: (r: any) => <>{r.berth}{r.previous_berth && <div className="small muted">was {r.previous_berth}</div>}</> },
        { key: 'window', label: 'Window', render: (r: any) => <span className="small">{fmtDateTime(r.window_from)} – {fmtDateTime(r.window_to)}</span> },
        { key: 'status', label: 'Status', render: (r: any) => <Badge tone={r.status === 'berthed' || r.status === 'working' ? 'green' : r.status === 'at_anchor' ? 'amber' : undefined}>{label(r.status)}</Badge> },
        { key: 'corridor_name', label: 'Corridor' },
        { key: 'open_queries', label: 'Open queries', num: true, render: (r: any) => r.open_queries ? <Link to={`/team?vessel_call_id=${r.id}`}>{r.open_queries}</Link> : 0 },
        { key: 'x', label: '', render: (r: any) => can('port.write') && <div className="row"><button className="btn sm" onClick={() => setEdit(r)}>Update</button>{can('notice.send') && <button className="btn sm gold" onClick={() => setNotice({ vessel_call_id: r.id, title: `${r.vessel_name} voyage ${r.voyage_no}: berth update`, body: `${r.vessel_name} (voyage ${r.voyage_no}) is now allocated to ${r.berth}, window ${fmtDateTime(r.window_from)} to ${fmtDateTime(r.window_to)}.`, audience: 'affected' })}>Notify customers</button>}</div> },
      ]} />
      {edit && <Modal title={edit.id ? `Update ${edit.vessel_name}` : 'New vessel call'} onClose={() => setEdit(null)}>
        <div className="stack">
          <div className="grid cols-2">
            <Field label="Vessel"><input value={edit.vessel_name} onChange={(e) => setEdit({ ...edit, vessel_name: e.target.value })} disabled={!!edit.id} /></Field>
            <Field label="Voyage"><input value={edit.voyage_no} onChange={(e) => setEdit({ ...edit, voyage_no: e.target.value })} disabled={!!edit.id} /></Field>
            <Field label="Port"><select value={edit.port_code} onChange={(e) => setEdit({ ...edit, port_code: e.target.value })}>{ref.ports.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</select></Field>
            <Field label="Berth"><input value={edit.berth ?? ''} onChange={(e) => setEdit({ ...edit, berth: e.target.value })} /></Field>
            <Field label="Window from"><input type="datetime-local" value={edit.window_from?.slice(0, 16) ?? ''} onChange={(e) => setEdit({ ...edit, window_from: new Date(e.target.value).toISOString() })} /></Field>
            <Field label="Window to"><input type="datetime-local" value={edit.window_to?.slice(0, 16) ?? ''} onChange={(e) => setEdit({ ...edit, window_to: new Date(e.target.value).toISOString() })} /></Field>
            <Field label="Status"><select value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })}>{['expected', 'at_anchor', 'berthed', 'working', 'departed', 'cancelled'].map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></Field>
            <Field label="Corridor"><select value={edit.corridor_id ?? ''} onChange={(e) => setEdit({ ...edit, corridor_id: e.target.value || null })}><option value="">—</option>{ref.corridors.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
          </div>
          <button className="btn primary" onClick={async () => {
            const { id, vessel_name, voyage_no, port_code, berth, window_from, window_to, status, corridor_id } = edit;
            const body = { vessel_name, voyage_no, port_code, berth, window_from, window_to, status, corridor_id };
            if (await a.run(() => (id ? api.patch(`/port/vessel-calls/${id}`, body) : api.post('/port/vessel-calls', body)))) { setEdit(null); void v.reload(true); }
          }}>Save</button>
        </div>
      </Modal>}
      {notice && <NoticeComposer initial={notice} onClose={() => setNotice(null)} />}
    </Card>
  );
}

function Cargo() {
  const [q, setQ] = useState('');
  const r = useLoad(() => (q.length >= 3 ? api.get<any[]>(`/port/cargo${qs({ q })}`) : Promise.resolve([])), [q]);
  return (
    <Card>
      <input placeholder="Container or bill of lading number" value={q} onChange={(e) => setQ(e.target.value.toUpperCase())} style={{ maxWidth: 360 }} aria-label="Container" />
      <Table rows={r.data ?? []} empty={q.length >= 3 ? 'No cargo found' : 'Type at least three characters'} cols={[
        { key: 'container_no', label: 'Container' }, { key: 'bl_no', label: 'B/L' }, { key: 'cargo_type', label: 'Cargo', render: (x: any) => <>{x.cargo_type} {x.reefer && <Badge>Reefer</Badge>}</> },
        { key: 'company_name', label: 'Customer' }, { key: 'vessel_name', label: 'Vessel', render: (x: any) => x.vessel_name ? `${x.vessel_name} · ${x.voyage_no} · ${x.berth}` : '—' },
        { key: 'corridor_name', label: 'Corridor' }, { key: 'status', label: 'Status' },
      ]} />
    </Card>
  );
}

function Notices() {
  const n = useLoad(() => api.get<any[]>('/port/notices'), []);
  const can = useCan();
  const [compose, setCompose] = useState(false);
  return (
    <Card actions={can('notice.send') && <button className="btn primary" onClick={() => setCompose(true)}>New notice</button>}>
      <Table rows={n.data ?? []} empty="No notices sent" cols={[
        { key: 'sent_at', label: 'Sent', render: (r: any) => fmtDateTime(r.sent_at) }, { key: 'title', label: 'Notice', render: (r: any) => <div><b>{r.title}</b><div className="small muted">{r.body}</div></div> },
        { key: 'vessel_name', label: 'Vessel' }, { key: 'audience', label: 'Audience', render: (r: any) => label(r.audience) }, { key: 'recipients_count', label: 'Recipients', num: true }, { key: 'created_by_name', label: 'By' },
      ]} />
      {compose && <NoticeComposer initial={{ title: '', body: '', audience: 'port', port_code: 'WB' }} onClose={() => { setCompose(false); void n.reload(true); }} />}
    </Card>
  );
}

function NoticeComposer({ initial, onClose }: { initial: any; onClose: () => void }) {
  const { ref } = useStaff();
  const [f, setF] = useState(initial);
  const a = useAction();
  const [sent, setSent] = useState<any | null>(null);
  return (
    <Modal title="Proactive operational notice" onClose={onClose}>
      <ErrorBox error={a.error} />
      {sent ? <div className="alert ok">Sent to {sent.recipients_count} customer contact(s). Open cases on this vessel carry the notice in their timeline.</div> : (
        <div className="stack">
          <Field label="Title"><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
          <Field label="Message"><textarea value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></Field>
          <div className="grid cols-2">
            <Field label="Audience"><select value={f.audience} onChange={(e) => setF({ ...f, audience: e.target.value })}>
              {f.vessel_call_id && <option value="affected">Customers with cargo or open cases on this vessel</option>}
              <option value="port">All active customers of a port</option><option value="all">All active customers</option>
            </select></Field>
            {f.audience === 'port' && <Field label="Port"><select value={f.port_code ?? 'WB'} onChange={(e) => setF({ ...f, port_code: e.target.value })}>{ref.ports.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</select></Field>}
          </div>
          <button className="btn gold" disabled={!f.title || !f.body || a.busy} onClick={async () => { const r = await a.run(() => api.post('/port/notices', f)); if (r) setSent(r); }}>Send notice</button>
        </div>
      )}
    </Modal>
  );
}
