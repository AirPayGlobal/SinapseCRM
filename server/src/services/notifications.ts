import { many, one, type Tx } from '../db/pool.js';

export type Channel = 'email' | 'teams' | 'portal' | 'in_app';
export type Recipient =
  | { type: 'user'; id: string }
  | { type: 'contact'; id: string }
  | { type: 'address'; address: string }
  | { type: 'channel'; address: string };

/** {{a.b}} placeholder rendering. Missing values render as empty strings. */
export function render(tpl: string, vars: Record<string, any>): string {
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path: string) => {
    const v = path.split('.').reduce<any>((o, k) => (o == null ? undefined : o[k]), vars);
    return v == null ? '' : String(v);
  });
}

/**
 * WM-01.2 — event-driven notifications with per-event templates. The reference always appears in
 * the subject of customer-facing messages so replies thread back to the same case.
 */
export async function notify(
  tx: Tx,
  opts: { template: string; to: Recipient; vars: Record<string, any>; queryId?: string | null; channels?: Channel[] },
) {
  const tpl = await one<{ subject: string; body: string; channels: Channel[] }>(
    tx, 'SELECT subject, body, channels FROM notification_templates WHERE key = $1', [opts.template],
  );
  const subjectT = tpl?.subject ?? opts.template;
  const bodyT = tpl?.body ?? '';
  let channels = opts.channels ?? tpl?.channels ?? ['email'];

  // honour contact notification preferences
  if (opts.to.type === 'contact') {
    const c = await one<{ notification_preferences: Record<string, boolean> }>(
      tx, 'SELECT notification_preferences FROM contacts WHERE id = $1', [opts.to.id],
    );
    const prefs = c?.notification_preferences ?? {};
    channels = channels.filter((ch) => prefs[ch] !== false);
    if (!channels.length) channels = ['portal'];
  }

  let subject = render(subjectT, opts.vars);
  const ref = opts.vars.query?.reference ?? opts.vars.reference;
  if (ref && (opts.to.type === 'contact' || opts.to.type === 'address') && !subject.includes(ref)) {
    subject = `[${ref}] ${subject}`;
  }
  const body = render(bodyT, opts.vars);
  const ids: string[] = [];
  for (const channel of channels) {
    const row = await one<{ id: string }>(
      tx,
      `INSERT INTO notifications (channel, recipient_type, recipient_id, recipient_address, template_key, subject, body, query_id,
                                  status, sent_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
               CASE WHEN $1 IN ('portal','in_app') THEN 'sent' ELSE 'pending' END,
               CASE WHEN $1 IN ('portal','in_app') THEN now() END)
       RETURNING id`,
      [
        channel, opts.to.type,
        'id' in opts.to ? opts.to.id : null,
        'address' in opts.to ? opts.to.address : null,
        opts.template, subject, body, opts.queryId ?? null,
      ],
    );
    ids.push(row!.id);
  }
  return ids;
}

/** Resolve users holding a role, optionally within a port/department, for role-based targets. */
export async function usersWithRole(tx: Tx, role: string, port?: string | null, departmentId?: string | null) {
  return many<{ id: string; email: string; name: string }>(
    tx,
    `SELECT u.id, u.email, u.name FROM users u
      JOIN roles r ON r.key = u.role_key
     WHERE u.active AND u.role_key = $1
       AND ($2::text IS NULL OR u.port_code IS NULL OR u.port_code = $2 OR r.port_scope = 'all')
       AND ($3::uuid IS NULL OR u.department_id IS NULL OR u.department_id = $3 OR r.dept_scope = 'all')`,
    [role, port ?? null, departmentId ?? null],
  );
}

export async function raiseAlert(
  tx: Tx,
  a: { kind: string; message: string; severity?: 'info' | 'warning' | 'critical'; queryId?: string | null; findingId?: string | null;
       port?: string | null; departmentId?: string | null; targetRole?: string | null; dedupeKey?: string },
) {
  const r = await one<{ id: string }>(
    tx,
    `INSERT INTO alerts (kind, severity, message, query_id, finding_id, port_code, department_id, target_role, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [a.kind, a.severity ?? 'warning', a.message, a.queryId ?? null, a.findingId ?? null, a.port ?? null,
     a.departmentId ?? null, a.targetRole ?? null, a.dedupeKey ?? null],
  );
  return r?.id ?? null;
}
