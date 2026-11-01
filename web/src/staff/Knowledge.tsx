import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../api';
import { Badge, Bars, Card, ErrorBox, Field, Loading, Modal, PageHead, Stat, Table, Tabs } from '../components/ui';
import { fmtDate, fmtDateTime, label } from '../format';
import { useAction, useLoad } from '../hooks';
import { useCan } from './context';

type Tab = 'library' | 'gaps' | 'governance' | 'conversations' | 'classification';

export default function Knowledge() {
  const can = useCan();
  const [tab, setTab] = useState<Tab>('library');
  return (
    <>
      <PageHead title="Knowledge and Sinapse Assist" sub="Assist answers only from published articles. New content takes effect the moment a named approver publishes it." />
      <Tabs value={tab} onChange={setTab} tabs={[
        { key: 'library', label: 'Library' }, { key: 'gaps', label: 'Knowledge gaps' },
        ...(can('kb.publish', 'admin.config') ? [{ key: 'governance' as Tab, label: 'AI governance' }, { key: 'conversations' as Tab, label: 'Conversation audit' }, { key: 'classification' as Tab, label: 'Classification review' }] : []),
      ]} />
      {tab === 'library' && <Library />}
      {tab === 'gaps' && <Gaps />}
      {tab === 'governance' && <Governance />}
      {tab === 'conversations' && <Conversations />}
      {tab === 'classification' && <Classification />}
    </>
  );
}

function Library() {
  const can = useCan();
  const [state, setState] = useState('');
  const [q, setQ] = useState('');
  const list = useLoad(() => api.get<any[]>(`/kb/articles${qs({ state, q })}`), [state, q]);
  const [edit, setEdit] = useState<any | null>(null);
  return (
    <Card actions={<>
      <input placeholder="Search articles" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 220 }} />
      <select value={state} onChange={(e) => setState(e.target.value)} style={{ width: 'auto' }}><option value="">All states</option>{['draft', 'review', 'published', 'archived'].map((s) => <option key={s} value={s}>{label(s)}</option>)}</select>
      {can('kb.write') && <button className="btn primary" onClick={() => setEdit({ title: '', body: '', category: '', audience_scope: 'public' })}>New article</button>}
    </>}>
      <Table rows={list.data ?? []} onRow={(r: any) => api.get(`/kb/articles/${r.id}`).then(setEdit)} cols={[
        { key: 'title', label: 'Article', render: (r: any) => <div><b>{r.title}</b> {r.proposed_by_assist && <Badge tone="gold">Proposed from a case</Badge>}<div className="small muted">{r.excerpt}</div></div> },
        { key: 'category', label: 'Category' }, { key: 'audience_scope', label: 'Audience', render: (r: any) => label(r.audience_scope) },
        { key: 'state', label: 'State', render: (r: any) => <Badge tone={r.state === 'published' ? 'green' : r.state === 'review' ? 'gold' : undefined}>{label(r.state)} v{r.version}</Badge> },
        { key: 'answered_count', label: 'Answers', num: true }, { key: 'approved_by_name', label: 'Approved by' },
      ]} />
      {edit && <Editor article={edit} onClose={() => { setEdit(null); void list.reload(true); }} />}
    </Card>
  );
}

function Editor({ article, onClose }: { article: any; onClose: () => void }) {
  const can = useCan();
  const [a, setA] = useState(article);
  const act = useAction();
  const save = async () => {
    const r = article.id ? await act.run(() => api.patch(`/kb/articles/${article.id}`, a)) : await act.run(() => api.post('/kb/articles', a));
    if (r) { if (r.revises) alert('A new draft version was created; the published article stays live until it is approved.'); onClose(); }
  };
  const move = async (to: string) => { if (await act.run(() => api.post(`/kb/articles/${article.id}/state`, { to }))) onClose(); };
  return (
    <Modal title={article.id ? `${article.title} — ${label(article.state)} v${article.version}` : 'New article'} onClose={onClose}>
      <ErrorBox error={act.error} />
      <div className="stack">
        <Field label="Title"><input value={a.title} onChange={(e) => setA({ ...a, title: e.target.value })} /></Field>
        <div className="grid cols-2">
          <Field label="Category"><input value={a.category ?? ''} onChange={(e) => setA({ ...a, category: e.target.value })} /></Field>
          <Field label="Audience"><select value={a.audience_scope} onChange={(e) => setA({ ...a, audience_scope: e.target.value })}><option value="public">Public (website and portal)</option><option value="customer">Signed-in customers</option><option value="staff">Staff only (agent assist)</option></select></Field>
        </div>
        <Field label="Body" hint="Write in plain sentences; Assist quotes the passages most relevant to the question."><textarea rows={10} value={a.body} onChange={(e) => setA({ ...a, body: e.target.value })} /></Field>
        {article.source_query_reference && <div className="small muted">Proposed from case {article.source_query_reference}</div>}
        {article.approved_by_name && <div className="small muted">Approved by {article.approved_by_name} on {fmtDate(article.published_at)}</div>}
        <div className="row">
          {can('kb.write') && <button className="btn primary" onClick={save}>{article.state === 'published' ? 'Save as new version' : 'Save'}</button>}
          {article.state === 'draft' && <button className="btn" onClick={() => move('review')}>Submit for review</button>}
          {article.state === 'review' && can('kb.publish') && <button className="btn gold" onClick={() => move('published')}>Approve and publish</button>}
          {article.state === 'review' && <button className="btn" onClick={() => move('draft')}>Return to draft</button>}
          {['published', 'draft'].includes(article.state) && <button className="btn danger" onClick={() => move('archived')}>Archive</button>}
        </div>
      </div>
    </Modal>
  );
}

function Gaps() {
  const g = useLoad(() => api.get<any[]>('/kb/gaps'), []);
  const [draft, setDraft] = useState<any | null>(null);
  return (
    <Card eyebrow="Questions Assist repeatedly could not answer — ranked by demand">
      <Table rows={g.data ?? []} empty="No open knowledge gaps" cols={[
        { key: 'question', label: 'Question', render: (r: any) => <div><b>{r.question}</b>{r.variants > 1 && <div className="small muted">Also asked as: {r.examples.slice(1, 4).join(' · ')}</div>}</div> },
        { key: 'total_asks', label: 'Times asked', num: true }, { key: 'last_asked_at', label: 'Last asked', render: (r: any) => fmtDateTime(r.last_asked_at) },
        { key: 'x', label: '', render: (r: any) => <div className="row">
          <button className="btn sm primary" onClick={() => setDraft({ title: r.question, body: '', category: '', audience_scope: 'public', gap_ids: r.gap_ids })}>Write article</button>
          <button className="btn sm" onClick={() => api.post('/kb/gaps/dismiss', { ids: r.gap_ids }).then(() => g.reload(true))}>Dismiss</button></div> },
      ]} />
      {draft && <Editor article={draft} onClose={() => { setDraft(null); void g.reload(true); }} />}
    </Card>
  );
}

function Governance() {
  const g = useLoad(() => api.get('/kb/governance'), []);
  if (!g.data) return g.error ? <ErrorBox error={g.error} /> : <Loading />;
  const d = g.data;
  return (
    <div className="grid cols-2">
      <Card eyebrow="Retrieval and grounding">
        <dl className="kv left">
          <dt>Grounding mode</dt><dd>{d.grounding_mode}</dd>
          <dt>Confidence gate</dt><dd>{Math.round(d.confidence_threshold * 100)}% (Admin → Settings)</dd>
          <dt>Retrieval</dt><dd>{d.model.retrieval}</dd>
          <dt>Classifier</dt><dd>{d.model.classifier}</dd>
          <dt>Phrasing</dt><dd>{d.model.phrasing}</dd>
        </dl>
      </Card>
      <Card gold eyebrow="Hard-locked safeguards — cannot be switched off">
        <ul>{d.locked_safeguards.map((s: string) => <li key={s}>{s}</li>)}</ul>
      </Card>
      <Card eyebrow="Confidence distribution · 30 days">
        <Bars rows={d.confidence_distribution.map((b: any) => ({ label: `${b.bucket} answered`, value: b.answered }))} />
        <hr /><Bars rows={d.confidence_distribution.map((b: any) => ({ label: `${b.bucket} declined`, value: b.declined }))} />
      </Card>
      <Card eyebrow="Outcomes">
        <div className="grid cols-2">
          <Stat label="Deflection rate" value={d.deflection?.deflection_rate != null ? `${d.deflection.deflection_rate}%` : '—'} />
          <Stat label="Classification accuracy" value={d.classification?.accuracy_percent != null ? `${d.classification.accuracy_percent}%` : '—'} sub={`${d.classification?.reviewed ?? 0} confirmed by agents`} />
        </div>
        <hr /><Bars rows={d.intents.map((i: any) => ({ label: i.intent, value: i.n }))} />
      </Card>
    </div>
  );
}

function Conversations() {
  const [outcome, setOutcome] = useState('');
  const c = useLoad(() => api.get<any[]>(`/kb/conversations${qs({ outcome })}`), [outcome]);
  const [open, setOpen] = useState<any | null>(null);
  return (
    <Card actions={<select value={outcome} onChange={(e) => setOutcome(e.target.value)} style={{ width: 'auto' }}><option value="">All outcomes</option>{['answered', 'acted', 'handed_over', 'declined', 'open'].map((o) => <option key={o} value={o}>{label(o)}</option>)}</select>}>
      <Table rows={c.data ?? []} onRow={setOpen} cols={[
        { key: 'updated_at', label: 'When', render: (r: any) => fmtDateTime(r.updated_at) }, { key: 'channel', label: 'Channel' },
        { key: 'contact_name', label: 'Customer', render: (r: any) => r.contact_name ?? 'Website visitor' }, { key: 'turns', label: 'Turns', num: true },
        { key: 'outcome', label: 'Outcome', render: (r: any) => <Badge tone={r.outcome === 'handed_over' ? 'gold' : r.outcome === 'declined' ? 'amber' : 'green'}>{label(r.outcome)}</Badge> },
        { key: 'ref', label: 'Case', render: (r: any) => r.created_reference ?? r.handed_over_reference ?? '—' },
      ]} />
      {open && <Modal title="Assist conversation" onClose={() => setOpen(null)}>
        <div className="chat">{open.transcript.map((t: any, i: number) => (
          <div key={i} className={`bubble ${t.role === 'customer' ? 'me' : 'bot'}`}>{t.text}{t.role === 'assist' && <div className="src">{t.intent}{t.confidence != null ? ` · confidence ${Math.round(t.confidence * 100)}%` : ''}</div>}</div>
        ))}</div>
      </Modal>}
    </Card>
  );
}

function Classification() {
  const c = useLoad(() => api.get<any[]>('/kb/classification-review'), []);
  return (
    <Card eyebrow="Agent overrides of the AI classification — every one is training signal">
      <Table rows={c.data ?? []} empty="No overrides yet" cols={[
        { key: 'reference', label: 'Case', render: (r: any) => <Link to={`/cases/${r.reference}`}>{r.reference}</Link> },
        { key: 'subject', label: 'Subject' },
        { key: 'predicted', label: 'AI proposed', render: (r: any) => `${label(r.predicted?.query_type ?? r.predicted?.filter_reason ?? '')} ${r.predicted?.confidence ? `(${Math.round(r.predicted.confidence * 100)}%)` : ''}` },
        { key: 'final', label: 'Agent decided', render: (r: any) => label(r.final?.query_type ?? r.final?.decision ?? '') },
        { key: 'actor_name', label: 'By' }, { key: 'created_at', label: 'When', render: (r: any) => fmtDateTime(r.created_at) },
      ]} />
    </Card>
  );
}
