import { type CSSProperties, type ReactNode, useState } from 'react';
import { fmtMinutes, label } from '../format';

export const Card = ({ title, eyebrow, actions, children, gold, className = '' }: { title?: ReactNode; eyebrow?: string; actions?: ReactNode; children?: ReactNode; gold?: boolean; className?: string }) => (
  <section className={`card ${gold ? 'gold' : ''} ${className}`}>
    {(eyebrow || title || actions) && (
      <div className="row between" style={{ marginBottom: 8 }}>
        <div>
          {eyebrow && <div className="eyebrow">{eyebrow}</div>}
          {title && <h2>{title}</h2>}
        </div>
        {actions && <div className="row">{actions}</div>}
      </div>
    )}
    {children}
  </section>
);

export const Badge = ({ tone, children, title }: { tone?: 'navy' | 'gold' | 'goldfill' | 'green' | 'red' | 'amber'; children: ReactNode; title?: string }) => (
  <span className={`badge ${tone ?? ''}`} title={title}>{children}</span>
);

export const PageHead = ({ title, sub, actions }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode }) => (
  <div className="page-head">
    <div>
      <h1>{title}</h1>
      {sub && <p>{sub}</p>}
    </div>
    {actions && <div className="row">{actions}</div>}
  </div>
);

export const Loading = () => <div className="loading" role="status">Loading…</div>;
export const ErrorBox = ({ error }: { error?: string | null }) => (error ? <div className="alert error" role="alert">{error}</div> : null);
export const Empty = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>;

export function Field({ label: l, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span>{l}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { key: T; label: ReactNode }[]; value: T; onChange: (k: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.key} role="tab" aria-selected={value === t.key} className={value === t.key ? 'on' : ''} onClick={() => onChange(t.key)}>{t.label}</button>
      ))}
    </div>
  );
}

export const Stat = ({ label: l, value, warn, sub }: { label: string; value: ReactNode; warn?: boolean; sub?: ReactNode }) => (
  <div className={`stat ${warn ? 'warn' : ''}`}>
    <div className="v">{value ?? '—'}</div>
    <div className="l">{l}</div>
    {sub && <div className="small muted">{sub}</div>}
  </div>
);

export function Bars({ rows, onPick, format }: { rows: { label: string; value: number; key?: string }[]; onPick?: (key?: string, label?: string) => void; format?: (n: number) => string }) {
  const max = Math.max(1, ...rows.map((r) => Number(r.value) || 0));
  if (!rows.length) return <Empty>No data for this period</Empty>;
  return (
    <div className="bars">
      {rows.map((r) => (
        <div className="bar" key={`${r.key ?? r.label}`}>
          {onPick ? <button title={`Show the cases behind "${r.label}"`} onClick={() => onPick(r.key, r.label)}>{label(r.label)}</button> : <span>{label(r.label)}</span>}
          <div className="track" aria-hidden><div className="fill" style={{ width: `${(100 * (Number(r.value) || 0)) / max}%` }} /></div>
          <span className="n">{format ? format(r.value) : r.value}</span>
        </div>
      ))}
    </div>
  );
}

/** Small multi-series line chart (SVG). */
export function LineChart({ series, height = 160 }: { series: { name: string; points: { x: string; y: number }[]; color?: string }[]; height?: number }) {
  const xs = [...new Set(series.flatMap((s) => s.points.map((p) => p.x)))].sort();
  const max = Math.max(1, ...series.flatMap((s) => s.points.map((p) => p.y)));
  const W = 600, H = height, P = 28;
  const x = (v: string) => P + (xs.length <= 1 ? 0 : ((W - 2 * P) * xs.indexOf(v)) / (xs.length - 1));
  const y = (v: number) => H - P - ((H - 2 * P) * v) / max;
  const colors = ['#2a4fd7', '#fd8d21', '#1f6b4f', '#b42318', '#7c8bd9', '#c26a00'];
  if (!xs.length) return <Empty>No data for this period</Empty>;
  return (
    <figure style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Trend chart">
        <line x1={P} x2={W - P} y1={H - P} y2={H - P} stroke="currentColor" opacity={0.2} />
        <text x={P - 4} y={P} fontSize="10" textAnchor="end" fill="currentColor" opacity={0.6}>{max}</text>
        {series.map((s, i) => (
          <polyline key={s.name} fill="none" stroke={s.color ?? colors[i % colors.length]} strokeWidth={2.5}
            points={s.points.sort((a, b) => a.x.localeCompare(b.x)).map((p) => `${x(p.x)},${y(p.y)}`).join(' ')} />
        ))}
        {series.map((s, i) => s.points.map((p) => (
          <circle key={`${s.name}-${p.x}`} cx={x(p.x)} cy={y(p.y)} r={3.5} fill={s.color ?? colors[i % colors.length]}><title>{`${s.name} · ${p.x}: ${p.y}`}</title></circle>
        )))}
        {xs.filter((_, i) => i % Math.ceil(xs.length / 6) === 0).map((v) => (
          <text key={v} x={x(v)} y={H - 8} fontSize="10" textAnchor="middle" fill="currentColor" opacity={0.6}>{v.slice(5)}</text>
        ))}
      </svg>
      <figcaption className="row small">
        {series.map((s, i) => <span key={s.name} className="row" style={{ gap: 4 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: s.color ?? colors[i % colors.length] }} />{s.name}</span>)}
      </figcaption>
    </figure>
  );
}

export function SlaBadge({ sla, paused }: { sla?: { status: string; minutesRemaining: number | null }; paused?: boolean }) {
  if (!sla) return null;
  if (sla.status === 'paused' || paused) return <Badge>Paused</Badge>;
  if (sla.status === 'met') return <Badge tone="green">SLA met</Badge>;
  if (sla.status === 'breached') return <Badge tone="red">{sla.minutesRemaining != null ? `Breached · ${fmtMinutes(-Math.abs(sla.minutesRemaining))}` : 'Breached'}</Badge>;
  if (sla.status === 'running') return <Badge tone={sla.minutesRemaining != null && sla.minutesRemaining < 60 ? 'goldfill' : 'gold'}>SLA · {fmtMinutes(sla.minutesRemaining)}</Badge>;
  return null;
}

export const StateBadge = ({ state }: { state: string }) => {
  const tone = ({ resolved: 'green', closed: 'green', filtered: 'amber', merged: undefined, pending_customer: undefined, pending_third_party: undefined, received: 'gold', triaged: 'gold', reopened: 'red' } as Record<string, any>)[state] ?? 'navy';
  return <Badge tone={tone}>{label(state)}</Badge>;
};

export const UrgencyBadge = ({ u }: { u: string }) => (u === 'critical' ? <Badge tone="red">Critical</Badge> : u === 'high' ? <Badge tone="amber">High priority</Badge> : u === 'low' ? <Badge>Low</Badge> : null);

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="row between"><h2>{title}</h2><button className="btn link" onClick={onClose} aria-label="Close">✕</button></div>
        {children}
      </div>
    </div>
  );
}

/** Edit a JSON value in a textarea with validation. */
export function JsonEditor({ value, onChange, rows = 10 }: { value: unknown; onChange: (v: unknown) => void; rows?: number }) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [err, setErr] = useState<string | null>(null);
  return (
    <div>
      <textarea className="mono" rows={rows} value={text} onChange={(e) => {
        setText(e.target.value);
        try { onChange(JSON.parse(e.target.value)); setErr(null); } catch (x) { setErr((x as Error).message); }
      }} />
      {err && <div className="small" style={{ color: 'var(--red)' }}>{err}</div>}
    </div>
  );
}

export function Table<T extends Record<string, any>>({ rows, cols, empty = 'Nothing to show', onRow }: {
  rows: T[]; cols: { key: string; label: string; render?: (r: T) => ReactNode; num?: boolean }[]; empty?: string; onRow?: (r: T) => void;
}) {
  if (!rows.length) return <Empty>{empty}</Empty>;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr>{cols.map((c) => <th key={c.key} className={c.num ? 'num' : ''}>{c.label}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id ?? r.key ?? i} onClick={onRow ? () => onRow(r) : undefined} style={onRow ? { cursor: 'pointer' } : undefined}>
              {cols.map((c) => <td key={c.key} className={c.num ? 'num' : ''}>{c.render ? c.render(r) : r[c.key] ?? '—'}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Sinapse CRM logo with an optional context label (e.g. "Customer portal"). */
export const Brand = ({ sub, style }: { sub?: string; style?: CSSProperties }) => (
  <div className="brand" style={style}>
    <img className="logo" src="/logo.png" alt="Sinapse CRM" />
    {sub && <span className="sub">{sub}</span>}
  </div>
);
