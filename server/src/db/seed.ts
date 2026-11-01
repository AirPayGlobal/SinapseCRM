import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { namibianPublicHolidays } from '../lib/calendar.js';
import { systemCtx } from '../lib/context.js';
import { intake } from '../services/intake.js';
import { DEFAULT_WORKFLOW } from '../services/workflow.js';
import { migrate } from './migrate.js';
import { many, one, pool, withSystem, type Tx } from './pool.js';

/**
 * Reference configuration for Namport (ports, departments, roles, calendar with Namibian public
 * holidays, workflow, SLA policies, escalation matrices, templates, filter rules, corridors) and,
 * optionally, a demonstration dataset. Idempotent: safe to re-run.
 */

const ALL_PERMS = ['*'];
const ROLES: [string, string, string[], 'own' | 'all', 'own' | 'all', string[], string][] = [
  ['agent', 'Customer care agent', ['query.read', 'query.create', 'query.update', 'customer.read', 'customer.write', 'finding.read', 'kb.write', 'port.read', 'report.read'], 'own', 'all', ['company.sap_customer_id', 'company.service_agreement_ref'], 'queue'],
  ['supervisor', 'Supervisor', ['query.read', 'query.create', 'query.update', 'query.reassign', 'query.merge', 'query.review_filtered', 'customer.read', 'customer.write', 'registration.approve', 'finding.read', 'finding.write', 'kb.write', 'kb.publish', 'port.read', 'port.write', 'notice.send', 'report.read', 'report.build', 'admin.users'], 'own', 'all', [], 'team'],
  ['department_head', 'Department head', ['query.read', 'query.reassign', 'customer.read', 'finding.read', 'finding.write', 'kb.publish', 'port.read', 'report.read', 'report.build'], 'all', 'own', [], 'dashboard'],
  ['executive', 'Executive', ['query.read', 'customer.read', 'finding.read', 'port.read', 'report.read', 'report.build', 'report.executive'], 'all', 'all', ['contact.phone', 'contact.email'], 'executive'],
  ['ict', 'ICT administrator', ['admin.config', 'admin.users', 'admin.security', 'integration.manage', 'audit.read', 'report.read', 'query.read'], 'all', 'all', ['contact.phone'], 'integrations'],
  ['auditor', 'Internal auditor', ['query.read', 'customer.read', 'finding.read', 'finding.write', 'audit.read', 'report.read'], 'all', 'all', [], 'findings'],
  ['admin', 'System administrator', ALL_PERMS, 'all', 'all', [], 'dashboard'],
];

const DEPARTMENTS: [string, string][] = [
  ['CC', 'Customer Care'], ['MAR', 'Marine Services'], ['COM', 'Commercial'], ['FIN', 'Finance & Billing'],
  ['OPS', 'Terminal Operations'], ['SEC', 'Port Security & Access'], ['LEG', 'Legal & Compliance'],
];

const QUERY_TYPES: { key: string; name: string; dept: string; queue: string; weight: number; skill?: string; urgency?: string; examples: string[] }[] = [
  { key: 'berthing', name: 'Berthing and vessel scheduling', dept: 'MAR', queue: 'marine', weight: 2, skill: 'marine', examples: ['berth allocation changed for our vessel', 'berthing window for voyage', 'vessel arrival delayed at anchorage', 'quay assignment dispute', 'pilotage and towage booking', 'ETA update for vessel call'] },
  { key: 'container_release', name: 'Container release and delivery', dept: 'OPS', queue: 'operations', weight: 1.5, skill: 'terminal', examples: ['container release delayed at terminal', 'cannot collect container', 'truck turned away at gate', 'container not yet discharged', 'release order not processed', 'delivery appointment for containers'] },
  { key: 'reefer', name: 'Reefer and special cargo', dept: 'OPS', queue: 'operations', weight: 1.5, skill: 'terminal', examples: ['reefer plug availability', 'refrigerated container temperature alarm', 'dangerous goods declaration', 'out of gauge cargo handling', 'reefer monitoring report'] },
  { key: 'billing', name: 'Invoice and billing', dept: 'FIN', queue: 'finance', weight: 1, skill: 'billing', examples: ['invoice appears incorrect', 'cargo dues charged twice', 'statement of account request', 'credit note for overcharge', 'payment not allocated to account', 'storage charges on invoice'] },
  { key: 'tariff', name: 'Tariff and commercial enquiry', dept: 'COM', queue: 'commercial', weight: 1, skill: 'commercial', examples: ['tariff clarification', 'request for rates', 'quotation for transhipment', 'commercial agreement renewal', 'volume discount request', 'tariff book question'] },
  { key: 'access_permit', name: 'Port access and permits', dept: 'SEC', queue: 'security', weight: 1, skill: 'security', examples: ['access permit for driver', 'port entry permit application', 'visitor access to harbour', 'permit renewal for vehicles', 'security clearance for contractor'] },
  { key: 'customs_hold', name: 'Customs and documentation', dept: 'OPS', queue: 'operations', weight: 1.5, skill: 'terminal', examples: ['customs hold on import containers', 'bill of lading amendment', 'manifest correction', 'documentation for transit cargo', 'release from customs inspection'] },
  { key: 'damage_claim', name: 'Cargo damage and claims', dept: 'LEG', queue: 'commercial', weight: 3, skill: 'claims', examples: ['damage to cargo during discharge', 'claim for damaged container', 'missing cargo report', 'insurance claim against port', 'equipment damaged vehicle'] },
  { key: 'vessel_operations', name: 'Vessel operations', dept: 'MAR', queue: 'marine', weight: 2, skill: 'marine', examples: ['bunkering request', 'crew change at port', 'fresh water supply to vessel', 'waste removal from vessel', 'ship repair berth'] },
  { key: 'account_update', name: 'Account and profile update', dept: 'CC', queue: 'customer-care', weight: 0.5, examples: ['update company contact details', 'change of address', 'add user to our account', 'portal access problem', 'reset my password'] },
  { key: 'complaint', name: 'Service complaint', dept: 'CC', queue: 'customer-care', weight: 2, examples: ['complaint about service', 'unacceptable delay and poor communication', 'nobody responded to our email', 'escalate our complaint', 'poor treatment at gate'] },
  { key: 'service_recovery', name: 'Service recovery follow-up', dept: 'CC', queue: 'customer-care', weight: 1, urgency: 'high', examples: ['follow up on low satisfaction score', 'customer unhappy with resolution'] },
  { key: 'general', name: 'General enquiry', dept: 'CC', queue: 'customer-care', weight: 0.5, examples: ['general information request', 'operating hours of the port', 'contact details for department', 'question about services offered'] },
];

// Customer Care agents work every queue; specialist queues select by skill rather than department.
const QUEUES: [string, string, string | null, string, string[]][] = [
  ['customer-care', 'Customer Care', 'CC', 'least_loaded', []],
  ['marine', 'Marine Services', null, 'skills', []],
  ['operations', 'Terminal Operations', null, 'skills', []],
  ['finance', 'Finance & Billing', null, 'skills', []],
  ['commercial', 'Commercial', null, 'skills', []],
  ['security', 'Port Security & Access', null, 'round_robin', ['security']],
];

const TEMPLATES: [string, string, string, string[]][] = [
  ['query_created', 'We have received your query: {{query.subject}}', 'Dear {{contact.name}},\n\nThank you for contacting the Namibian Ports Authority. Your query has been logged with reference {{reference}}.\n\nWe aim to respond by {{query.due}}. You can follow progress at any time in the customer portal: {{portal_url}}\n\nPlease quote {{reference}} in any correspondence.\n\nNamport Customer Care', ['email', 'portal']],
  ['query_assigned', 'Assigned to you: {{reference}} — {{query.subject}}', '{{reference}} ({{query.type}}) from {{company.name}} has been assigned to you. First response due {{query.due}}.', ['in_app', 'email']],
  ['query_assigned_customer', 'Your query has been assigned', 'Dear {{contact.name}},\n\nYour query {{reference}} is now being handled by {{agent.name}}.\n\nNamport Customer Care', ['portal']],
  ['agent_reply', 'Re: {{query.subject}}', '{{message}}\n\n—\nReference {{reference}}. Reply to this email to add to your query, or view it in the portal: {{portal_url}}', ['email', 'portal']],
  ['awaiting_customer', 'We need information from you', 'Dear {{contact.name}},\n\nTo progress {{reference}} we need further information from you. Please reply to this email or respond in the portal.\n\nNamport Customer Care', ['email', 'portal']],
  ['query_resolved', 'Your query has been resolved', 'Dear {{contact.name}},\n\n{{reference}} — "{{query.subject}}" — has been resolved.\n\nOutcome: {{query.resolution_note}}\n\nIf you disagree with the outcome you can reopen it from the portal within the review window.\n\nNamport Customer Care', ['email', 'portal']],
  ['query_merged', 'Your query has been combined with an existing case', 'Dear {{contact.name}},\n\nYour query {{reference}} concerns the same matter as {{parent.reference}}, so we have combined them. Your message is preserved and will be answered on {{parent.reference}}.\n\nNamport Customer Care', ['email', 'portal']],
  ['satisfaction_request', 'How did we do?', 'Dear {{contact.name}},\n\nPlease rate how we handled {{reference}}: {{survey_url}}\n\nNamport Customer Care', ['email', 'portal']],
  ['customer_replied', 'Customer replied: {{reference}}', 'The customer has added to {{reference}}.', ['in_app']],
  ['mention', '{{author}} mentioned you on {{reference}}', '{{note}}', ['in_app']],
  ['pre_breach', 'Pre-breach warning: {{reference}}', '{{reference}} will miss its {{target}} target in {{minutes}} business minutes.', ['in_app', 'teams']],
  ['breach', 'Target missed: {{reference}}', '{{reference}} has missed its {{target}} target.', ['in_app', 'teams']],
  ['escalation', 'Escalation level {{level}}: {{reference}}', '{{reference}} ({{company.name}}) has been escalated to level {{level}} ({{role}}) under "{{matrix}}". Assigned to {{agent.name}}.', ['in_app', 'teams']],
  ['customer_escalation_notice', 'Update on your escalated query', 'Dear {{contact.name}},\n\n{{reference}} has been escalated to senior management at Namport. You will be contacted shortly.\n\nNamport Customer Care', ['email']],
  ['unassignable_alert', 'Unassigned: {{reference}}', '{{reference}} is waiting in {{queue}}: no eligible agent is available.', ['in_app', 'teams']],
  ['threshold_alert', 'Threshold alert', '{{message}}', ['in_app', 'teams', 'email']],
  ['verify_email', 'Verify your email address', 'Dear {{contact.name}},\n\nPlease confirm your email address to complete your Namport customer portal registration: {{link}}\n\nNamport Customer Care', ['email']],
  ['registration_pending', 'Registration awaiting approval: {{company.name}}', '{{company.name}} has registered on the customer portal and is awaiting approval.', ['in_app']],
  ['registration_approved', 'Your Namport portal registration is approved', 'Your registration for {{company.name}} has been approved. Sign in at {{portal_url}}', ['email']],
  ['registration_rejected', 'Your Namport portal registration', 'We could not approve the registration for {{company.name}}. {{reason}}', ['email']],
  ['colleague_invited', 'You have been added to {{company.name}} on the Namport portal', 'Dear {{contact.name}},\n\n{{inviter}} has added you to {{company.name}} on the Namport customer portal. Activate your access: {{link}}', ['email']],
  ['password_reset', 'Reset your Namport portal password', 'Dear {{contact.name}},\n\nUse this link to choose a new password: {{link}}', ['email']],
  ['finding_assigned', 'Audit finding assigned: {{finding.reference}}', 'You are the responsible owner of {{finding.reference}} — {{finding.title}}. Please review and accept it.', ['in_app', 'email']],
  ['remediation_task_assigned', 'Remediation task: {{task.title}}', 'You have a remediation task on {{finding.reference}}: {{task.title}}, due {{task.due_date}}.', ['in_app', 'email']],
  ['remediation_overdue', 'Overdue remediation task: {{finding.reference}}', 'The remediation task "{{task.title}}" on {{finding.reference}} is overdue.', ['in_app']],
  ['operational_notice', 'Operational notice: {{notice.title}}', '{{notice.body}}\n\nNamibian Ports Authority', ['email', 'portal']],
  ['scheduled_report', 'Scheduled report: {{report.name}}', '{{summary}}', ['email']],
];

export async function seedReference(tx: Tx) {
  await tx.query(`INSERT INTO ports (code, name) VALUES ('WB', 'Port of Walvis Bay'), ('LZ', 'Port of Lüderitz') ON CONFLICT DO NOTHING`);
  for (const [code, name] of DEPARTMENTS) await tx.query(`INSERT INTO departments (code, name) VALUES ($1,$2) ON CONFLICT (code) DO NOTHING`, [code, name]);
  for (const [key, name, perms, ps, ds, masks, landing] of ROLES) {
    await tx.query(`INSERT INTO roles (key, name, permissions, port_scope, dept_scope, field_masks, landing_view) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (key) DO NOTHING`, [key, name, perms, ps, ds, masks, landing]);
  }
  const dept = Object.fromEntries((await many(tx, 'SELECT id, code FROM departments')).map((d) => [d.code, d.id]));

  // Calendar: Mon–Thu 07:30–16:30, Fri 07:30–13:00 (CAT, UTC+2), Namibian public holidays 2025–2030
  const hours = { '0': [], '1': [['07:30', '16:30']], '2': [['07:30', '16:30']], '3': [['07:30', '16:30']], '4': [['07:30', '16:30']], '5': [['07:30', '13:00']], '6': [] };
  const cal = (await one(tx, `INSERT INTO calendars (name, utc_offset_minutes, business_hours) VALUES ('Namport standard', 120, $1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [JSON.stringify(hours)]))!;
  const cal24 = (await one(tx, `INSERT INTO calendars (name, utc_offset_minutes, business_hours) VALUES ('24/7 marine operations', 120, $1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [JSON.stringify(Object.fromEntries(['0', '1', '2', '3', '4', '5', '6'].map((d) => [d, [['00:00', '24:00']]])))]))!;
  for (let y = 2025; y <= 2030; y++) {
    for (const h of namibianPublicHolidays(y)) await tx.query(`INSERT INTO calendar_holidays (calendar_id, day, name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [cal.id, h.day, h.name]);
  }

  // SLA policies (business minutes): Top 10 customers carry shorter targets
  const std = (await one(tx,
    `INSERT INTO sla_policies (name, calendar_id, first_response_minutes, resolution_minutes, tier_overrides, pre_breach_percent)
     VALUES ('Standard', $1, 240, 1440, $2, 80) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [cal.id, JSON.stringify({ top10: { first_response_minutes: 60, resolution_minutes: 480 }, priority: { first_response_minutes: 120, resolution_minutes: 960 } })]))!;
  const marine = (await one(tx,
    `INSERT INTO sla_policies (name, calendar_id, first_response_minutes, resolution_minutes, tier_overrides, pre_breach_percent)
     VALUES ('Marine operations (24/7)', $1, 60, 480, $2, 75) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [cal24.id, JSON.stringify({ top10: { first_response_minutes: 30, resolution_minutes: 240 } })]))!;

  // Workflows: default lifecycle, and a marine variant on the 24/7 calendar
  for (const [key, sla] of [['default', std.id], ['marine', marine.id]] as const) {
    const exists = await one(tx, `SELECT id FROM workflow_definitions WHERE workflow_key = $1`, [key]);
    if (!exists) {
      await tx.query(`INSERT INTO workflow_definitions (workflow_key, version, status, definition, sla_policy_id, published_at) VALUES ($1, 1, 'published', $2, $3, now())`,
        [key, JSON.stringify(DEFAULT_WORKFLOW), sla]);
    }
  }

  for (const [key, name, d, strategy, skills] of QUEUES) {
    await tx.query(`INSERT INTO queues (key, name, department_id, strategy, required_skills) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (key) DO NOTHING`, [key, name, d ? dept[d] : null, strategy, skills]);
  }
  for (const t of QUERY_TYPES) {
    await tx.query(
      `INSERT INTO query_types (key, name, department_id, workflow_key, queue_key, default_urgency, weight, skill, training_examples)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (key) DO NOTHING`,
      [t.key, t.name, dept[t.dept], ['berthing', 'vessel_operations'].includes(t.key) ? 'marine' : 'default', t.queue, t.urgency ?? 'normal', t.weight, t.skill ?? null, t.examples]);
  }

  // Escalation matrices: standard path and the Top 10 path (shorter timers, higher targets)
  const matrices: [string, string | null, unknown[]][] = [
    ['Standard escalation', null, [
      { level: 1, after_minutes: 0, target_role: 'supervisor', template: 'escalation', channels: ['in_app', 'teams'] },
      { level: 2, after_minutes: 240, target_role: 'department_head', template: 'escalation', channels: ['in_app', 'teams', 'email'] },
      { level: 3, after_minutes: 1440, target_role: 'executive', template: 'escalation', channels: ['in_app', 'email'] }]],
    ['Top 10 customer escalation', 'top10', [
      { level: 1, after_minutes: 0, target_role: 'supervisor', template: 'escalation', channels: ['in_app', 'teams'] },
      { level: 2, after_minutes: 60, target_role: 'department_head', template: 'escalation', channels: ['in_app', 'teams', 'email'] },
      { level: 3, after_minutes: 240, target_role: 'executive', template: 'escalation', channels: ['in_app', 'teams', 'email'] }]],
  ];
  for (const [name, tier, levels] of matrices) {
    if (!(await one(tx, 'SELECT 1 FROM escalation_matrices WHERE name = $1', [name]))) {
      await tx.query('INSERT INTO escalation_matrices (name, account_tier, levels) VALUES ($1,$2,$3)', [name, tier, JSON.stringify(levels)]);
    }
  }

  for (const [key, subject, body, channels] of TEMPLATES) {
    await tx.query(`INSERT INTO notification_templates (key, subject, body, channels) VALUES ($1,$2,$3,$4) ON CONFLICT (key) DO NOTHING`, [key, subject, body, channels]);
  }

  // QMC-05: the five terms the Terms of Reference names
  if (!(await one(tx, 'SELECT 1 FROM filter_rules LIMIT 1'))) {
    for (const [p, c] of [['CV', 'recruitment'], ['job application', 'recruitment'], ['vacancy', 'recruitment'], ['vacancies', 'recruitment'], ['donations', 'donation'], ['donation', 'donation'], ['apprenticeship', 'recruitment']]) {
      await tx.query('INSERT INTO filter_rules (pattern, category) VALUES ($1,$2)', [p, c]);
    }
  }

  for (const [code, name, countries] of [
    ['TKC', 'Trans-Kalahari', ['Namibia', 'Botswana', 'South Africa']],
    ['TCC', 'Trans-Cunene', ['Namibia', 'Angola']],
    ['WBNL', 'Walvis Bay–Ndola–Lubumbashi', ['Namibia', 'Zambia', 'DR Congo']],
    ['TOC', 'Trans-Oranje', ['Namibia', 'South Africa']],
    ['CST', 'Coastal and domestic', ['Namibia']],
    ['TSH', 'Transhipment', []],
  ] as const) {
    await tx.query('INSERT INTO corridors (code, name, countries) VALUES ($1,$2,$3) ON CONFLICT (code) DO NOTHING', [code, name, countries]);
  }

  for (const [key, name] of [['entra', 'Microsoft Entra ID (SSO)'], ['scim', 'Entra ID SCIM provisioning'], ['graph_mail', 'Outlook shared mailbox (Graph)'], ['graph_calendar', 'Exchange calendars (Graph)'],
    ['teams', 'Microsoft Teams notifications'], ['sap', 'SAP S/4HANA (OData)'], ['website', 'namport.com.na widget and Assist'], ['webhooks', 'Outbound webhooks']]) {
    await tx.query(`INSERT INTO integration_connectors (key, name) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [key, name]);
  }
  for (const [k, n] of [['internal_audit', 'Internal audit'], ['external_audit', 'External audit'], ['regulatory', 'Regulatory inspection'], ['customer_complaint', 'Customer complaint review'], ['iso', 'ISO / quality audit']]) {
    await tx.query('INSERT INTO finding_types (key, name) VALUES ($1,$2) ON CONFLICT DO NOTHING', [k, n]);
  }
  for (const [e, d] of [['assist_sessions', 365], ['notifications', 365], ['integration_log', 180], ['webhook_deliveries', 90]] as const) {
    await tx.query('INSERT INTO retention_policies (entity, keep_days) VALUES ($1,$2) ON CONFLICT DO NOTHING', [e, d]);
  }
  if (!(await one(tx, `SELECT 1 FROM custom_field_definitions LIMIT 1`))) {
    await tx.query(`INSERT INTO custom_field_definitions (entity, key, label, field_type, options, help_text, query_types, customer_visible, sort_order) VALUES
      ('query', 'voyage_no', 'Voyage number', 'text', '{}', 'As shown on the vessel schedule', '{berthing,vessel_operations,container_release}', true, 1),
      ('query', 'invoice_no', 'Invoice number', 'text', '{}', 'From the Namport invoice', '{billing}', true, 2),
      ('query', 'claim_value_nad', 'Claim value (NAD)', 'number', '{}', 'Estimated value of the claim', '{damage_claim}', true, 3),
      ('query', 'root_cause', 'Root cause', 'select', '{Documentation,Equipment,Scheduling,Communication,Third party,Customer}', 'Recorded on resolution', '{}', false, 10),
      ('company', 'bpn', 'Business partner number', 'text', '{}', 'Customs business partner number', '{}', false, 1)`);
  }
}

// ---------------------------------------------------------------------------
// Demonstration dataset (fictitious companies, vessels and people)
// ---------------------------------------------------------------------------

export async function seedDemo(tx: Tx) {
  if (await one(tx, 'SELECT 1 FROM companies LIMIT 1')) return false;
  const dept = Object.fromEntries((await many(tx, 'SELECT id, code FROM departments')).map((d) => [d.code, d.id]));
  const pw = await bcrypt.hash('Sinapse!2026', 10);
  const users: [string, string, string, string | null, string | null, string[], number][] = [
    ['admin@namport.com.na', 'System Administrator', 'admin', null, null, [], 20],
    ['t.shikongo@namport.com.na', 'Tuyeni Shikongo', 'agent', 'WB', 'CC', ['marine', 'terminal'], 20],
    ['j.nambahu@namport.com.na', 'Johannes Nambahu', 'agent', 'WB', 'CC', ['billing', 'commercial'], 20],
    ['m.van.wyk@namport.com.na', 'Marike van Wyk', 'agent', 'WB', 'CC', ['terminal', 'security'], 16],
    ['p.amupolo@namport.com.na', 'Petrus Amupolo', 'agent', 'WB', 'CC', ['marine', 'claims'], 20],
    ['s.goagoses@namport.com.na', 'Selma Goagoses', 'agent', 'LZ', 'CC', ['marine', 'terminal', 'billing', 'security'], 20],
    ['k.kaapanda@namport.com.na', 'Kristofina Kaapanda', 'supervisor', 'WB', 'CC', ['marine', 'terminal', 'billing', 'commercial', 'claims', 'security'], 10],
    ['d.isaacs@namport.com.na', 'David Isaacs', 'supervisor', 'LZ', 'CC', ['marine', 'terminal', 'billing'], 10],
    ['h.mbango@namport.com.na', 'Hilma Mbango', 'department_head', null, 'CC', [], 5],
    ['e.angula@namport.com.na', 'Elias Angula', 'executive', null, null, [], 5],
    ['ict@namport.com.na', 'Namport ICT', 'ict', null, null, [], 5],
    ['auditor@namport.com.na', 'Internal Audit', 'auditor', null, null, [], 5],
  ];
  const uid: Record<string, string> = {};
  for (const [email, name, role, port, d, skills, cap] of users) {
    const u = (await one(tx, `INSERT INTO users (email, name, role_key, port_code, department_id, skills, capacity, password_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT ((lower(email))) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [email, name, role, port, d ? dept[d] : null, skills, cap, pw]))!;
    uid[email] = u.id;
    await tx.query(`INSERT INTO agent_availability (user_id, working_pattern) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [u.id, JSON.stringify(Object.fromEntries(['0', '1', '2', '3', '4', '5', '6'].map((x) => [x, [['00:00', '24:00']]])))]);
  }
  // One agent is away on leave, read as if from Outlook
  await tx.query(`UPDATE agent_availability SET out_of_office = true, ooo_from = now() - interval '1 day', ooo_until = now() + interval '4 days',
                  ooo_message = 'On annual leave', source = 'graph', synced_at = now() WHERE user_id = $1`, [uid['p.amupolo@namport.com.na']]);

  const corr = Object.fromEntries((await many(tx, 'SELECT id, code FROM corridors')).map((c) => [c.code, c.id]));
  const companies: [string, string, string, string, string[], string | null, string | null][] = [
    ['CC/2011/0442', 'Namib Clearing (Pty) Ltd', 'Clearing agent', 'top10', ['WB', 'LZ'], 'SA-2022-017', '1000442'],
    ['CC/2005/1187', 'Kalahari Freight Forwarders CC', 'Freight forwarder', 'top10', ['WB'], 'SA-2021-004', '1001187'],
    ['2009/0331', 'Atlantic Shipping Lines Namibia (Pty) Ltd', 'Shipping line', 'top10', ['WB', 'LZ'], 'SA-2023-002', '1000331'],
    ['2014/0912', 'Zambezi Copper Logistics (Pty) Ltd', 'Cargo owner', 'priority', ['WB'], null, '1000912'],
    ['CC/2018/2210', 'Lüderitz Logistics CC', 'Transport operator', 'standard', ['LZ'], null, null],
    ['2016/0457', 'Seaflower Pelagic (Pty) Ltd', 'Fishing company', 'priority', ['WB'], null, '1000457'],
    ['2020/1145', 'Cunene Agri Exports (Pty) Ltd', 'Cargo owner', 'standard', ['WB'], null, null],
  ];
  const cid: Record<string, string> = {};
  for (const [reg, name, type, tier, ports, sla, sap] of companies) {
    const c = (await one(tx, `INSERT INTO companies (registration_no, name, company_type, account_tier, ports_served, service_agreement_ref, sap_customer_id, status, approved_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'active',now()) RETURNING id`, [reg, name, type, tier, ports, sla, sap]))!;
    cid[name] = c.id;
  }
  const contacts: [string, string, string, [string, string, boolean][]][] = [
    ['hileni@namibclearing.com.na', 'Hileni Amutenya', '+264 81 234 5678', [['Namib Clearing (Pty) Ltd', 'primary', true], ['Zambezi Copper Logistics (Pty) Ltd', 'operations', false]]],
    ['ops@namibclearing.com.na', 'Gerhard Visser', '+264 81 555 0101', [['Namib Clearing (Pty) Ltd', 'operations', false]]],
    ['finance@namibclearing.com.na', 'Martha Iipinge', '+264 81 555 0102', [['Namib Clearing (Pty) Ltd', 'finance', false]]],
    ['ceo@namibclearing.com.na', 'Frans Kambonde', '+264 81 555 0103', [['Namib Clearing (Pty) Ltd', 'escalation', false]]],
    ['bookings@kalaharifreight.com', 'Lesego Molefe', '+267 71 234 567', [['Kalahari Freight Forwarders CC', 'primary', true]]],
    ['ops@atlanticshipping.na', 'Rui Fernandes', '+264 64 200 300', [['Atlantic Shipping Lines Namibia (Pty) Ltd', 'primary', true]]],
    ['logistics@zambezicopper.co.zm', 'Chanda Mwila', '+260 97 123 4567', [['Zambezi Copper Logistics (Pty) Ltd', 'primary', true]]],
    ['admin@luderitzlogistics.na', 'Anna Beukes', '+264 63 202 111', [['Lüderitz Logistics CC', 'primary', true]]],
    ['shipping@seaflower.com.na', 'Tomas Haufiku', '+264 64 219 900', [['Seaflower Pelagic (Pty) Ltd', 'primary', true]]],
    ['exports@cuneneagri.com.na', 'Ndapewa Shilongo', '+264 65 220 100', [['Cunene Agri Exports (Pty) Ltd', 'primary', true]]],
  ];
  const ctid: Record<string, string> = {};
  for (const [email, name, phone, links] of contacts) {
    const c = (await one(tx, `INSERT INTO contacts (email, name, phone, password_hash, email_verified, status) VALUES ($1,$2,$3,$4,true,'active') RETURNING id`, [email, name, phone, pw]))!;
    ctid[email] = c.id;
    for (const [co, role, admin] of links) await tx.query(`INSERT INTO company_contacts (company_id, contact_id, role, is_portal_admin) VALUES ($1,$2,$3,$4)`, [cid[co], c.id, role, admin]);
  }
  // One self-registration awaiting approval
  const pend = (await one(tx, `INSERT INTO companies (registration_no, name, company_type, ports_served, status, created_by_channel) VALUES ('2025/0789', 'Swakop Reefer Services (Pty) Ltd', 'Cold storage', '{WB}', 'pending', 'portal') RETURNING id`))!;
  const pc = (await one(tx, `INSERT INTO contacts (email, name, password_hash, email_verified, status) VALUES ('info@swakopreefer.na', 'Ingrid Hoffmann', $1, true, 'active') RETURNING id`, [pw]))!;
  await tx.query(`INSERT INTO company_contacts (company_id, contact_id, role, is_portal_admin) VALUES ($1,$2,'primary',true)`, [pend.id, pc.id]);

  const day = (d: number, h = 8) => new Date(Date.now() + d * 86_400_000 + h * 3_600_000);
  const vessels: [string, string, string, string, string | null, number, number, string, string][] = [
    ['MSC Nuria', '2614W', 'WB', 'Quay 10', 'Quay 7', 0, 1, 'berthed', 'TKC'],
    ['Maersk Lüderitz', '245S', 'LZ', 'Berth 2', null, 1, 2, 'expected', 'CST'],
    ['CMA CGM Etosha', 'FE118N', 'WB', 'Quay 4', null, 2, 3, 'expected', 'WBNL'],
    ['Ocean Kudu', '0931E', 'WB', 'Quay 8', null, -1, 0, 'working', 'TCC'],
    ['Safmarine Sossusvlei', '612A', 'WB', 'Anchorage', null, 3, 4, 'at_anchor', 'TSH'],
  ];
  const vid: Record<string, string> = {};
  for (const [n, voy, port, berth, prev, a, b, st, co] of vessels) {
    const v = (await one(tx, `INSERT INTO vessel_calls (vessel_name, voyage_no, port_code, berth, previous_berth, window_from, window_to, status, corridor_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [n, voy, port, berth, prev, day(a, 14), day(b, 22), st, corr[co]]))!;
    vid[n] = v.id;
  }
  const cargo: [string, string, string, string, number, boolean, string][] = [
    ['MSCU4821937', 'MSC Nuria', 'Namib Clearing (Pty) Ltd', 'Copper cathodes', 1, false, 'WBNL'],
    ['MSCU4821942', 'MSC Nuria', 'Namib Clearing (Pty) Ltd', 'Frozen fish', 1, true, 'TKC'],
    ['CMAU7730015', 'CMA CGM Etosha', 'Zambezi Copper Logistics (Pty) Ltd', 'Copper concentrate', 2, false, 'WBNL'],
    ['OCKU1100234', 'Ocean Kudu', 'Cunene Agri Exports (Pty) Ltd', 'Table grapes', 2, true, 'TCC'],
    ['TGHU5519087', 'Safmarine Sossusvlei', 'Kalahari Freight Forwarders CC', 'Machinery', 2, false, 'TKC'],
  ];
  for (const [cn, v, co, type, teu, reefer, c] of cargo) {
    await tx.query(`INSERT INTO cargo_references (container_no, bl_no, vessel_call_id, company_id, cargo_type, teu, reefer, corridor_id, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'on vessel')`,
      [cn, `BL${cn.slice(4)}`, vid[v], cid[co], type, teu, reefer, corr[c]]);
  }

  const articles: [string, string, string, string][] = [
    ['How to track a query', 'Customer care', 'public', 'Every query logged with Namport receives a reference number such as NAM-WB-2026-000123. Sign in to the customer portal and open "My queries" to see the status and the full history of each query. You can also ask Sinapse Assist for the status by quoting the reference number.'],
    ['Port operating hours', 'General', 'public', 'The Port of Walvis Bay and the Port of Lüderitz operate 24 hours a day, 7 days a week for vessel and terminal operations. Customer Care offices are open Monday to Thursday from 07:30 to 16:30 and on Friday from 07:30 to 13:00, excluding Namibian public holidays.'],
    ['Applying for a port access permit', 'Port access', 'public', 'Drivers and vehicles entering the port require a valid port access permit. Applications are submitted through the customer portal with a certified copy of the driver\'s identity document and the vehicle registration. Permits are normally processed within two working days. Temporary visitor access is arranged at the main gate with a valid identity document.'],
    ['Container release process', 'Terminal operations', 'public', 'A container is released for collection once customs clearance has been granted and all port charges have been settled. The clearing agent submits the release order through the terminal system, after which a delivery appointment can be booked. Trucks must arrive within the booked appointment window and present the release reference at the gate.'],
    ['Berth change procedure', 'Marine services', 'public', 'Berth allocations may change because of vessel delays, weather or operational priorities. When a berth changes, the vessel call record is updated and affected customers are notified through the portal and by email. The berth window shown on the vessel call board is the current confirmed allocation.'],
    ['Reefer plug availability', 'Terminal operations', 'public', 'Reefer plugs are allocated on arrival according to availability and the booking made by the shipping line. Customers can request reefer monitoring reports through the customer portal. Temperature alarms are reported to the shipping line and the cargo owner immediately.'],
    ['Updating your company details', 'Customer care', 'public', 'Your company administrator can update company details, add colleagues and remove people who have left, directly in the customer portal under "My company". Namport does not need to be contacted to add or remove users.'],
    ['Disputing an invoice', 'Finance', 'public', 'If an invoice appears incorrect, log a billing query in the customer portal and quote the invoice number. Attach any supporting documents. The Finance team reviews the invoice and, where an error is confirmed, issues a credit note.'],
  ];
  for (const [title, cat, aud, body] of articles) {
    await tx.query(`INSERT INTO knowledge_articles (title, category, audience_scope, body, state, approved_by, published_at, author_id) VALUES ($1,$2,$3,$4,'published',$5,now(),$6)`,
      [title, cat, aud, body, uid['k.kaapanda@namport.com.na'], uid['t.shikongo@namport.com.na']]);
  }

  // Findings
  const f = (await one(tx, `INSERT INTO findings (reference, title, description, finding_type_key, source, severity, owner_id, department_id, port_code, due_date, state, created_by)
    VALUES ('FND-2026-0001', 'Customer complaints not acknowledged within 24 hours', 'Sample testing found 14% of emailed complaints were acknowledged after 24 hours.', 'internal_audit', 'Internal audit Q3', 'high', $1, $2, 'WB', current_date + 30, 'in_remediation', $3) RETURNING id`,
    [uid['k.kaapanda@namport.com.na'], dept.CC, uid['auditor@namport.com.na']]))!;
  await tx.query(`INSERT INTO remediation_tasks (finding_id, title, owner_id, due_date, state) VALUES ($1,'Configure automatic acknowledgement on all channels',$2,current_date + 7,'done'),
                  ($1,'Train agents on the complaint lifecycle',$3,current_date - 2,'in_progress')`, [f.id, uid['ict@namport.com.na'], uid['k.kaapanda@namport.com.na']]);
  await tx.query(`INSERT INTO reference_sequences (port_code, year, last_value) VALUES ('FND', extract(year FROM now())::int, 1) ON CONFLICT DO NOTHING`);
  return true;
}

/** Push a realistic set of queries through the real intake pipeline. */
export async function seedDemoQueries() {
  const ctx = systemCtx('demo-seed');
  const sample: { from: string; subject: string; body: string; channel: 'email' | 'portal' | 'phone' }[] = [
    { from: 'hileni@namibclearing.com.na', channel: 'email', subject: 'Berth allocation for MSC Nuria', body: 'Our documents still show quay 7 for MSC Nuria, voyage 2614W. Please confirm the allocation before we send the clearing team.' },
    { from: 'ops@namibclearing.com.na', channel: 'portal', subject: 'Container release delay — 4 units', body: 'Containers MSCU4821937 and three others have been cleared by customs but are still not released at the terminal. Our trucks are waiting.' },
    { from: 'finance@namibclearing.com.na', channel: 'email', subject: 'Invoice query — cargo dues March', body: 'Invoice INV-2026-03-8812 appears to charge cargo dues twice for the same consignment. Please review and issue a credit note.' },
    { from: 'shipping@seaflower.com.na', channel: 'phone', subject: 'Reefer plug availability, quay 8', body: 'Customer called about reefer plug availability for six reefers arriving on quay 8 tomorrow.' },
    { from: 'admin@luderitzlogistics.na', channel: 'portal', subject: 'Access permit for new driver', body: 'We need a port access permit for our new driver starting next week at Lüderitz.' },
    { from: 'logistics@zambezicopper.co.zm', channel: 'email', subject: 'Copper concentrate shipment on CMA CGM Etosha', body: 'Please advise the berthing window for CMA CGM Etosha voyage FE118N; our copper concentrate from Zambia is waiting at the corridor terminal.' },
    { from: 'exports@cuneneagri.com.na', channel: 'email', subject: 'Grapes for export — reefer temperature alarm', body: 'We received a temperature alarm for container OCKU1100234 with table grapes on Ocean Kudu. Urgent: please check the reefer immediately.' },
    { from: 'bookings@kalaharifreight.com', channel: 'portal', subject: 'Request for tariff clarification', body: 'Please clarify the tariff for transhipment of machinery through Walvis Bay to Botswana.' },
    { from: 'applicant@example.com', channel: 'email', subject: 'Application for employment', body: 'Please find attached my CV for any vacancy at the port. I am a qualified electrician.' },
    { from: 'hileni@namibclearing.com.na', channel: 'portal', subject: 'MSC Nuria berth — still unclear', body: 'Following up on the berth allocation for MSC Nuria voyage 2614W, our documents still show quay 7. Please confirm.' },
  ];
  for (const s of sample) {
    await withSystem((tx) => intake(tx, ctx, { channel: s.channel === 'phone' ? 'staff' : s.channel, subject: s.subject, body: s.body, from: { email: s.from }, externalMessageId: s.channel === 'email' ? `<seed-${Buffer.from(s.subject).toString('hex').slice(0, 24)}@demo>` : undefined }));
  }
}

async function main() {
  await migrate(config.databaseUrl);
  await withSystem(seedReference);
  const demo = process.argv.includes('--demo') || process.env.SEED_DEMO === 'true';
  if (demo) {
    const created = await withSystem(seedDemo);
    if (created) await seedDemoQueries();
    console.log(created ? 'demo data created (password for all demo accounts: Sinapse!2026)' : 'demo data already present');
  }
  console.log('reference configuration seeded');
  await pool.end();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
