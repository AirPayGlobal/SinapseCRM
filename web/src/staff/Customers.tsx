import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, qs } from '../api';
import { Badge, Card, ErrorBox, Field, Loading, Modal, PageHead, StateBadge, Table, Tabs } from '../components/ui';
import { fmtDate, fmtDateTime, label } from '../format';
import { useAction, useLoad } from '../hooks';
import { useCan, useStaff } from './context';

/** Customer search with facets (S-14) and the company list. */
export function Customers() {
  const { ref } = useStaff();
  const can = useCan();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [facets, setFacets] = useState({ port: '', tier: '' });
  const [res, setRes] = useState<any | null>(null);
  const companies = useLoad(() => api.get(`/customers/companies${qs({ ...facets, status: 'active', limit: 100 })}`), [facets.port, facets.tier]);
  const [create, setCreate] = useState(false);
  useEffect(() => {
    if (q.trim().length < 2) { setRes(null); return; }
    const t = setTimeout(() => api.get(`/customers/search${qs({ q, ...facets })}`).then(setRes).catch(() => undefined), 250);
    return () => clearTimeout(t);
  }, [q, facets.port, facets.tier]);
  return (
    <>
      <PageHead title="Customers" sub="Full-text search across companies, contacts, cases, correspondence and the body of attached documents."
        actions={<>
          {can('registration.approve') && <Link className="btn" to="/customers/registrations">Registration approvals</Link>}
          {can('query.review_filtered') && <Link className="btn" to="/review">Review queues</Link>}
          {can('customer.write') && <button className="btn primary" onClick={() => setCreate(true)}>New company</button>}
        </>} />
      <Card>
        <div className="row">
          <input autoFocus placeholder="Search everything…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 480 }} aria-label="Search" />
          <select value={facets.port} onChange={(e) => setFacets({ ...facets, port: e.target.value })} style={{ width: 'auto' }} aria-label="Port"><option value="">Both ports</option>{ref.ports.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</select>
          <select value={facets.tier} onChange={(e) => setFacets({ ...facets, tier: e.target.value })} style={{ width: 'auto' }} aria-label="Tier"><option value="">All tiers</option><option value="top10">Top 10</option><option value="priority">Priority</option><option value="standard">Standard</option></select>
        </div>
      </Card>
      {res ? (
        <div className="grid cols-2" style={{ marginTop: 14 }}>
          <Card eyebrow={`Companies · ${res.companies.length}`}>{res.companies.map((c: any) => <div key={c.id} className="msg"><Link to={`/customers/companies/${c.id}`}><b>{c.name}</b></Link> <span className="small muted">{c.registration_no}</span> {c.account_tier === 'top10' && <Badge tone="gold">Top 10</Badge>}</div>)}</Card>
          <Card eyebrow={`Contacts · ${res.contacts.length}`}>{res.contacts.map((c: any) => <div key={c.id} className="msg"><Link to={`/customers/contacts/${c.id}`}><b>{c.name}</b></Link> <span className="small muted">{c.email} {c.phone}</span></div>)}</Card>
          <Card eyebrow={`Cases · ${res.queries.length}`}>{res.queries.map((x: any) => <div key={x.id} className="msg"><Link to={`/cases/${x.id}`}>{x.reference}</Link> {x.subject} <StateBadge state={x.state} /><div className="small muted">{x.company_name}</div></div>)}</Card>
          <Card eyebrow={`Correspondence and documents · ${res.correspondence.length + res.documents.length}`}>
            {res.correspondence.map((x: any) => <div key={x.id} className="msg small"><Link to={`/cases/${x.query_id}`}>{x.reference}</Link> · {label(x.channel)} · <span dangerouslySetInnerHTML={{ __html: sanitize(x.snippet) }} /></div>)}
            {res.documents.map((x: any) => <div key={x.id} className="msg small">📎 {x.filename} {x.reference && <Link to={`/cases/${x.query_id}`}>{x.reference}</Link>} · <span dangerouslySetInnerHTML={{ __html: sanitize(x.snippet) }} /></div>)}
          </Card>
        </div>
      ) : (
        <Card eyebrow="Companies" className="" >
          {companies.loading ? <Loading /> : <Table rows={companies.data?.items ?? []} onRow={(r) => nav(`/customers/companies/${r.id}`)} cols={[
            { key: 'name', label: 'Company', render: (r: any) => <div><b>{r.name}</b><div className="small muted">{r.company_type}</div></div> },
            { key: 'registration_no', label: 'Registration' },
            { key: 'account_tier', label: 'Tier', render: (r: any) => r.account_tier === 'top10' ? <Badge tone="gold">Top 10</Badge> : label(r.account_tier) },
            { key: 'ports_served', label: 'Ports', render: (r: any) => r.ports_served.join(', ') },
            { key: 'contact_count', label: 'Contacts', num: true },
            { key: 'open_cases', label: 'Open cases', num: true },
          ]} />}
        </Card>
      )}
      {create && <NewCompany onClose={(id) => { setCreate(false); if (id) nav(`/customers/companies/${id}`); }} />}
    </>
  );
}

// ts_headline output only contains <b> tags; strip everything else defensively
const sanitize = (s: string) => (s ?? '').replace(/<(?!\/?b>)[^>]*>/g, '');

function NewCompany({ onClose }: { onClose: (id?: string) => void }) {
  const [f, setF] = useState({ registration_no: '', name: '', company_type: '', account_tier: 'standard', ports_served: 'WB' });
  const [dups, setDups] = useState<any | null>(null);
  const a = useAction();
  const save = async (force = false) => {
    const r = await a.run(() => api.post('/customers/companies', { ...f, ports_served: f.ports_served.split(','), force }));
    if (r) onClose(r.id);
  };
  useEffect(() => {
    if (!f.registration_no && !f.name) return;
    const t = setTimeout(() => api.post('/customers/companies/check-duplicates', f).then(setDups).catch(() => undefined), 300);
    return () => clearTimeout(t);
  }, [f.registration_no, f.name]);
  return (
    <Modal title="New company" onClose={() => onClose()}>
      <p className="small muted">Customers normally register themselves through the portal; use this only for walk-in or legacy profiles.</p>
      <ErrorBox error={a.error} />
      <div className="stack">
        <Field label="Registration number"><input value={f.registration_no} onChange={(e) => setF({ ...f, registration_no: e.target.value })} /></Field>
        <Field label="Registered name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Type"><input value={f.company_type} onChange={(e) => setF({ ...f, company_type: e.target.value })} placeholder="Clearing agent, shipping line, cargo owner…" /></Field>
        <div className="grid cols-2">
          <Field label="Tier"><select value={f.account_tier} onChange={(e) => setF({ ...f, account_tier: e.target.value })}><option value="standard">Standard</option><option value="priority">Priority</option><option value="top10">Top 10</option></select></Field>
          <Field label="Ports served"><select value={f.ports_served} onChange={(e) => setF({ ...f, ports_served: e.target.value })}><option value="WB">Walvis Bay</option><option value="LZ">Lüderitz</option><option value="WB,LZ">Both</option></select></Field>
        </div>
        {dups && (dups.exact.length > 0 || dups.similar.length > 0) && (
          <div className="alert info">Possible duplicates: {[...dups.exact, ...dups.similar].map((d: any) => <div key={d.id}><Link to={`/customers/companies/${d.id}`}>{d.name}</Link> ({d.registration_no})</div>)}</div>
        )}
        <div className="row">
          <button className="btn primary" disabled={a.busy} onClick={() => save(false)}>Create</button>
          {dups?.similar?.length > 0 && !dups.exact.length && <button className="btn" onClick={() => save(true)}>Create anyway</button>}
        </div>
      </div>
    </Modal>
  );
}

/** Company profile (S-11) with the company–contact relationship view (S-13). */
export function Company() {
  const { id } = useParams();
  const can = useCan();
  const c = useLoad(() => api.get(`/customers/companies/${id}`), [id]);
  const [tab, setTab] = useState<'cases' | 'contacts' | 'timeline' | 'documents' | 'details'>('cases');
  const [edit, setEdit] = useState<any | null>(null);
  const [link, setLink] = useState(false);
  const a = useAction();
  if (c.error) return <ErrorBox error={c.error} />;
  if (!c.data) return <Loading />;
  const d = c.data;
  return (
    <>
      <PageHead title={d.name} sub={<>{d.company_type} · {d.registration_no} · {d.ports_served.join(' + ')} {d.account_tier === 'top10' && <Badge tone="gold">Top 10 customer</Badge>} {d.status !== 'active' && <Badge tone="amber">{label(d.status)}</Badge>}</>}
        actions={can('customer.write') && <><button className="btn" onClick={() => setEdit({ name: d.name, account_tier: d.account_tier, service_agreement_ref: d.service_agreement_ref ?? '', sap_customer_id: d.sap_customer_id ?? '', company_type: d.company_type ?? '' })}>Edit</button><button className="btn" onClick={() => setLink(true)}>Link contact</button></>} />
      <ErrorBox error={a.error} />
      <div className="grid cols-4" style={{ marginBottom: 14 }}>
        <div className="stat"><div className="v">{d.summary?.open_cases ?? 0}</div><div className="l">Open cases</div></div>
        <div className="stat"><div className="v">{d.summary?.resolved_90d ?? 0}</div><div className="l">Resolved · 90 days</div></div>
        <div className="stat"><div className="v">{d.summary?.sla_attainment != null ? `${d.summary.sla_attainment}%` : '—'}</div><div className="l">SLA attainment</div></div>
        <div className="stat"><div className="v">{d.summary?.satisfaction ?? '—'}</div><div className="l">Satisfaction / 5</div></div>
      </div>
      <Card>
        <Tabs value={tab} onChange={setTab} tabs={[{ key: 'cases', label: 'Cases' }, { key: 'contacts', label: `People · ${d.contacts.length}` }, { key: 'timeline', label: 'Interaction history' }, { key: 'documents', label: 'Documents' }, { key: 'details', label: 'Details' }]} />
        {tab === 'cases' && <Table rows={d.queries} cols={[
          { key: 'reference', label: 'Reference', render: (r: any) => <Link to={`/cases/${r.id}`}>{r.reference}</Link> },
          { key: 'subject', label: 'Subject' }, { key: 'state', label: 'Status', render: (r: any) => <StateBadge state={r.state} /> },
          { key: 'contact_name', label: 'Raised by' }, { key: 'created_at', label: 'Received', render: (r: any) => fmtDate(r.created_at) },
        ]} />}
        {tab === 'contacts' && <Table rows={d.contacts} cols={[
          { key: 'name', label: 'Name', render: (r: any) => <Link to={`/customers/contacts/${r.id}`}>{r.name}</Link> },
          { key: 'email', label: 'Email' }, { key: 'phone', label: 'Phone' },
          { key: 'role', label: 'Relationship', render: (r: any) => <>{label(r.role)} {r.is_portal_admin && <Badge tone="navy">Company admin</Badge>} {r.link_status !== 'active' && <Badge>{r.link_status}</Badge>}</> },
          { key: 'other_companies', label: 'Also acts for', render: (r: any) => (r.other_companies ?? []).join(', ') || '—' },
          { key: 'x', label: '', render: (r: any) => can('customer.write') && r.link_status === 'active' && <button className="btn sm danger" onClick={() => a.run(() => api.del(`/customers/companies/${d.id}/contacts/${r.id}`)).then(() => c.reload(true))}>Unlink</button> },
        ]} />}
        {tab === 'timeline' && <ul className="timeline">{d.timeline.map((t: any) => (
          <li key={t.id} className={t.visibility === 'internal' ? 'internal' : ''}>
            <div><b>{label(t.channel)}</b> {t.reference && <Link to={`/cases/${t.query_id}`}>{t.reference}</Link>} · {t.subject ?? ''}</div>
            <div className="small">{t.body?.slice(0, 200)}</div>
            <div className="small muted">{fmtDateTime(t.occurred_at)} · {t.actor_name ?? ''}</div>
          </li>))}</ul>}
        {tab === 'documents' && <Documents companyId={d.id} />}
        {tab === 'details' && <dl className="kv left">
          <dt>Trading names</dt><dd>{d.trading_names.join(', ') || '—'}</dd>
          <dt>Service agreement</dt><dd>{d.service_agreement_ref ?? '—'}</dd>
          <dt>SAP customer</dt><dd>{d.sap_customer_id ?? '—'} {can('customer.write') && d.sap_customer_id && <button className="btn sm" onClick={() => a.run(() => api.post(`/customers/companies/${d.id}/sap-align`)).then((r) => r && alert(JSON.stringify(r, null, 2)))}>Align with SAP</button>}</dd>
          <dt>Registered via</dt><dd>{d.created_by_channel}</dd>
          <dt>Created</dt><dd>{fmtDateTime(d.created_at)}</dd>
        </dl>}
      </Card>
      {edit && <Modal title="Edit company" onClose={() => setEdit(null)}>
        <div className="stack">
          {Object.keys(edit).map((k) => k === 'account_tier'
            ? <Field key={k} label="Tier"><select value={edit[k]} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })}><option value="standard">Standard</option><option value="priority">Priority</option><option value="top10">Top 10</option></select></Field>
            : <Field key={k} label={label(k)}><input value={edit[k]} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} /></Field>)}
          <button className="btn primary" onClick={async () => { if (await a.run(() => api.patch(`/customers/companies/${d.id}`, edit))) { setEdit(null); void c.reload(true); } }}>Save</button>
        </div>
      </Modal>}
      {link && <LinkContact companyId={d.id} onClose={() => { setLink(false); void c.reload(true); }} />}
    </>
  );
}

function Documents({ companyId }: { companyId: string }) {
  const docs = useLoad(() => api.get<any[]>(`/customers/companies/${companyId}/documents`), [companyId]);
  return <Table rows={docs.data ?? []} cols={[
    { key: 'filename', label: 'Document', render: (r: any) => <a href="#" onClick={(e) => { e.preventDefault(); void api.download(`/attachments/${r.id}`); }}>{r.filename}</a> },
    { key: 'scan_status', label: 'Scan', render: (r: any) => <Badge tone={r.scan_status === 'clean' ? 'green' : 'red'}>{r.scan_status}</Badge> },
    { key: 'visibility', label: 'Visibility' }, { key: 'created_at', label: 'Uploaded', render: (r: any) => fmtDate(r.created_at) },
  ]} />;
}

function LinkContact({ companyId, onClose }: { companyId: string; onClose: () => void }) {
  const [f, setF] = useState({ name: '', email: '', phone: '', role: 'operations', is_portal_admin: false });
  const a = useAction();
  return (
    <Modal title="Link a contact" onClose={onClose}>
      <ErrorBox error={a.error} />
      <div className="stack">
        <Field label="Email (an existing contact is reused)"><input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Phone"><input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        <Field label="Relationship role"><select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{['primary', 'operations', 'finance', 'escalation'].map((r) => <option key={r} value={r}>{label(r)}</option>)}</select></Field>
        <label className="inline-check"><input type="checkbox" checked={f.is_portal_admin} onChange={(e) => setF({ ...f, is_portal_admin: e.target.checked })} />Company administrator in the portal</label>
        <button className="btn primary" onClick={async () => { if (await a.run(() => api.post(`/customers/companies/${companyId}/contacts`, f))) onClose(); }}>Link</button>
      </div>
    </Modal>
  );
}

/** Contact profile (S-12): one person across the companies they act for. */
export function Contact() {
  const { id } = useParams();
  const c = useLoad(() => api.get(`/customers/contacts/${id}`), [id]);
  if (c.error) return <ErrorBox error={c.error} />;
  if (!c.data) return <Loading />;
  const d = c.data;
  return (
    <>
      <PageHead title={d.name} sub={`${d.email} · ${d.phone ?? 'no phone'} · ${d.position ?? ''}`} />
      <div className="grid cols-2">
        <Card eyebrow="Acts for">
          {d.companies.map((co: any) => <div key={co.id} className="msg"><Link to={`/customers/companies/${co.id}`}><b>{co.name}</b></Link> · {label(co.role)} {co.is_portal_admin && <Badge tone="navy">Company admin</Badge>} {co.status !== 'active' && <Badge>{co.status}</Badge>}</div>)}
          <hr />
          <dl className="kv left"><dt>Email verified</dt><dd>{d.email_verified ? 'Yes' : 'No'}</dd><dt>MFA</dt><dd>{d.mfa_enabled ? 'Enabled' : 'Off'}</dd><dt>Notifications</dt><dd>{Object.entries(d.notification_preferences ?? {}).filter(([, v]) => v).map(([k]) => k).join(', ')}</dd></dl>
        </Card>
        <Card eyebrow="Interaction history">
          <ul className="timeline">{d.timeline.map((t: any) => <li key={t.id}><div><b>{label(t.channel)}</b> {t.reference && <Link to={`/cases/${t.query_id}`}>{t.reference}</Link>}</div><div className="small">{t.body?.slice(0, 160)}</div><div className="small muted">{fmtDateTime(t.occurred_at)}</div></li>)}</ul>
        </Card>
      </div>
    </>
  );
}

/** Registration approval queue (S-15): Namport approves; it does not key. */
export function Registrations() {
  const r = useLoad(() => api.get('/customers/registrations'), []);
  const a = useAction();
  const decide = async (id: string, decision: string, extra: any = {}) => { await a.run(() => api.post(`/customers/registrations/${id}/decision`, { decision, ...extra })); void r.reload(true); };
  return (
    <>
      <PageHead title="Registration approvals" sub="Self-registered companies awaiting approval, with duplicate checks on registration number and name." />
      <ErrorBox error={a.error ?? r.error} />
      {(r.data?.registrations ?? []).map((x: any) => (
        <Card key={x.id} title={x.name} actions={<>
          <button className="btn primary" onClick={() => decide(x.id, 'approve')}>Approve</button>
          {[...x.duplicate_check.exact, ...x.duplicate_check.similar].slice(0, 1).map((dup: any) => <button key={dup.id} className="btn" onClick={() => decide(x.id, 'approve', { merge_into: dup.id })}>Attach to {dup.name}</button>)}
          <button className="btn danger" onClick={() => { const reason = prompt('Reason for rejection (sent to the applicant)'); if (reason) void decide(x.id, 'reject', { reason }); }}>Reject</button>
        </>}>
          <div className="small muted">{x.registration_no} · {x.company_type ?? 'type not given'} · {x.ports_served.join(', ')} · submitted {fmtDateTime(x.created_at)}</div>
          <div className="small">Applicants: {x.contacts.map((c: any) => `${c.name} <${c.email}>${c.email_verified ? ' ✓ verified' : ' (email not verified)'}`).join('; ')}</div>
          {(x.duplicate_check.exact.length > 0 || x.duplicate_check.similar.length > 0) && <div className="alert info small" style={{ marginTop: 8 }}>Possible existing profile: {[...x.duplicate_check.exact, ...x.duplicate_check.similar].map((d: any) => `${d.name} (${d.registration_no})`).join(', ')}</div>}
        </Card>
      ))}
      {r.data && !r.data.registrations.length && <Card><div className="empty">No registrations waiting</div></Card>}
      {(r.data?.join_requests ?? []).length > 0 && <Card eyebrow="Requests to join an existing company">
        <Table rows={r.data.join_requests} cols={[
          { key: 'name', label: 'Person', render: (j: any) => `${j.name} <${j.email}>` }, { key: 'company_name', label: 'Company' },
          { key: 'x', label: '', render: (j: any) => <div className="row"><button className="btn sm primary" onClick={() => a.run(() => api.post(`/customers/companies/${j.company_id}/join-requests/${j.contact_id}`, { decision: 'approve' })).then(() => r.reload(true))}>Approve</button><button className="btn sm" onClick={() => a.run(() => api.post(`/customers/companies/${j.company_id}/join-requests/${j.contact_id}`, { decision: 'reject' })).then(() => r.reload(true))}>Reject</button></div> },
        ]} />
      </Card>}
    </>
  );
}
