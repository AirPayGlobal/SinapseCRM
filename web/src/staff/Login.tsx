import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { auth, publicApi } from '../api';
import { useAction } from '../hooks';
import { ErrorBox, Field } from '../components/ui';

export default function Login() {
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [methods, setMethods] = useState<{ entra: boolean; local: boolean }>({ entra: false, local: true });
  const a = useAction();
  useEffect(() => {
    const h = new URLSearchParams(location.hash.slice(1));
    if (h.get('token')) { auth.set('staff', h.get('token')); history.replaceState(null, '', '/login'); nav('/'); }
    if (h.get('error')) a.setError(h.get('error'));
    publicApi.get('/auth/methods').then(setMethods).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await a.run(() => publicApi.post<{ token: string }>('/auth/login', { email, password }));
    if (r) { auth.set('staff', r.token); nav('/'); }
  };
  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="brand" style={{ marginBottom: 6 }}><img src="/icon.svg" alt="" />SINAPSE <span>CRM</span></div>
        <p className="muted">Namibian Ports Authority — staff sign-in</p>
        <ErrorBox error={a.error} />
        {methods.entra && (
          <>
            <a className="btn primary" style={{ width: '100%', justifyContent: 'center' }} href="/api/v1/auth/entra/start">Sign in with your Namport Microsoft account</a>
            {methods.local && <p className="small muted" style={{ textAlign: 'center' }}>or</p>}
          </>
        )}
        {methods.local && (
          <form onSubmit={submit} className="stack">
            <Field label="Email"><input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
            <Field label="Password"><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
            <button className="btn primary" disabled={a.busy} style={{ width: '100%', justifyContent: 'center' }}>Sign in</button>
          </form>
        )}
        <hr />
        <p className="small muted">Customers: use the <a href="/portal">customer portal</a>.</p>
      </div>
    </div>
  );
}
