/** Thin client for the Sinapse REST API. Staff and customer realms keep separate tokens. */
export type Realm = 'staff' | 'customer';
const KEY: Record<Realm, string> = { staff: 'sinapse.staff', customer: 'sinapse.customer' };

const storage = {
  get(k: string) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string | null) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private mode */ } },
};

export const auth = {
  token: (r: Realm) => storage.get(KEY[r]),
  set: (r: Realm, t: string | null) => storage.set(KEY[r], t),
};

export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: unknown) { super(message); }
}

async function request<T>(realm: Realm | null, method: string, path: string, body?: unknown, opts: { raw?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const token = realm ? auth.token(realm) : null;
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`/api/v1${path}`, { method, headers, body: payload });
  if (res.status === 401 && realm) {
    auth.set(realm, null);
    if (!location.pathname.endsWith('/login')) location.assign(realm === 'staff' ? '/login' : '/portal/login');
  }
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new ApiError(res.status, j.error ?? res.statusText, j.details);
  }
  if (opts.raw) return res as unknown as T;
  if (res.status === 204) return undefined as T;
  return res.json();
}

const client = (realm: Realm | null) => ({
  get: <T = any>(p: string) => request<T>(realm, 'GET', p),
  post: <T = any>(p: string, b?: unknown) => request<T>(realm, 'POST', p, b ?? {}),
  patch: <T = any>(p: string, b?: unknown) => request<T>(realm, 'PATCH', p, b ?? {}),
  put: <T = any>(p: string, b?: unknown) => request<T>(realm, 'PUT', p, b ?? {}),
  del: <T = any>(p: string) => request<T>(realm, 'DELETE', p),
  download: async (p: string, body?: unknown, filename = 'export') => {
    const res = await request<Response>(realm, body ? 'POST' : 'GET', p, body, { raw: true });
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') ?? '';
    const name = cd.match(/filename="([^"]+)"/)?.[1] ?? filename;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  },
});

export const api = client('staff');
export const portalApi = client('customer');
export const publicApi = client(null);

export const qs = (o: Record<string, unknown>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '' && v !== false) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};
