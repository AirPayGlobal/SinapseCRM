# Requirements traceability — ToR §3.2.1.1 (58 requirements)

Source: *Sinapse CRM — Namport Full Technical Proposal* (Form F-11, CS/RFP/NAMPORT-3762/2026), Annex A.
Each row names where the requirement is implemented and, where one exists, the automated test that exercises it
(`server/test/*.test.ts`, run with `npm test`). Screen numbers (S-xx) refer to Annex B of the proposal.

## Query management and categorisation

| ID | Requirement | Implementation | Verified by |
|---|---|---|---|
| QMC-01 | Query management and categorisation | One `queries` record for every channel; intake pipeline `server/src/services/intake.ts`; case view S-01 `web/src/staff/CaseView.tsx` | engine.test — intake suite |
| QMC-01.1 | Log queries via web, email, phone | Portal `POST /portal/queries`, website widget `POST /portal/widget/query`, Graph mailbox poll `jobs/integrationJobs.ts` + `POST /integrations/mail/inbound`, quick capture S-04 `staff/Capture.tsx` | api.test — quick capture, portal, widget, inbound mail |
| QMC-02 | Unique ticket number | Atomic upsert sequence per port and year, configurable mask `NAM-{PORT}-{YYYY}-{SEQ:6}` — `services/reference.ts` | calendar.test (mask), engine.test (WB/LZ sequences) |
| QMC-03 | Categorise by type, urgency, customer, department | Indexed columns; naive-Bayes classifier proposes, agent confirms/overrides, overrides stored as `classification_signals` — `services/classifier.ts`, `services/queries.ts#updateQuery` | engine.test — training signal |
| QMC-04 | Configurable / custom fields | Metadata field engine `custom_field_definitions`, validation and role/query-type visibility — `services/customFields.ts`; admin S-45 tab "Custom fields" | — |
| QMC-05 | Filter CV, job application, vacancy, donations, apprenticeship | Keyword rules seeded with the five terms + intent classifier; review queue S-07, release/confirm retrains — `classifier.ts#evaluateFilter`, `queries.ts#reviewFiltered` | engine.test — filter and release |

## Audit findings management

| ID | Requirement | Implementation | Verified by |
|---|---|---|---|
| AM-02 | Manage audit findings, remediation, progress | `findings`, `remediation_tasks`; `services/findings.ts`; S-09/S-10 `staff/Findings.tsx` | — |
| AM-02.1 | Define, assign, track findings | Finding types, owner acceptance step, state machine, history from the event log, recurrence detection (TF-IDF vs closed findings) | — |
| AM-02.2 | Remediation tasks with owners and progress | Child tasks, roll-up to `pending_verification`, closure requires evidence and a verifier other than the owner; overdue tasks escalate — `escalation.ts#evaluateFindings` | — |

## Customer and company profiles

| ID | Requirement | Implementation | Verified by |
|---|---|---|---|
| CCP-01 | Manage customer and company profiles | `companies` ⟷ `contacts` many-to-many via `company_contacts` with role (primary/operations/finance/escalation) — `services/companies.ts` | api.test |
| CCP-01.1 | Create company profiles | Staff create with duplicate detection on normalised registration number and trading name | api.test — duplicate registration rejected |
| CCP-01.2 | Multiple individuals per company | Unlimited contacts, contacts across companies; company administrators manage colleagues in the portal (S-51) | api.test — colleague add/remove, non-admin refused |
| CCP-01.3 | Search and retrieval | Full-text + faceted search across companies, contacts, cases, correspondence and attachment bodies — `companies.ts#globalSearch`, S-14 | — |
| CCP-01.4 | Self-service register and log queries | `register` → email verification → Namport approval queue S-15; portal logging | api.test — register/verify/approve/log |
| CCP-01.5 | Complete interaction history | Timeline per company/contact/case across channels; customer-visible (internal notes excluded by RLS) | engine.test — RLS hides internal notes |

## Workflow management and escalation

| ID | Requirement | Implementation | Verified by |
|---|---|---|---|
| WM-01 | Workflow management and escalation | Versioned state machine per query type — `services/workflow.ts` | engine.test |
| WM-01.1 | Configurable lifecycle | Designer S-16 `staff/admin/Workflows.tsx`; draft → preview against history → publish; version held on the case | engine.test — in-flight case keeps version |
| WM-01.2 | Notify on creation (with number) and assignment | Templated notifications, reference in every subject — `services/notifications.ts`, `workflow.ts#runActions` | — (rows asserted in seed run) |
| WM-01.3 | Escalate on time thresholds and customer priority (Top 10) | Matrix resolved by type/department/tier; Top 10 matrix and SLA overrides; sentiment/critical shorten timers — `services/escalation.ts` | engine.test — Top 10 reaches level 2 after 60 min |
| WM-01.4 | Escalation matrix with defined levels | `escalation_matrices.levels` (role, timer, template, channels); admin tab | engine.test |
| WM-01.5 | Alerts for overdue queries | Business-hours clock with Namibian public holidays; pre-breach and breach alerts; alert centre S-21 — `lib/calendar.ts`, `escalation.ts#evaluateSla` | calendar.test, engine.test |

## Ticket assignment and agent rotation

| ID | Requirement | Implementation | Verified by |
|---|---|---|---|
| TA-01 | Assignment and rotation | Engine: eligibility → availability → capacity → strategy (round robin / least loaded / skills) → claim — `services/assignment.ts` | engine.test |
| TA-01.1 | Assign automatically to available agents | Runs on creation and reassignment; unassignable cases hold and alert supervisors; scheduler drains queues | seed run, engine.test |
| TA-01.2 | Load balancing | Weighted open load (type weight × urgency) against per-agent capacity | — |
| TA-01.3 | Out-of-office and workload | Graph mailbox settings + calendar `oof` events → `agent_availability`, `leave_periods`; board S-20 | engine.test — OOO agent never assigned |
| TA-01.4 | Prevent duplicate assignment | Conditional `UPDATE … WHERE assigned_to IS NULL` under per-agent advisory lock; idempotent intake on `external_message_id`; near-duplicate merge | engine.test — concurrency, idempotency, merge |
| TA-01.5 | Manual reassignment | Reason required; history and reassignment-pattern report | engine.test |

## Communication management

| ID | Requirement | Implementation | Verified by |
|---|---|---|---|
| CM01 | Communication management | Typed `interactions` on case and customer timeline | — |
| CM01.1 | Track emails, calls, notes | Graph ingestion and send-as; call logging with duration/direction/outcome; notes | api.test — inbound mail |
| CM01.2 | Attachments | Virus scan (EICAR + clamd), content hash, object storage, text extraction for search — `services/attachments.ts` | — |
| CM01.3 | Full audit trail | Append-only `event_log`, per-row SHA-256, sealed chain `event_log_seal`; reads of sensitive records logged | engine.test, api.test — verify endpoint |
| CM01.4 | Internal notes | Visibility-scoped; DB constraint forbids internal+outbound; RLS hides from customers; @mentions create tasks | engine.test |

## Reporting and analytics

| ID | Requirement | Implementation | Verified by |
|---|---|---|---|
| RA-01 | Reporting and analytics | `services/reports.ts`, analytics replica pool | api.test |
| RA-01.1 | Standard and customisable reports | Standard dashboards + report builder; save, schedule, email; CSV/Excel/PDF | api.test — export in all three formats |
| RA-01.2 | Volumes by type/period/customer, resolution, backlog, overdue | Dashboard S-33 with drill-through to cases; port/department/tier/period filters; corridor panel | api.test |
| RA-01.3 | Per agent and department | Volume, first response, resolution, SLA, reopen rate, backlog age, weekly trend (S-35) | — |
| RA-01.4 | Real-time analytics | Live queries, 30-second refresh, threshold alerts to management | — |

## AI agent (Sinapse Assist)

| ID | Requirement | Implementation | Verified by |
|---|---|---|---|
| CB-01 | AI-powered support | `services/assist.ts`, portal and website widget (`portal/Assist.tsx`, `public/embed.js`) | api.test |
| CB-01.1 | Submit and track enquiries | Creates cases through intake; status by reference under the customer's RLS scope; add info; request escalation | api.test — cannot see another company's case |
| CB-01.2 | Generate / retrieve references | Core numbering service; lookup by description | — |
| CB-01.3 | Automated FAQ answers | Retrieval-grounded with source shown; declines below the confidence gate; optional LLM phrasing constrained to retrieved passages (`services/llm.ts`) | api.test — answer with source, decline + gap |
| CB-01.4 | Escalate to agents | Handover on request/frustration/repeated failure, carrying transcript and what was attempted | api.test — handover |
| CB-01.5 | Integrate with CRM | Assist is a client of the same services; conversation lands on the case timeline | api.test — transcript on case |
| CB-01.6 | Knowledge-base expansion by Namport | Draft → review → publish by a named approver ≠ author; gap report; proposals from resolved cases | api.test — approval rule |

## User experience and usability

| ID | Requirement | Implementation | Verified by |
|---|---|---|---|
| UE-01 | UX and usability | Single-screen agent console S-01 | browser drive (manual) |
| UE-01.1 | Intuitive interface | Keyboard-reachable controls, skip link, inline editing, progressive disclosure | — (WCAG 2.1 AA audit still to be performed) |
| UE-01.2 | Role-based dashboards | `roles.landing_view` routes agent/supervisor/department head/executive/ICT to their view; saved dashboard layout API | — |
| UE-01.3 | Advanced search and filtering | Full-text + facets; saved searches; shared saved searches become team queues | — |
| UE-01.4 | Quick logging and updates | Capture form with customer lookup and live category prediction; inline urgency and reassignment from list views | api.test — quick capture |
| UE-01.5 | Web and mobile | Responsive SPA; installable PWA with service-worker offline read of assigned work (`public/sw.js`) | browser drive at 390 px |

## Integration

| ID | Requirement | Implementation | Verified by |
|---|---|---|---|
| IR-01 | Integration requirements | REST API (`/api/v1`, OpenAPI at `/api/v1/openapi.json`), API keys, HMAC-signed webhooks with retry and dead letter | api.test — OpenAPI, webhooks |
| IR-01.1 | Outlook, Azure SSO, Teams | Entra ID OIDC + PKCE (`integrations/entra.ts`), SCIM 2.0 (`routes/scim.ts`), Graph mail and calendars (`integrations/graph.ts`), Teams adaptive cards (`integrations/teams.ts`) | api.test — SCIM joiner/leaver |
| IR-01.2 | Other systems via APIs | SAP S/4HANA OData business-partner alignment (`integrations/sap.ts`); website embed; integration log and health console S-42/S-43 | — |

## Security and access control

| ID | Requirement | Implementation | Verified by |
|---|---|---|---|
| SA-01 | Security and access control | Least privilege enforced in PostgreSQL row-level security (`migrations/002_access_control.sql`) | engine.test |
| SA-01.1 | RBAC | Roles with permissions, port and department scope, field masks applied in the single serialisation path | engine.test — LZ cannot see WB; SAP id masked for agents |
| SA-01.2 | Data security and confidentiality | TLS/at-rest encryption, vault and network isolation are hosting concerns (see README › Production deployment); app enforces RLS, hashed secrets, signed tokens, upload scanning | — |
| SA-01.3 | Audit logs for all activity | Auth, reads of sensitive records, data/config/admin changes; tamper-evident; CSV/JSONL export | api.test — integrity verify |
| SA-01.4 | Secure authentication (Azure SSO) | Entra ID SSO for staff; separate customer realm with email verification and optional TOTP MFA; throttling | api.test — bad credentials, SCIM leaver loses access |
