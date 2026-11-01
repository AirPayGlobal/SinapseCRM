import { Link } from 'react-router-dom';
import { api, qs } from '../api';
import { Badge, Card, ErrorBox, PageHead, Table } from '../components/ui';
import { fmtDateTime } from '../format';
import { useAction, useLoad } from '../hooks';

/** Filtered / review queue (S-07) and near-duplicate merge queue (S-08). */
export default function Review() {
  const filtered = useLoad(() => api.get(`/queries${qs({ state: 'filtered', sort: 'created', limit: 200 })}`), []);
  const dups = useLoad(() => api.get(`/queries${qs({ duplicates: true, sort: 'created', limit: 200 })}`), []);
  const a = useAction();
  const decide = async (id: string, decision: 'release' | 'confirm') => { await a.run(() => api.post(`/queries/${id}/filter-review`, { decision })); void filtered.reload(true); };
  return (
    <>
      <PageHead title="Review queues" sub="Filtered traffic is never deleted. Releasing an item routes it normally and teaches the filter." />
      <ErrorBox error={a.error} />
      <Card eyebrow="Filtered — irrelevant traffic (QMC-05)">
        <Table rows={(filtered.data?.items ?? []).filter((q: any) => !q.closed_at)} empty="Nothing waiting for review" cols={[
          { key: 'reference', label: 'Reference', render: (r: any) => <Link to={`/cases/${r.id}`}>{r.reference}</Link> },
          { key: 'subject', label: 'Subject', render: (r: any) => <div><b>{r.subject}</b><div className="small muted">{r.contact_name ?? r.company_name ?? 'Unknown sender'}</div></div> },
          { key: 'filter_reason', label: 'Why it was filtered', render: (r: any) => <Badge tone="amber">{r.filter_reason}</Badge> },
          { key: 'created_at', label: 'Received', render: (r: any) => fmtDateTime(r.created_at) },
          { key: 'act', label: '', render: (r: any) => <div className="row"><button className="btn sm primary" onClick={() => decide(r.id, 'release')}>Release</button><button className="btn sm" onClick={() => decide(r.id, 'confirm')}>Confirm filter</button></div> },
        ]} />
      </Card>
      <Card eyebrow="Near-duplicates offered for merge">
        <Table rows={dups.data?.items ?? []} empty="No suspected duplicates" cols={[
          { key: 'reference', label: 'Case', render: (r: any) => <Link to={`/cases/${r.id}`}>{r.reference}</Link> },
          { key: 'subject', label: 'Subject' },
          { key: 'company_name', label: 'Customer' },
          { key: 'created_at', label: 'Received', render: (r: any) => fmtDateTime(r.created_at) },
          { key: 'go', label: '', render: (r: any) => <Link className="btn sm" to={`/cases/${r.id}`}>Review and merge</Link> },
        ]} />
      </Card>
    </>
  );
}
