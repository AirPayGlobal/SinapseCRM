import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, qs } from '../api';
import { Badge, Card, ErrorBox, Field, PageHead } from '../components/ui';
import { label } from '../format';
import { useAction } from '../hooks';
import { useStaff } from './context';

/** Quick capture (S-04): log a telephone query while the caller is still speaking. */
export default function Capture() {
  const { ref, me } = useStaff();
  const nav = useNavigate();
  const [lookup, setLookup] = useState('');
  const [matches, setMatches] = useState<any[]>([]);
  const [contact, setContact] = useState<any | null>(null);
  const [form, setForm] = useState({ subject: '', description: '', query_type_key: '', urgency: '', port_code: me.portCode ?? 'WB', duration: '', channel: 'staff' });
  const [pred, setPred] = useState<any | null>(null);
  const a = useAction();

  useEffect(() => {
    if (lookup.length < 2) { setMatches([]); return; }
    const t = setTimeout(() => api.get<any[]>(`/customers/contacts${qs({ q: lookup })}`).then(setMatches).catch(() => undefined), 250);
    return () => clearTimeout(t);
  }, [lookup]);

  useEffect(() => {
    const text = `${form.subject} ${form.description}`.trim();
    if (text.length < 12) { setPred(null); return; }
    const t = setTimeout(() => api.post('/queries/classify', { subject: form.subject, description: form.description, contact_id: contact?.id, company_id: contact?.companies?.[0]?.id }).then(setPred).catch(() => undefined), 400);
    return () => clearTimeout(t);
  }, [form.subject, form.description, contact]);

  const submit = async () => {
    const r = await a.run(() => api.post('/queries', {
      subject: form.subject, description: form.description, query_type_key: form.query_type_key || pred?.classification?.query_type || undefined,
      urgency: form.urgency || pred?.classification?.urgency || undefined, port_code: form.port_code, contact_id: contact?.id, company_id: contact?.companies?.[0]?.id,
      channel: form.channel, call: form.channel === 'staff' ? { direction: 'inbound', duration_seconds: form.duration ? Number(form.duration) * 60 : undefined } : undefined,
    }));
    if (r) nav(`/cases/${r.query.id}`);
  };
  const set = (k: string) => (e: any) => setForm({ ...form, [k]: e.target.value });
  const predicted = pred?.classification;

  return (
    <>
      <PageHead title="Log a query" sub="Customer lookup, category prediction and sensible defaults — the reference is issued the moment you save." />
      <div className="grid cols-2">
        <Card eyebrow="Caller">
          <Field label="Find the customer (name, email or phone)"><input autoFocus value={lookup} onChange={(e) => setLookup(e.target.value)} placeholder="Start typing…" /></Field>
          {contact ? (
            <div className="alert ok" style={{ marginTop: 10 }}>
              <b>{contact.name}</b> · {contact.email}<br />{(contact.companies ?? []).map((c: any) => `${c.name} (${c.role})`).join(', ') || 'No company'}
              <div><button className="btn link" onClick={() => setContact(null)}>Change</button></div>
            </div>
          ) : matches.map((m) => (
            <button key={m.id} className="qitem" style={{ width: '100%', textAlign: 'left', cursor: 'pointer' }} onClick={() => { setContact(m); setMatches([]); }}>
              <div className="title">{m.name}</div><div className="small muted">{m.email} · {m.phone ?? ''} · {(m.companies ?? []).map((c: any) => c.name).join(', ')}</div>
            </button>
          ))}
          <div className="grid cols-2" style={{ marginTop: 10 }}>
            <Field label="Channel"><select value={form.channel} onChange={set('channel')}><option value="staff">Telephone / walk-in</option><option value="email">Email (forwarded)</option></select></Field>
            {form.channel === 'staff' && <Field label="Call duration (min)"><input value={form.duration} onChange={set('duration')} inputMode="numeric" /></Field>}
          </div>
        </Card>
        <Card eyebrow="Query">
          <ErrorBox error={a.error} />
          <div className="stack">
            <Field label="Subject"><input value={form.subject} onChange={set('subject')} /></Field>
            <Field label="What the customer needs"><textarea value={form.description} onChange={set('description')} rows={5} /></Field>
            {predicted && (
              <div className="alert info small">
                Predicted: <b>{ref.query_types.find((t) => t.key === predicted.query_type)?.name ?? predicted.query_type}</b> ({Math.round(predicted.confidence * 100)}%) · urgency <b>{label(predicted.urgency)}</b>
                {pred?.possible_duplicate && <div style={{ marginTop: 4 }}><Badge tone="amber">Possible duplicate</Badge> of {pred.possible_duplicate.reference} — it will be offered for merge.</div>}
              </div>
            )}
            <div className="grid cols-3">
              <Field label="Type"><select value={form.query_type_key} onChange={set('query_type_key')}><option value="">{predicted ? 'Use prediction' : 'Choose…'}</option>{ref.query_types.filter((t) => t.active).map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}</select></Field>
              <Field label="Urgency"><select value={form.urgency} onChange={set('urgency')}><option value="">{predicted ? 'Use prediction' : 'Normal'}</option>{ref.urgencies.map((u) => <option key={u} value={u}>{label(u)}</option>)}</select></Field>
              <Field label="Port"><select value={form.port_code} onChange={set('port_code')}>{ref.ports.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</select></Field>
            </div>
            <button className="btn primary" disabled={!form.subject || a.busy} onClick={submit}>Save and issue reference</button>
          </div>
        </Card>
      </div>
    </>
  );
}
