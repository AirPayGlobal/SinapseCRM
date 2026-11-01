import { createContext, useContext, type ReactNode } from 'react';
import { api } from '../api';
import { useLoad } from '../hooks';

export interface Me {
  id: string; name: string; email: string; roleKey: string; portCode: string | null; departmentId: string | null;
  permissions: string[]; landing_view: string; presence: string;
  counts: { my_queue: number; team_queue: number; unread: number; tasks: number; filtered: number; registrations: number };
}
export interface Reference {
  ports: { code: string; name: string }[]; departments: { id: string; code: string; name: string }[];
  query_types: { key: string; name: string; department_id: string; weight: number; skill: string | null; active: boolean }[];
  queues: { id: string; key: string; name: string }[]; corridors: { id: string; code: string; name: string }[];
  roles: { key: string; name: string }[]; users: { id: string; name: string; email: string; role_key: string; port_code: string | null }[];
  finding_types: { key: string; name: string }[]; urgencies: string[]; webhook_events: string[];
}

const Ctx = createContext<{ me: Me; ref: Reference; reload: () => void } | null>(null);

export function StaffProvider({ children }: { children: ReactNode }) {
  const me = useLoad(() => api.get<Me>('/me'), [], { refreshMs: 30_000 });
  const ref = useLoad(() => api.get<Reference>('/admin/reference'), []);
  if (me.error || ref.error) return <div className="loading">Could not load your session: {me.error ?? ref.error}. <a href="/login">Sign in again</a></div>;
  if (!me.data || !ref.data) return <div className="loading">Loading Sinapse CRM…</div>;
  return <Ctx.Provider value={{ me: me.data, ref: ref.data, reload: () => { void me.reload(true); } }}>{children}</Ctx.Provider>;
}

export const useStaff = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error('useStaff outside provider');
  return c;
};
export const useCan = () => {
  const { me } = useStaff();
  return (...p: string[]) => me.permissions.includes('*') || p.some((x) => me.permissions.includes(x));
};
