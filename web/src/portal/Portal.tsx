import { useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Outlet, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { auth, portalApi, publicApi } from '../api';
import { Badge, Card, ErrorBox, Field, Loading, PageHead, Table } from '../components/ui';
import { bytes, fmtDate, fmtDateTime, label } from '../format';
import { useAction, useLoad } from '../hooks';
import AssistChat from './Assist';

/** Customer self-service portal (S-49 … S-53) with Sinapse Assist alongside (S-22). */
export function PortalLayout() {
  const nav = useNavigate();
  const me = useLoad(() => portalApi.get('/portal/me'), [], { refreshMs: 60_000 });
  if (!auth.token('customer')) return <Navigate to="/portal/login" replace />;
  if (me.error) return <div className="loading">{me.error} <a href="/portal/login">Sign in</a></div>;
  if (!me.data) return <Loading />;
  const adminOf = me.data.companies.filter((c: any) => c.is_portal_admin);
  return (
    <>
      <header className="topbar">
        <div className="brand"><img src="/icon.svg" alt="" />NAMPORT <span>Customer portal</span></div>
        <nav className="nav" aria-label="Portal">
          <NavLink to="/portal" end>My queries</NavLink>
          <NavLink to="/portal/new">Log a query</NavLink>
          {me.data.companies.length > 0 && <NavLink to={`/portal/company/${me.data.companies[0].id}`}>{adminOf.length ? 'My company' : 'Company'}</NavLink>}
          <NavLink to="/portal/notices">Notices{me.data.unread ? ` · ${me.data.unread}` : ''}</NavLink>
          <NavLink to="/portal/account">Account</NavLink>
        </nav>
        <div className="right"><span className="hide-sm">{me.data.contact.name}</span><button className="btn sm" onClick={() => { auth.set('customer', null); nav('/portal/login'); }}>Sign out</button></div>
      </header>
      <main id="main">
        <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(280px, 360px)' }}>
          <div><Outlet context={me.data} /></div>
          <Card gold eyebrow="Sinapse Assist" className="assist-side"><AssistChat mode="portal" /></Card>
        </div>
      </main>
      <style>{`@media (max-width: 900px) { main > .grid { grid-template-columns: minmax(0,1fr) !important; } }`}</style>
    </>
  );
}

export function PortalLogin() {
  const nav = useNavigate();
  const [f, setF] = useState({ email: '', password: '', code: '' });
  const [mfa, setMfa] = useState(false);
  const [reset, setReset] = useState(false);
  const a = useAction();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (reset) { await a.run(() => publicApi.post('/portal/password-reset', { email: f.email })); a.setError(null); alert('If an account exists, a reset link has been sent.'); setReset(false); return; }
    const r = await a.run(() => publicApi.post('/portal/login', f));
    if (r?.mfa_required) setMfa(true);
    else if (r?.token) { auth.set('customer', r.token); nav('/portal'); }
  };
  return (
    <div className="auth-shell">
      <form className="auth-card stack" onSubmit={submit}>
        <div className="brand"><img src="/icon.svg" alt="" />NAMPORT <span>Customer portal</span></div>
        <p className="muted">Log and track queries, manage your company's users and documents.</p>
        <ErrorBox error={a.error} />
        <Field label="Email"><input type="email" autoComplete="username" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        {!reset && <Field label="Password"><input type="password" autoComplete="current-password" required value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>}
        {mfa && <Field label="Verification code from your authenticator app"><input inputMode="numeric" autoComplete="one-time-code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} autoFocus /></Field>}
        <button className="btn primary" disabled={a.busy} style={{ justifyContent: 'center' }}>{reset ? 'Send reset link' : 'Sign in'}</button>
        <div className="row between small"><button type="button" className="btn link" onClick={() => setReset(!reset)}>{reset ? 'Back to sign in' : 'Forgot password?'}</button><Link to="/portal/register">Register your company</Link></div>
        <hr />
        <div className="small muted">Not registered yet? Ask Sinapse Assist on <Link to="/widget">the public help page</Link>.</div>
      </form>
    </div>
  );
}

export function PortalRegister() {
  const [f, setF] = useState({ registration_no: '', name: '', company_type: '', ports: 'WB', contact_name: '', email: '', phone: '', position: '', password: '' });
  const [done, setDone] = useState<any | null>(null);
  const a = useAction();
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await a.run(() => publicApi.post('/portal/register', {
      company: { registration_no: f.registration_no, name: f.name, company_type: f.company_type, ports_served: f.ports.split(',') },
      contact: { email: f.email, name: f.contact_name, phone: f.phone, position: f.position, password: f.password },
    }));
    if (r) setDone(r);
  };
  return (
    <div className="auth-shell">
      <div className="auth-card" style={{ width: 'min(560px, 100%)' }}>
        <div className="brand"><img src="/icon.svg" alt="" />NAMPORT <span>Register</span></div>
        {done ? (
          <div className="stack">
            <div className="alert ok">Thank you. We have emailed a verification link to {f.email}. {done.join_request ? 'Your company is already registered — your company administrator or Namport will approve your access.' : 'Once your email is verified, Namport will approve your company registration and you will be notified.'}</div>
            {done.verification_token && <div className="small muted">Test environment: <Link to={`/portal/verify?token=${done.verification_token}`}>verify now</Link></div>}
          </div>
        ) : (
          <form className="stack" onSubmit={submit}>
            <p className="muted">Register your company once; afterwards your administrator adds and removes colleagues directly.</p>
            <ErrorBox error={a.error} />
            <h3>Company</h3>
            <div className="grid cols-2">
              <Field label="Registration number"><input required value={f.registration_no} onChange={set('registration_no')} /></Field>
              <Field label="Registered name"><input required value={f.name} onChange={set('name')} /></Field>
              <Field label="Type of business"><input value={f.company_type} onChange={set('company_type')} placeholder="Clearing agent, shipping line…" /></Field>
              <Field label="Ports"><select value={f.ports} onChange={set('ports')}><option value="WB">Walvis Bay</option><option value="LZ">Lüderitz</option><option value="WB,LZ">Both</option></select></Field>
            </div>
            <h3>You (company administrator)</h3>
            <div className="grid cols-2">
              <Field label="Full name"><input required value={f.contact_name} onChange={set('contact_name')} /></Field>
              <Field label="Work email"><input type="email" required value={f.email} onChange={set('email')} /></Field>
              <Field label="Phone"><input value={f.phone} onChange={set('phone')} /></Field>
              <Field label="Position"><input value={f.position} onChange={set('position')} /></Field>
            </div>
            <Field label="Password" hint="At least 10 characters"><input type="password" required minLength={10} value={f.password} onChange={set('password')} /></Field>
            <button className="btn primary" disabled={a.busy}>Register</button>
            <div className="small"><Link to="/portal/login">Already registered? Sign in</Link></div>
          </form>
        )}
      </div>
    </div>
  );
}

/** Email verification and colleague activation / password reset (same token flow). */
export function PortalVerify({ activate }: { activate?: boolean }) {
  const [sp] = useSearchParams();
  const token = sp.get('token') ?? '';
  const [pw, setPw] = useState('');
  const [ok, setOk] = useState(false);
  const a = useAction();
  useEffect(() => {
    if (!activate && token) void a.run(() => publicApi.post('/portal/verify', { token })).then((r) => r && setOk(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="auth-shell">
      <div className="auth-card stack">
        <div className="brand"><img src="/icon.svg" alt="" />NAMPORT</div>
        <ErrorBox error={a.error} />
        {ok ? <div className="alert ok">Done. <Link to="/portal/login">Sign in</Link></div> : activate ? (
          <form className="stack" onSubmit={async (e) => { e.preventDefault(); if (await a.run(() => publicApi.post('/portal/verify', { token, password: pw }))) setOk(true); }}>
            <Field label="Choose a password" hint="At least 10 characters"><input type="password" minLength={10} required value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
            <button className="btn primary">Activate</button>
          </form>
        ) : <Loading />}
      </div>
    </div>
  );
}

export function MyQueries() {
  const [q, setQ] = useState('');
  const list = useLoad(() => portalApi.get(`/portal/queries${q ? `?q=${encodeURIComponent(q)}` : ''}`), [q], { refreshMs: 60_000 });
  const nav = useNavigate();
  return (
    <>
      <PageHead title="My queries" sub="Every query from your company, whichever channel it came in on, with its current status." actions={<Link className="btn primary" to="/portal/new">Log a query</Link>} />
      <Card>
        <input placeholder="Search your queries" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 320, marginBottom: 10 }} aria-label="Search" />
        <Table rows={list.data?.items ?? []} onRow={(r: any) => nav(`/portal/queries/${r.id}`)} empty="No queries yet" cols={[
          { key: 'reference', label: 'Reference', render: (r: any) => <b>{r.reference}</b> }, { key: 'subject', label: 'Subject' },
          { key: 'status', label: 'Status', render: (r: any) => <Badge tone={r.state === 'resolved' || r.state === 'closed' ? 'green' : r.state === 'pending_customer' ? 'amber' : 'navy'}>{r.status}</Badge> },
          { key: 'contact_name', label: 'Raised by' }, { key: 'updated_at', label: 'Last update', render: (r: any) => fmtDateTime(r.updated_at) },
        ]} />
      </Card>
    </>
  );
}

export function NewQuery() {
  const nav = useNavigate();
  const meta = useLoad(() => publicApi.get('/portal/query-types'), []);
  const me = useLoad(() => portalApi.get('/portal/me'), []);
  const [f, setF] = useState<any>({ subject: '', description: '', query_type_key: '', company_id: '', port_code: '', custom_fields: {} });
  const [file, setFile] = useState<File | null>(null);
  const a = useAction();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await a.run(() => portalApi.post('/portal/queries', { ...f, query_type_key: f.query_type_key || undefined, company_id: f.company_id || undefined, port_code: f.port_code || undefined }));
    if (!r) return;
    if (file) { const fd = new FormData(); fd.append('file', file); await portalApi.post(`/portal/queries/${r.id}/attachments`, fd).catch(() => undefined); }
    nav(`/portal/queries/${r.id}?new=1`);
  };
  const fields = (meta.data?.custom_fields ?? []).filter((d: any) => !d.query_types.length || d.query_types.includes(f.query_type_key));
  return (
    <>
      <PageHead title="Log a query" sub="You'll receive a reference number straight away. Please don't send the same query by email as well — it's all one record." />
      <Card>
        <form className="stack" onSubmit={submit}>
          <ErrorBox error={a.error} />
          {(me.data?.companies ?? []).length > 1 && <Field label="On behalf of"><select value={f.company_id} onChange={(e) => setF({ ...f, company_id: e.target.value })}>{me.data.companies.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>}
          <div className="grid cols-2">
            <Field label="What is it about?"><select value={f.query_type_key} onChange={(e) => setF({ ...f, query_type_key: e.target.value })}><option value="">Not sure — let Namport classify it</option>{(meta.data?.types ?? []).map((t: any) => <option key={t.key} value={t.key}>{t.name}</option>)}</select></Field>
            <Field label="Port"><select value={f.port_code} onChange={(e) => setF({ ...f, port_code: e.target.value })}><option value="">Walvis Bay or not port-specific</option><option value="WB">Walvis Bay</option><option value="LZ">Lüderitz</option></select></Field>
          </div>
          <Field label="Subject"><input required value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></Field>
          <Field label="Details" hint="Include vessel, voyage, container or invoice numbers if you have them — we link them automatically."><textarea required rows={6} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
          {fields.map((d: any) => <Field key={d.key} label={d.label} hint={d.help_text}><input type={d.field_type === 'number' ? 'number' : 'text'} value={f.custom_fields[d.key] ?? ''} onChange={(e) => setF({ ...f, custom_fields: { ...f.custom_fields, [d.key]: e.target.value } })} /></Field>)}
          <Field label="Attach a document (optional)"><input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
          <button className="btn primary" disabled={a.busy}>Submit</button>
        </form>
      </Card>
    </>
  );
}

export function PortalQuery() {
  const { id } = useParams();
  const [sp] = useSearchParams();
  const q = useLoad(() => portalApi.get(`/portal/queries/${id}`), [id], { refreshMs: 60_000 });
  const [msg, setMsg] = useState('');
  const a = useAction();
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data) return <Loading />;
  const d = q.data;
  const resolved = ['resolved', 'closed'].includes(d.state);
  return (
    <>
      {sp.get('new') && <div className="alert ok">Your query has been logged as <b>{d.reference}</b>.{d.first_response_due_at ? ` We aim to respond by ${fmtDateTime(d.first_response_due_at)}.` : ''}</div>}
      <PageHead title={d.subject} sub={<>{d.reference} · {d.query_type_name ?? 'Being classified'} · logged {fmtDateTime(d.created_at)} <Badge tone={resolved ? 'green' : d.state === 'pending_customer' ? 'amber' : 'navy'}>{d.status}</Badge></>} />
      <ErrorBox error={a.error} />
      {d.state === 'pending_customer' && <div className="alert info">Namport is waiting for information from you. Reply below to continue.</div>}
      {resolved && d.resolution_note && <Card gold eyebrow="Outcome"><div style={{ whiteSpace: 'pre-wrap' }}>{d.resolution_note}</div>
        <div className="row" style={{ marginTop: 10 }}>
          {d.actions.some((x: any) => x.to === 'reopened') && <button className="btn" onClick={async () => { const reason = prompt('What is wrong with the outcome?'); if (reason && (await a.run(() => portalApi.post(`/portal/queries/${d.id}/dispute`, { reason })))) void q.reload(true); }}>I disagree with the outcome</button>}
          {d.satisfaction && !d.satisfaction.responded_at && <Link className="btn primary" to={`/survey/${d.satisfaction.token}`}>Rate how we did</Link>}
        </div>
      </Card>}
      <Card eyebrow="History — every interaction, every channel">
        {d.timeline.map((t: any) => t.channel === 'system'
          ? <div key={t.id} className="msg system">{fmtDateTime(t.occurred_at)} · {t.body}</div>
          : <div key={t.id} className={`msg ${t.direction === 'outbound' ? 'outbound' : ''}`}>
            <div className="small"><span className="who">{t.direction === 'outbound' ? `Namport — ${t.actor_name}` : t.actor_name ?? 'You'}</span> · {fmtDateTime(t.occurred_at)} · {label(t.channel)}</div>
            <div className="body">{t.body}</div>
          </div>)}
      </Card>
      {d.attachments.length > 0 && <Card eyebrow="Documents">{d.attachments.map((x: any) => <div key={x.id} className="small"><a href="#" onClick={(e) => { e.preventDefault(); void portalApi.download(`/attachments/${x.id}`); }}>📎 {x.filename}</a> · {bytes(x.size_bytes)}</div>)}</Card>}
      {!['closed', 'merged'].includes(d.state) && <Card eyebrow="Add a message">
        <textarea value={msg} onChange={(e) => setMsg(e.target.value)} aria-label="Message" />
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn primary" disabled={!msg.trim() || a.busy} onClick={async () => { if (await a.run(() => portalApi.post(`/portal/queries/${d.id}/messages`, { body: msg }))) { setMsg(''); void q.reload(true); } }}>Send</button>
          <label className="btn">Attach<input type="file" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; const fd = new FormData(); fd.append('file', f); if (await a.run(() => portalApi.post(`/portal/queries/${d.id}/attachments`, fd))) void q.reload(true); }} /></label>
        </div>
      </Card>}
    </>
  );
}

/** My company (S-51): the company administrator manages their own colleagues. */
export function MyCompany() {
  const { id } = useParams();
  const c = useLoad(() => portalApi.get(`/portal/companies/${id}`), [id]);
  const me = useLoad(() => portalApi.get('/portal/me'), []);
  const docs = useLoad(() => portalApi.get<any[]>(`/portal/companies/${id}/documents`), [id]);
  const [inv, setInv] = useState({ name: '', email: '', role: 'operations', is_portal_admin: false });
  const a = useAction();
  if (c.error) return <ErrorBox error={c.error} />;
  if (!c.data || !me.data) return <Loading />;
  const isAdmin = me.data.companies.some((x: any) => x.id === id && x.is_portal_admin);
  const d = c.data;
  return (
    <>
      <PageHead title={d.name} sub={`${d.registration_no} · ${d.ports_served.join(' + ')} · ${label(d.status)}`} />
      <ErrorBox error={a.error} />
      <Card eyebrow="People who can act for this company">
        <Table rows={d.contacts.filter((x: any) => x.link_status === 'active')} cols={[
          { key: 'name', label: 'Name', render: (r: any) => <div><b>{r.name}</b><div className="small muted">{r.email}</div></div> },
          { key: 'role', label: 'Role', render: (r: any) => isAdmin && r.id !== me.data.contact.id
            ? <select value={r.role} onChange={(e) => a.run(() => portalApi.patch(`/portal/companies/${id}/colleagues/${r.id}`, { role: e.target.value, is_portal_admin: r.is_portal_admin })).then(() => c.reload(true))}>{['primary', 'operations', 'finance', 'escalation'].map((x) => <option key={x} value={x}>{label(x)}</option>)}</select>
            : label(r.role) },
          { key: 'is_portal_admin', label: 'Administrator', render: (r: any) => isAdmin && r.id !== me.data.contact.id
            ? <input type="checkbox" checked={r.is_portal_admin} onChange={(e) => a.run(() => portalApi.patch(`/portal/companies/${id}/colleagues/${r.id}`, { role: r.role, is_portal_admin: e.target.checked })).then(() => c.reload(true))} aria-label="Administrator" />
            : r.is_portal_admin ? 'Yes' : 'No' },
          { key: 'x', label: '', render: (r: any) => isAdmin && <button className="btn sm danger" onClick={() => confirm(`Remove ${r.name}? They lose access immediately.`) && a.run(() => portalApi.del(`/portal/companies/${id}/colleagues/${r.id}`)).then(() => c.reload(true))}>Remove</button> },
        ]} />
        {isAdmin && <div className="row" style={{ marginTop: 10 }}>
          <input placeholder="Name" value={inv.name} onChange={(e) => setInv({ ...inv, name: e.target.value })} style={{ flex: 1 }} />
          <input placeholder="Email" type="email" value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} style={{ flex: 1 }} />
          <select value={inv.role} onChange={(e) => setInv({ ...inv, role: e.target.value })} style={{ width: 'auto' }}>{['operations', 'finance', 'escalation', 'primary'].map((x) => <option key={x} value={x}>{label(x)}</option>)}</select>
          <button className="btn primary" disabled={!inv.name || !inv.email} onClick={async () => { if (await a.run(() => portalApi.post(`/portal/companies/${id}/colleagues`, inv))) { setInv({ name: '', email: '', role: 'operations', is_portal_admin: false }); void c.reload(true); } }}>Add colleague</button>
        </div>}
        {isAdmin && d.join_requests?.length > 0 && <><hr /><h3>Requests to join</h3>{d.join_requests.map((j: any) => <div key={j.id} className="row">{j.name} &lt;{j.email}&gt;<button className="btn sm primary" onClick={() => a.run(() => portalApi.post(`/portal/companies/${id}/join-requests/${j.id}`, { decision: 'approve' })).then(() => c.reload(true))}>Approve</button><button className="btn sm" onClick={() => a.run(() => portalApi.post(`/portal/companies/${id}/join-requests/${j.id}`, { decision: 'reject' })).then(() => c.reload(true))}>Decline</button></div>)}</>}
      </Card>
      <Card eyebrow="Document centre" actions={<label className="btn">Upload<input type="file" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; const fd = new FormData(); fd.append('file', f); if (await a.run(() => portalApi.post(`/portal/companies/${id}/documents`, fd))) void docs.reload(true); }} /></label>}>
        <Table rows={docs.data ?? []} empty="No documents" cols={[
          { key: 'filename', label: 'Document', render: (r: any) => <a href="#" onClick={(e) => { e.preventDefault(); void portalApi.download(`/attachments/${r.id}`); }}>{r.filename}</a> },
          { key: 'reference', label: 'Query' }, { key: 'size_bytes', label: 'Size', render: (r: any) => bytes(r.size_bytes) }, { key: 'created_at', label: 'Uploaded', render: (r: any) => fmtDate(r.created_at) },
        ]} />
      </Card>
      <Card eyebrow="Interaction history">
        <TimelineList companyId={id!} />
      </Card>
    </>
  );
}

function TimelineList({ companyId }: { companyId: string }) {
  const t = useLoad(() => portalApi.get<any[]>(`/portal/companies/${companyId}/timeline`), [companyId]);
  return <ul className="timeline">{(t.data ?? []).slice(0, 50).map((x) => <li key={x.id}><b>{label(x.channel)}</b> {x.reference} · {x.subject ?? ''}<div className="small">{x.body?.slice(0, 160)}</div><div className="small muted">{fmtDateTime(x.occurred_at)}</div></li>)}</ul>;
}

export function Notices() {
  const n = useLoad(() => portalApi.get<any[]>('/portal/notifications'), []);
  useEffect(() => { void portalApi.post('/portal/notifications/read'); }, []);
  return (
    <>
      <PageHead title="Notices and updates" sub="Operational notices and updates on your queries." />
      <Card>{(n.data ?? []).map((x) => <div key={x.id} className="msg"><div className="who">{x.subject}</div><div className="body small">{x.body}</div><div className="small muted">{fmtDateTime(x.created_at)}{x.query_id && <> · <Link to={`/portal/queries/${x.query_id}`}>view query</Link></>}</div></div>)}{n.data?.length === 0 && <div className="empty">Nothing yet</div>}</Card>
    </>
  );
}

export function Account() {
  const me = useLoad(() => portalApi.get('/portal/me'), []);
  const [mfa, setMfa] = useState<any | null>(null);
  const [code, setCode] = useState('');
  const a = useAction();
  if (!me.data) return <Loading />;
  const c = me.data.contact;
  return (
    <>
      <PageHead title="Account" />
      <ErrorBox error={a.error} />
      <Card eyebrow="Your details">
        <AccountForm c={c} onSave={(body) => a.run(() => portalApi.patch('/portal/me', body)).then(() => me.reload(true))} />
      </Card>
      <Card eyebrow="Two-step verification">
        {c.mfa_enabled ? <div className="alert ok">Two-step verification is on.</div> : mfa ? (
          <div className="stack">
            <p>Add this key to your authenticator app, then enter the 6-digit code.</p>
            <code>{mfa.secret}</code>
            <input placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} style={{ maxWidth: 160 }} />
            <button className="btn primary" onClick={() => a.run(() => portalApi.post('/portal/me/mfa/confirm', { code })).then(() => me.reload(true))}>Turn on</button>
          </div>
        ) : <button className="btn" onClick={async () => setMfa(await a.run(() => portalApi.post('/portal/me/mfa')))}>Set up two-step verification</button>}
      </Card>
    </>
  );
}

function AccountForm({ c, onSave }: { c: any; onSave: (b: any) => void }) {
  const [f, setF] = useState({ name: c.name, phone: c.phone ?? '', position: c.position ?? '', notification_preferences: c.notification_preferences ?? { email: true, portal: true } });
  return (
    <div className="stack">
      <div className="grid cols-3">
        <Field label="Name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Phone"><input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        <Field label="Position"><input value={f.position} onChange={(e) => setF({ ...f, position: e.target.value })} /></Field>
      </div>
      <div className="row">Notify me by: {(['email', 'portal'] as const).map((k) => <label key={k} className="inline-check"><input type="checkbox" checked={f.notification_preferences[k] !== false} onChange={(e) => setF({ ...f, notification_preferences: { ...f.notification_preferences, [k]: e.target.checked } })} />{label(k)}</label>)}</div>
      <button className="btn primary" onClick={() => onSave(f)} style={{ width: 'fit-content' }}>Save</button>
    </div>
  );
}

/** Satisfaction capture (S-54). */
export function Survey() {
  const { token } = useParams();
  const s = useLoad(() => publicApi.get(`/portal/survey/${token}`), [token]);
  const [score, setScore] = useState(0);
  const [comment, setComment] = useState('');
  const [done, setDone] = useState(false);
  const a = useAction();
  return (
    <div className="auth-shell">
      <div className="auth-card stack">
        <div className="brand"><img src="/icon.svg" alt="" />NAMPORT</div>
        <ErrorBox error={a.error ?? s.error} />
        {s.data && (done || s.data.responded_at ? <div className="alert ok">Thank you for your feedback.</div> : <>
          <h2>How did we handle {s.data.reference}?</h2>
          <p className="muted">{s.data.subject}</p>
          <div className="row" role="radiogroup" aria-label="Score">{[1, 2, 3, 4, 5].map((n) => <button key={n} role="radio" aria-checked={score === n} className={`btn ${score === n ? 'primary' : ''}`} onClick={() => setScore(n)}>{n}</button>)}</div>
          <div className="small muted">1 = very poor · 5 = excellent</div>
          <textarea placeholder="Anything we should know? (optional)" value={comment} onChange={(e) => setComment(e.target.value)} />
          <button className="btn primary" disabled={!score} onClick={async () => { if (await a.run(() => publicApi.post(`/portal/survey/${token}`, { score, comment }))) setDone(true); }}>Submit</button>
        </>)}
      </div>
    </div>
  );
}

/** The page embedded on namport.com.na (S-23): Assist plus a query form for visitors. */
export function Widget() {
  const [tab, setTab] = useState<'assist' | 'form'>('assist');
  const [f, setF] = useState({ name: '', email: '', subject: '', message: '', website: '' });
  const [sp] = useSearchParams();
  const [ref, setRef] = useState<string | null>(null);
  const a = useAction();
  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--panel)' }}>
      <div style={{ background: 'var(--navy)', color: '#fff', padding: '12px 14px', fontWeight: 700 }}>Namport · Ask us</div>
      <div className="tabs" style={{ padding: '0 8px', margin: 0 }}>
        <button className={tab === 'assist' ? 'on' : ''} onClick={() => setTab('assist')}>Sinapse Assist</button>
        <button className={tab === 'form' ? 'on' : ''} onClick={() => setTab('form')}>Send a query</button>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
        {tab === 'assist' ? <AssistChat mode="website" compact /> : ref ? (
          <div className="alert ok">Thank you. {ref === 'received' ? 'Your message has been received.' : <>Your reference is <b>{ref}</b>. We have emailed you a confirmation.</>}</div>
        ) : (
          <form className="stack" onSubmit={async (e) => { e.preventDefault(); const r = await a.run(() => publicApi.post('/portal/widget/query', { ...f, port: sp.get('port') ?? undefined })); if (r) setRef(r.reference ?? 'received'); }}>
            <ErrorBox error={a.error} />
            <Field label="Name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Email"><input type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
            <Field label="Subject"><input required value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></Field>
            <Field label="Message"><textarea required value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} /></Field>
            <input tabIndex={-1} autoComplete="off" className="sr-only" aria-hidden name="website" value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} />
            <button className="btn primary" disabled={a.busy}>Send</button>
            <div className="small muted">Registered customers: <a href="/portal" target="_top">sign in to the portal</a> to track all your queries.</div>
          </form>
        )}
      </div>
    </div>
  );
}
