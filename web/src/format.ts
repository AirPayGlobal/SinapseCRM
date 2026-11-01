const TZ = 'Africa/Windhoek';
export const fmtDate = (d?: string | null) => (d ? new Date(d).toLocaleDateString('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' }) : '—');
export const fmtDateTime = (d?: string | null) => (d ? new Date(d).toLocaleString('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
export const fmtTime = (d?: string | null) => (d ? new Date(d).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }) : '—');
export const fmtNum = (n?: number | string | null, digits = 0) => (n == null || n === '' ? '—' : Number(n).toLocaleString('en-GB', { maximumFractionDigits: digits }));
export function fmtMinutes(m?: number | null) {
  if (m == null) return '—';
  const a = Math.abs(m);
  const s = a < 60 ? `${a} min` : a < 1440 ? `${Math.floor(a / 60)} h ${a % 60 ? `${a % 60} min` : ''}`.trim() : `${Math.floor(a / 1440)} d ${Math.floor((a % 1440) / 60)} h`;
  return m < 0 ? `${s} overdue` : s;
}
export const label = (s?: string | null) => (s ?? '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
export const bytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
