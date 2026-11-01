import { config, isEntraConfigured } from '../config.js';
import { logIntegration } from './fabric.js';

/**
 * Microsoft Graph client (application permissions, client-credentials flow):
 *  - Mail.ReadWrite / Mail.Send on the shared customer-care mailbox: ingest with thread identity,
 *    send-as the customer-care address, capture messages sent from Outlook;
 *  - MailboxSettings.Read / Calendars.Read: out-of-office, leave and working pattern for the
 *    availability check used by the assignment engine (TA-01.3).
 */

let token: { value: string; exp: number } | null = null;

export const graphConfigured = () => isEntraConfigured() && Boolean(config.graph.mailbox);

async function accessToken(): Promise<string> {
  if (token && token.exp > Date.now() + 60_000) return token.value;
  const body = new URLSearchParams({
    client_id: config.entra.clientId, client_secret: config.entra.clientSecret,
    scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials',
  });
  const r = await fetch(`https://login.microsoftonline.com/${config.entra.tenantId}/oauth2/v2.0/token`, { method: 'POST', body });
  if (!r.ok) throw new Error(`token request failed: ${r.status}`);
  const j = (await r.json()) as { access_token: string; expires_in: number };
  token = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return token.value;
}

export async function graph<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const t = await accessToken();
  const r = await fetch(path.startsWith('http') ? path : `https://graph.microsoft.com/v1.0${path}`, {
    ...init, headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  if (!r.ok) throw new Error(`Graph ${init.method ?? 'GET'} ${path} → ${r.status} ${await r.text().catch(() => '')}`.slice(0, 500));
  return (r.status === 204 ? (undefined as T) : ((await r.json()) as T));
}

export interface GraphMessage {
  id: string;
  internetMessageId: string;
  conversationId: string;
  subject: string;
  bodyPreview: string;
  body: { contentType: string; content: string };
  from?: { emailAddress: { address: string; name: string } };
  receivedDateTime: string;
  hasAttachments: boolean;
}

export const htmlToText = (html: string) =>
  html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/\n{3,}/g, '\n\n').trim();

/** Strip quoted history so a reply threads as the new content only. */
export const stripQuoted = (text: string) => text.split(/\n(?:On .{5,80} wrote:|From: .+\nSent: |-----Original Message-----|_{10,})/)[0].trim();

/** Delta query over the shared mailbox inbox. Returns new messages and the next delta link. */
export async function fetchInboxDelta(deltaLink?: string | null) {
  const start = deltaLink ?? `/users/${encodeURIComponent(config.graph.mailbox)}/mailFolders/inbox/messages/delta?$select=id,internetMessageId,conversationId,subject,bodyPreview,body,from,receivedDateTime,hasAttachments`;
  const out: GraphMessage[] = [];
  let next: string | undefined = start;
  let delta: string | undefined;
  while (next) {
    const page: any = await graph(next, { headers: { Prefer: 'outlook.body-content-type="text"' } });
    out.push(...(page.value ?? []));
    next = page['@odata.nextLink'];
    delta = page['@odata.deltaLink'] ?? delta;
  }
  return { messages: out, deltaLink: delta ?? deltaLink ?? null };
}

export async function sendMail(to: string, subject: string, body: string) {
  await graph(`/users/${encodeURIComponent(config.graph.mailbox)}/sendMail`, {
    method: 'POST',
    body: JSON.stringify({ message: { subject, body: { contentType: 'Text', content: body }, toRecipients: [{ emailAddress: { address: to } }] }, saveToSentItems: true }),
  });
  await logIntegration(null, { connector: 'graph_mail', direction: 'outbound', operation: 'sendMail', status: 'success', payload: { to, subject } });
}

/** Out-of-office and calendar absences for one user, for the availability check. */
export async function availabilityFor(userEmail: string, from: Date, to: Date) {
  const settings: any = await graph(`/users/${encodeURIComponent(userEmail)}/mailboxSettings?$select=automaticRepliesSetting,workingHours`);
  const ar = settings.automaticRepliesSetting ?? {};
  const view: any = await graph(
    `/users/${encodeURIComponent(userEmail)}/calendarView?startDateTime=${from.toISOString()}&endDateTime=${to.toISOString()}&$select=id,subject,showAs,isAllDay,start,end&$top=200`,
    { headers: { Prefer: 'outlook.timezone="UTC"' } },
  );
  const absences = (view.value ?? []).filter((e: any) => e.showAs === 'oof').map((e: any) => ({
    id: e.id, starts_at: new Date(e.start.dateTime + 'Z'), ends_at: new Date(e.end.dateTime + 'Z'),
  }));
  const status = ar.status as 'disabled' | 'alwaysEnabled' | 'scheduled' | undefined;
  return {
    outOfOffice: status === 'alwaysEnabled' || status === 'scheduled',
    oooFrom: status === 'scheduled' && ar.scheduledStartDateTime ? new Date(ar.scheduledStartDateTime.dateTime + 'Z') : null,
    oooUntil: status === 'scheduled' && ar.scheduledEndDateTime ? new Date(ar.scheduledEndDateTime.dateTime + 'Z') : null,
    oooMessage: (ar.externalReplyMessage ?? ar.internalReplyMessage ?? '').slice(0, 500),
    workingHours: settings.workingHours ?? null,
    absences,
  };
}
