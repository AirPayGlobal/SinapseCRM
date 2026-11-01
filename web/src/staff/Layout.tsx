import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { api, auth } from '../api';
import { useLoad } from '../hooks';
import { fmtDateTime } from '../format';
import { StaffProvider, useCan, useStaff } from './context';

function Notifications({ onClose }: { onClose: () => void }) {
  const n = useLoad(() => api.get<any[]>('/me/notifications'), []);
  const nav = useNavigate();
  return (
    <div className="card" style={{ position: 'absolute', right: 0, top: 44, width: 360, maxHeight: 440, overflow: 'auto', zIndex: 40 }}>
      <div className="row between"><h3>Notifications</h3><button className="btn sm" onClick={() => api.post('/me/notifications/read').then(onClose)}>Mark all read</button></div>
      {(n.data ?? []).map((x) => (
        <div key={x.id} className="msg" style={{ cursor: x.query_id ? 'pointer' : undefined, opacity: x.read_at ? 0.6 : 1 }} onClick={() => { if (x.query_id) { nav(`/cases/${x.query_id}`); onClose(); } }}>
          <div className="who small">{x.subject}</div>
          <div className="small muted">{x.body?.slice(0, 160)}</div>
          <div className="small muted">{fmtDateTime(x.created_at)}</div>
        </div>
      ))}
      {n.data?.length === 0 && <div className="empty">You're all caught up</div>}
    </div>
  );
}

function Shell() {
  const { me, ref, reload } = useStaff();
  const can = useCan();
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  const port = ref.ports.find((p) => p.code === me.portCode)?.name.replace('Port of ', '') ?? 'Both ports';
  const dept = ref.departments.find((d) => d.id === me.departmentId)?.name ?? 'All departments';
  const initials = me.name.split(' ').map((x) => x[0]).slice(0, 2).join('');
  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <header className="topbar">
        <div className="brand"><img src="/icon.svg" alt="" />SINAPSE <span>CRM</span></div>
        <nav className="nav" aria-label="Main">
          {can('query.read') && <NavLink to="/queue">My queue {me.counts.my_queue}</NavLink>}
          {can('query.reassign') && <NavLink to="/team">Team queue {me.counts.team_queue}</NavLink>}
          {can('query.create') && <NavLink to="/capture">Log query</NavLink>}
          {can('customer.read') && <NavLink to="/customers">Customers</NavLink>}
          {can('kb.write', 'kb.publish') && <NavLink to="/knowledge">Knowledge</NavLink>}
          {can('report.read') && <NavLink to="/dashboard">Reports</NavLink>}
          {can('port.read') && <NavLink to="/port">Port</NavLink>}
          {can('finding.read') && <NavLink to="/findings">Findings</NavLink>}
          {can('admin.config', 'admin.users', 'audit.read', 'integration.manage') && <NavLink to="/admin">Admin</NavLink>}
        </nav>
        <div className="right" style={{ position: 'relative' }}>
          <span className="hide-sm muted">{port} · {dept}</span>
          <select aria-label="Presence" value={me.presence} style={{ width: 'auto', padding: '4px 6px' }} onChange={(e) => api.patch('/me/presence', { presence: e.target.value }).then(reload)}>
            {['available', 'busy', 'away', 'offline'].map((p) => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}
          </select>
          <button className="bell" onClick={() => setOpen((o) => !o)} aria-expanded={open}>Notifications{me.counts.unread ? <b>{me.counts.unread}</b> : null}</button>
          {open && <Notifications onClose={() => { setOpen(false); reload(); }} />}
          <button className="avatar" title={`${me.name} — sign out`} style={{ border: 0, cursor: 'pointer' }} onClick={() => { auth.set('staff', null); nav('/login'); }}>{initials}</button>
        </div>
      </header>
      <main id="main"><Outlet /></main>
    </>
  );
}

export default function StaffLayout() {
  return <StaffProvider><Shell /></StaffProvider>;
}
