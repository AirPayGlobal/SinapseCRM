# Sinapse CRM — Namport implementation

Sinapse CRM is the port-operations customer management system described in M2M Global Technologies' Full Technical
Proposal to the Namibian Ports Authority (Form F-11, CS/RFP/NAMPORT-3762/2026). This repository implements the
eight modules the proposal sets out, for the Port of Walvis Bay and the Port of Lüderitz:

| # | Module | Where |
|---|---|---|
| 1 | Query and case management, audit findings | `server/src/services/{intake,queries,workflow,findings}.ts` |
| 2 | Customer and company hub, self-service portal | `server/src/services/companies.ts`, `web/src/portal/` |
| 3 | Workflow, routing and escalation | `server/src/services/{workflow,assignment,sla,escalation}.ts` |
| 4 | Sinapse Assist (AI agent) and knowledge base | `server/src/services/{assist,kb,classifier,llm}.ts` |
| 5 | Insight and reporting | `server/src/services/reports.ts`, `web/src/staff/Reports.tsx` |
| 6 | Port context (vessels, cargo, corridors, proactive notices) | `server/src/services/port.ts`, `web/src/staff/Port.tsx` |
| 7 | Integration fabric (Entra ID, SCIM, Graph, Teams, SAP, webhooks, REST API) | `server/src/integrations/`, `server/src/routes/scim.ts` |
| 8 | Security and governance (RLS, field masking, sealed audit log) | `server/src/db/migrations/`, `server/src/lib/` |

How each of the 58 numbered requirements in ToR §3.2.1.1 is met, with the test that exercises it:
[`docs/requirements-traceability.md`](docs/requirements-traceability.md).

## The seven failures, and how the code answers them

| What Namport experienced | Structural answer in this codebase |
|---|---|
| Manual creation of profiles | Customers self-register (`POST /portal/register`), verify by email, and are approved — not keyed — by Namport. Company administrators add and remove their own colleagues. |
| No automatic allocation | Assignment engine: eligibility → availability (presence, working pattern, leave, Outlook out-of-office) → weighted capacity → strategy per queue → atomic claim. Unassignable work alerts a supervisor. |
| Duplicate logging | Unique index on inbound `external_message_id` (a replay cannot create a case); replies quoting a reference thread onto the case; near-duplicates are offered for merge; assignment is a conditional update under a per-agent lock. |
| Thin workflow intelligence | Versioned state machine per query type with guards, automated actions and per-state clock behaviour; in-flight cases keep their version. |
| No self-service | Portal with a customer-visible timeline, Sinapse Assist, document centre, satisfaction capture. |
| External adoption | Portal is the only route to a new company registration; email and phone still land in the same record; weekly adoption report. |
| Weak integration | One integration fabric with health, a queryable log and dead letters; documented REST API, API keys and signed webhooks handed to Namport. |

## Architecture

- **API**: Node.js 22, TypeScript, Express (`server/`). Every screen action is a call on `/api/v1`
  (OpenAPI at `/api/v1/openapi.json`).
- **Data**: PostgreSQL 16. Access control is evaluated *inside the database*: every request runs in a transaction that
  assumes the `sinapse_app` role and sets its scope (`app.scope`, ports, departments, companies); row-level-security
  policies then filter every query, so an API call, an export and a report obey the same rules as a screen. Engines that
  need whole-system visibility (assignment load, SLA evaluation) step up explicitly with `asSystem()`.
- **Audit**: `event_log` is append-only (trigger + revoked privileges), each row carries a SHA-256 of its content, and
  `seal_event_log()` chains row hashes into `event_log_seal` in visibility order. `GET /admin/audit/verify` recomputes both.
- **Reporting** reads `ANALYTICS_DATABASE_URL` (a read replica) when set.
- **Web**: React + Vite single-page app (`web/`) — agent console, supervisor and executive views, administration
  console, customer portal, website widget (`/widget`, embedded with `public/embed.js`). Installable PWA with offline
  read of assigned work.
- **Background engine** (`server/src/jobs/scheduler.ts`): SLA pre-breach/breach/escalation, queue draining, auto-close
  after the review window, overdue remediation, threshold alerts, notification and webhook delivery, mailbox polling,
  calendar sync, scheduled reports, retention, audit sealing. One leader per cluster via a Postgres advisory lock.

### Sinapse Assist

Retrieval is local and deterministic: PostgreSQL full-text recall over *published* articles (row-level security limits
customers to customer-facing content), TF-IDF re-ranking and term coverage give a confidence score, and below the
configured gate Assist declines and records a knowledge gap. Tariffs, date commitments and contract interpretation are
always routed to a person; asking for a person or showing frustration hands over with the transcript and what was
attempted. If `ANTHROPIC_API_KEY` is set, the approved passages are phrased by Claude (`ASSIST_MODEL`, default
`claude-opus-5-5`) under an instruction to add nothing; on any failure or refusal the extractive answer is used.

## Running locally

Requirements: Node.js 22, PostgreSQL 14+ (16 recommended).

```bash
npm install
```

```bash
createdb sinapse
```

```bash
DATABASE_URL=postgres://postgres@localhost:5432/sinapse npm run seed -w server -- --demo
```

```bash
DATABASE_URL=postgres://postgres@localhost:5432/sinapse npm run dev -w server
```

```bash
npm run dev -w web
```

Open http://localhost:5173 (staff) or http://localhost:5173/portal (customers). Or build the web app
(`npm run build -w web`) and the API serves it on http://localhost:4000.

With Docker:

```bash
docker compose up --build
```

On start the app applies migrations and loads the reference configuration automatically. Set
`SEED_DEMO=true` to load the demo data once (it is skipped if any company exists). If `JWT_SECRET` is
not set, a strong secret is generated on first start and kept in the database. To create or
recover an administrator without shell access, set `ADMIN_EMAIL` and `ADMIN_PASSWORD` (10+ characters),
deploy, sign in, then remove `ADMIN_PASSWORD`.

### Demo accounts (password `Sinapse!2026`, demo data is fictitious)

| Account | Role |
|---|---|
| `t.shikongo@namport.com.na` | Agent, Walvis Bay |
| `s.goagoses@namport.com.na` | Agent, Lüderitz |
| `k.kaapanda@namport.com.na` | Supervisor, Walvis Bay |
| `h.mbango@namport.com.na` | Department head |
| `e.angula@namport.com.na` | Executive |
| `ict@namport.com.na` | ICT administrator |
| `auditor@namport.com.na` | Internal auditor |
| `admin@namport.com.na` | System administrator |
| `hileni@namibclearing.com.na` | Customer portal — company administrator (Top 10 clearing agent) |

Demo agents have a 24/7 working pattern so assignment can be seen at any hour; the seeded service calendar itself is
Mon–Thu 07:30–16:30, Fri 07:30–13:00 with Namibian public holidays 2025–2030.

## Tests

```bash
npm test
```

Runs 46 integration tests against a real PostgreSQL database (`TEST_DATABASE_URL`, default
`postgres://postgres@localhost:5432/sinapse_test`, recreated on each run): calendar and holiday arithmetic, idempotent
intake, threading, filtering, near-duplicate merge, out-of-office exclusion, concurrent assignment, workflow guards and
paused clocks, Top 10 escalation, row-level security, field masking, audit immutability, the self-registration flow,
Assist grounding/decline/handover, SCIM joiner/leaver, webhooks and report export.

## Configuration

See [`.env.example`](.env.example). Everything business-facing — query types, queues and strategies, workflows,
SLA policies and calendars, the escalation matrix, custom fields, filter rules, templates, roles and field masks,
retention — is data, edited in **Admin** and recorded in the audit log.

## Production deployment notes

The proposal commits to a single-tenant, M2M-operated environment with the hosting region confirmed with Namport at
inception. This repository provides the application, its schema and a container image; the following are deployment
responsibilities, not implemented here:

- Infrastructure as code, multi-AZ PostgreSQL with point-in-time recovery, read replica, object storage, WAF/CDN,
  TLS 1.3 termination, KMS-managed encryption at rest, secrets vault, backup/restore testing, observability.
- Connect as a non-superuser schema owner for migrations and a login role that is a member of `sinapse_app` for the
  application (`DB_APP_ROLE`), so row-level security cannot be bypassed.
- Set `ALLOW_LOCAL_LOGIN=false` once Entra ID SSO is live; set `JWT_SECRET`, `SCIM_TOKEN`, and the Entra/Graph,
  Teams, SAP and ClamAV variables.
- Attachments: `OBJECT_STORAGE_DIR` is a filesystem path; mount durable storage or replace `services/attachments.ts`
  storage calls with the object-store SDK of the chosen platform.

## Known limitations

- Microsoft Graph, Entra ID, Teams and SAP connectors are implemented against the published APIs but have not been run
  against Namport's tenant or SAP landscape; SAP object mapping is fixed at the week-9 mapping specification.
- WCAG 2.1 AA conformance and the performance targets (§1.3.7) have not yet been formally tested.
- PDF text extraction for search covers text-based PDFs; scanned documents need OCR (roadmap: document intelligence).
- Roadmap items in §1.3.10 (WhatsApp, document intelligence, forecasting, health scoring, developer portal) are out of scope.
