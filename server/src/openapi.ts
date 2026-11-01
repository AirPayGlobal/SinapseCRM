/**
 * Published REST API description (IR-01, IR-01.2). Every function the agent console performs is a
 * documented call on this API; the console, the portal, the PWA and Sinapse Assist are all clients of it.
 */
type Op = [method: string, path: string, tag: string, summary: string, auth?: 'staff' | 'customer' | 'public' | 'scim'];

const OPS: Op[] = [
  ['post', '/auth/login', 'Authentication', 'Staff sign-in (local fallback when SSO is not used)', 'public'],
  ['get', '/auth/entra/start', 'Authentication', 'Begin Microsoft Entra ID single sign-on', 'public'],
  ['get', '/me', 'Me', 'Signed-in staff member, landing view and counters'],
  ['get', '/me/notifications', 'Me', 'In-app notifications'],
  ['get', '/me/tasks', 'Me', 'Tasks created by @mentions'],
  ['get', '/me/saved-searches', 'Me', 'Saved searches and shared working queues'],
  ['get', '/queries', 'Queries', 'List and filter queries (full-text and faceted; saved_search, mine, unassigned, sla, port, tier, …)'],
  ['post', '/queries', 'Queries', 'Log a query (quick capture; telephone / staff channel)'],
  ['post', '/queries/classify', 'Queries', 'Predict type, urgency and department; check for near-duplicates'],
  ['get', '/queries/export', 'Queries', 'Export a filtered list (format=csv|xlsx|pdf)'],
  ['get', '/queries/{id}', 'Queries', 'Case view: record, timeline across channels, port context, customer summary, transitions'],
  ['patch', '/queries/{id}', 'Queries', 'Update fields; confirm or override the AI classification'],
  ['post', '/queries/{id}/transition', 'Queries', 'Move the case through its versioned workflow'],
  ['post', '/queries/{id}/reply', 'Queries', 'Reply to the customer (then=resolve|pending_customer)'],
  ['post', '/queries/{id}/notes', 'Queries', 'Internal note (staff only; @mentions create tasks)'],
  ['post', '/queries/{id}/calls', 'Queries', 'Log a call with duration, direction and outcome'],
  ['post', '/queries/{id}/assign', 'Queries', 'Run the assignment engine, or reassign manually with a reason'],
  ['get', '/queries/{id}/candidates', 'Queries', 'Assignment engine reasoning for every agent'],
  ['post', '/queries/{id}/merge', 'Queries', 'Merge a near-duplicate into the original case'],
  ['post', '/queries/{id}/filter-review', 'Queries', 'Release or confirm a filtered item'],
  ['get', '/queries/{id}/assist', 'Queries', 'Agent assist: suggested reply from knowledge and resolved cases'],
  ['post', '/queries/{id}/attachments', 'Queries', 'Upload an attachment (virus-scanned, content-indexed)'],
  ['get', '/queries/{id}/history', 'Queries', 'Event-log history of the case'],
  ['get', '/attachments/{id}', 'Queries', 'Download an attachment (access inherited from the case)'],
  ['get', '/customers/search', 'Customers', 'Search companies, contacts, queries, correspondence and documents'],
  ['get', '/customers/companies', 'Customers', 'List companies'],
  ['post', '/customers/companies', 'Customers', 'Create a company (duplicate detection on registration number and name)'],
  ['get', '/customers/companies/{id}', 'Customers', 'Company profile with contacts, timeline and cases'],
  ['patch', '/customers/companies/{id}', 'Customers', 'Update a company (tier changes re-time open cases)'],
  ['post', '/customers/companies/{id}/contacts', 'Customers', 'Link a contact with a relationship role'],
  ['get', '/customers/contacts/{id}', 'Customers', 'Contact profile across companies'],
  ['get', '/customers/registrations', 'Customers', 'Registration approval queue with duplicate checks'],
  ['post', '/customers/registrations/{id}/decision', 'Customers', 'Approve, reject or merge a self-registration'],
  ['get', '/findings', 'Audit findings', 'Findings register'],
  ['post', '/findings', 'Audit findings', 'Record a finding (recurrence detection)'],
  ['post', '/findings/{id}/tasks', 'Audit findings', 'Add a remediation task'],
  ['patch', '/findings/tasks/{taskId}', 'Audit findings', 'Update a remediation task (progress rolls up)'],
  ['post', '/findings/{id}/transition', 'Audit findings', 'Accept, verify or close a finding'],
  ['get', '/kb/articles', 'Knowledge', 'Knowledge base library'],
  ['post', '/kb/articles/{id}/state', 'Knowledge', 'Draft → review → published (named approver)'],
  ['get', '/kb/gaps', 'Knowledge', 'Knowledge-gap report ranked by demand'],
  ['get', '/kb/governance', 'Knowledge', 'AI governance console data'],
  ['get', '/reports/dashboard', 'Reporting', 'Volumes, resolution, backlog and overdue (live)'],
  ['get', '/reports/performance', 'Reporting', 'Per-agent and per-department performance with trend'],
  ['get', '/reports/corridors', 'Reporting', 'Corridor analytics'],
  ['get', '/reports/deflection', 'Reporting', 'Sinapse Assist deflection analytics'],
  ['get', '/reports/adoption', 'Reporting', 'Weekly adoption measures'],
  ['post', '/reports/builder/run', 'Reporting', 'Run a user-defined report'],
  ['post', '/reports/builder/export', 'Reporting', 'Export a report as CSV, Excel or PDF'],
  ['get', '/port/vessel-calls', 'Port context', 'Vessel call board'],
  ['get', '/port/cargo', 'Port context', 'Container / bill of lading lookup'],
  ['post', '/port/notices', 'Port context', 'Send a proactive operational notice'],
  ['get', '/admin/workflows', 'Administration', 'Workflow definitions and versions'],
  ['post', '/admin/workflows/{id}/preview', 'Administration', 'Preview a draft against historical cases'],
  ['post', '/admin/workflows/{id}/publish', 'Administration', 'Publish a workflow version'],
  ['get', '/admin/availability', 'Administration', 'Agent availability board'],
  ['get', '/admin/alerts', 'Administration', 'Breach, pre-breach, escalation and threshold alerts'],
  ['get', '/admin/audit', 'Administration', 'Audit log explorer'],
  ['get', '/admin/audit/verify', 'Administration', 'Verify the tamper-evident hash chain'],
  ['get', '/admin/audit/export', 'Administration', 'Export audit log (csv or jsonl) to Namport monitoring'],
  ['get', '/admin/integrations', 'Administration', 'Integration health console'],
  ['post', '/admin/webhooks', 'Administration', 'Register an outbound webhook (HMAC-signed)'],
  ['post', '/admin/api-clients', 'Administration', 'Issue an API key for a system integration'],
  ['post', '/integrations/mail/inbound', 'Integration', 'Ingest a normalised email (idempotent on internetMessageId)'],
  ['post', '/portal/register', 'Customer portal', 'Self-registration of a company and its administrator', 'public'],
  ['post', '/portal/login', 'Customer portal', 'Customer sign-in (optional TOTP)', 'public'],
  ['post', '/portal/assist', 'Customer portal', 'Converse with Sinapse Assist (anonymous on the website, authenticated in the portal)', 'public'],
  ['post', '/portal/widget/query', 'Customer portal', 'Website widget query submission', 'public'],
  ['get', '/portal/queries', 'Customer portal', 'My company’s queries', 'customer'],
  ['post', '/portal/queries', 'Customer portal', 'Log a query', 'customer'],
  ['get', '/portal/queries/{id}', 'Customer portal', 'Case with its customer-visible timeline', 'customer'],
  ['post', '/portal/companies/{companyId}/colleagues', 'Customer portal', 'Company administrator adds a colleague', 'customer'],
];

export function openApiDocument() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [method, p, tag, summary, auth = 'staff'] of OPS) {
    const params = [...p.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
    (paths[p] ??= {})[method] = {
      tags: [tag], summary, parameters: params,
      security: auth === 'public' ? [] : [{ bearer: [] }, { apiKey: [] }],
      ...(method === 'post' || method === 'patch' ? { requestBody: { content: { 'application/json': { schema: { type: 'object' } } } } } : {}),
      responses: { 200: { description: 'OK' }, 400: { description: 'Invalid request' }, 401: { description: 'Not signed in' }, 403: { description: 'Not permitted' }, 404: { description: 'Not found' } },
    };
  }
  return {
    openapi: '3.0.3',
    info: {
      title: 'Sinapse CRM API', version: '1.0.0',
      description: 'The REST API behind every Sinapse CRM screen. Access control is evaluated at the data layer, so an API call is subject to exactly the same rules as a screen. Outbound events are delivered as HMAC-SHA256-signed webhooks (header X-Sinapse-Signature: sha256=hex(HMAC(secret, timestamp + "." + body))).',
    },
    servers: [{ url: '/api/v1' }],
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' }, apiKey: { type: 'apiKey', in: 'header', name: 'X-Api-Key' } } },
    paths,
  };
}
