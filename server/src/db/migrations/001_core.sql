-- Sinapse CRM — core schema
-- Shape follows the proposal's core data model (§1.3.4, Figure 11/13):
--   * Company and Contact are separate entities joined many-to-many with a role
--   * Every interaction carries an external message identifier (idempotent intake)
--   * Cases merge (parent_query_id) rather than close
--   * The workflow version lives on the case
--   * Port context (vessel call, cargo reference, corridor) is first-class
--   * EVENT_LOG is append-only and hash-chained; ROLE/PERMISSION applies to every entity

-- ---------------------------------------------------------------------------
-- Reference data and configuration (configuration is data, not code)
-- ---------------------------------------------------------------------------

CREATE TABLE settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ports (
  code  text PRIMARY KEY,               -- WB, LZ
  name  text NOT NULL
);

CREATE TABLE departments (
  id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code  text UNIQUE NOT NULL,
  name  text NOT NULL
);

CREATE TABLE roles (
  key           text PRIMARY KEY,       -- agent, supervisor, department_head, executive, ict, admin
  name          text NOT NULL,
  permissions   text[] NOT NULL DEFAULT '{}',
  port_scope    text NOT NULL DEFAULT 'own' CHECK (port_scope IN ('own','all')),
  dept_scope    text NOT NULL DEFAULT 'own' CHECK (dept_scope IN ('own','all')),
  field_masks   text[] NOT NULL DEFAULT '{}', -- e.g. company.sap_customer_id
  landing_view  text NOT NULL DEFAULT 'queue'
);

CREATE TABLE calendars (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text UNIQUE NOT NULL,
  utc_offset_minutes  int NOT NULL DEFAULT 120,          -- Namibia, CAT (UTC+2)
  business_hours      jsonb NOT NULL                     -- {"1":[["08:00","17:00"]], ... "0": []}
);

CREATE TABLE calendar_holidays (
  calendar_id  uuid NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  day          date NOT NULL,
  name         text NOT NULL,
  PRIMARY KEY (calendar_id, day)
);

CREATE TABLE corridors (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code       text UNIQUE NOT NULL,
  name       text NOT NULL,
  countries  text[] NOT NULL DEFAULT '{}'
);

-- ---------------------------------------------------------------------------
-- Staff users (internal realm: Microsoft Entra ID, SCIM provisioned)
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             text NOT NULL,
  name              text NOT NULL,
  role_key          text NOT NULL REFERENCES roles(key),
  port_code         text REFERENCES ports(code),
  department_id     uuid REFERENCES departments(id),
  skills            text[] NOT NULL DEFAULT '{}',
  capacity          numeric NOT NULL DEFAULT 20,       -- weighted-load ceiling
  presence          text NOT NULL DEFAULT 'available' CHECK (presence IN ('available','busy','away','offline')),
  active            boolean NOT NULL DEFAULT true,
  identity_subject  text UNIQUE,                       -- Entra object id (oid)
  scim_external_id  text UNIQUE,
  password_hash     text,                              -- local fallback when SSO is not configured
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

CREATE TABLE agent_availability (
  user_id          uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  working_pattern  jsonb,                 -- null => calendar business hours
  out_of_office    boolean NOT NULL DEFAULT false,
  ooo_from         timestamptz,
  ooo_until        timestamptz,
  ooo_message      text,
  source           text NOT NULL DEFAULT 'manual',   -- manual | graph
  synced_at        timestamptz
);

CREATE TABLE leave_periods (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  starts_at  timestamptz NOT NULL,
  ends_at    timestamptz NOT NULL,
  source     text NOT NULL DEFAULT 'graph',
  external_id text,
  UNIQUE (user_id, external_id)
);

-- ---------------------------------------------------------------------------
-- Customer & Company hub (external realm)
-- ---------------------------------------------------------------------------

CREATE TABLE companies (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_no        text NOT NULL,
  name                   text NOT NULL,
  trading_names          text[] NOT NULL DEFAULT '{}',
  company_type           text,                       -- clearing agent, shipping line, cargo owner ...
  ports_served           text[] NOT NULL DEFAULT '{}',
  account_tier           text NOT NULL DEFAULT 'standard' CHECK (account_tier IN ('standard','priority','top10')),
  service_agreement_ref  text,
  sap_customer_id        text,
  status                 text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','rejected','suspended')),
  custom_fields          jsonb NOT NULL DEFAULT '{}',
  approved_by            uuid REFERENCES users(id),
  approved_at            timestamptz,
  created_by_channel     text NOT NULL DEFAULT 'staff',
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  search                 tsvector GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(name,'') || ' ' || coalesce(registration_no,'') || ' ' || coalesce(company_type,''))
  ) STORED
);
CREATE UNIQUE INDEX companies_registration_no_uq ON companies (lower(regexp_replace(registration_no, '[^A-Za-z0-9]', '', 'g')));
CREATE INDEX companies_search_idx ON companies USING gin (search);

CREATE TABLE contacts (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                     text NOT NULL,
  name                      text NOT NULL,
  phone                     text,
  position                  text,
  identity_subject          text UNIQUE,
  password_hash             text,
  mfa_secret                text,
  mfa_enabled               boolean NOT NULL DEFAULT false,
  email_verified            boolean NOT NULL DEFAULT false,
  verification_token        text,
  notification_preferences  jsonb NOT NULL DEFAULT '{"email": true, "portal": true}',
  status                    text NOT NULL DEFAULT 'active' CHECK (status IN ('pending','active','disabled')),
  custom_fields             jsonb NOT NULL DEFAULT '{}',
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  search                    tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(email,'') || ' ' || coalesce(phone,''))
  ) STORED
);
CREATE UNIQUE INDEX contacts_email_uq ON contacts (lower(email));
CREATE INDEX contacts_search_idx ON contacts USING gin (search);

CREATE TABLE company_contacts (
  company_id        uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  contact_id        uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  role              text NOT NULL DEFAULT 'operations' CHECK (role IN ('primary','operations','finance','escalation')),
  is_portal_admin   boolean NOT NULL DEFAULT false,
  permissions       text[] NOT NULL DEFAULT '{log_query,view_company_queries}',
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, contact_id)
);

-- ---------------------------------------------------------------------------
-- Port context (Module 6)
-- ---------------------------------------------------------------------------

CREATE TABLE vessel_calls (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vessel_name   text NOT NULL,
  imo_number    text,
  voyage_no     text NOT NULL,
  port_code     text NOT NULL REFERENCES ports(code),
  berth         text,
  previous_berth text,
  window_from   timestamptz,
  window_to     timestamptz,
  status        text NOT NULL DEFAULT 'expected' CHECK (status IN ('expected','at_anchor','berthed','working','departed','cancelled')),
  corridor_id   uuid REFERENCES corridors(id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vessel_name, voyage_no)
);

CREATE TABLE cargo_references (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  container_no    text,
  bl_no           text,
  vessel_call_id  uuid REFERENCES vessel_calls(id),
  company_id      uuid REFERENCES companies(id),
  cargo_type      text,
  teu             numeric,
  reefer          boolean NOT NULL DEFAULT false,
  corridor_id     uuid REFERENCES corridors(id),
  status          text,
  UNIQUE (container_no)
);

-- ---------------------------------------------------------------------------
-- Workflow, SLA, escalation, assignment configuration (Module 3)
-- ---------------------------------------------------------------------------

CREATE TABLE sla_policies (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                     text UNIQUE NOT NULL,
  calendar_id              uuid NOT NULL REFERENCES calendars(id),
  first_response_minutes   int NOT NULL,         -- business minutes
  resolution_minutes       int NOT NULL,         -- business minutes
  tier_overrides           jsonb NOT NULL DEFAULT '{}',   -- {"top10":{"first_response_minutes":60,"resolution_minutes":480}}
  urgency_multipliers      jsonb NOT NULL DEFAULT '{"low":1.5,"normal":1,"high":0.5,"critical":0.25}',
  pre_breach_percent       int NOT NULL DEFAULT 80   -- warn when this % of target has elapsed
);

CREATE TABLE workflow_definitions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_key    text NOT NULL,
  version         int NOT NULL,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','retired')),
  definition      jsonb NOT NULL,         -- {states:[...], transitions:[...]}
  sla_policy_id   uuid REFERENCES sla_policies(id),
  published_at    timestamptz,
  published_by    uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_key, version)
);

CREATE TABLE queues (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key            text UNIQUE NOT NULL,
  name           text NOT NULL,
  department_id  uuid REFERENCES departments(id),
  port_code      text REFERENCES ports(code),   -- null = both ports
  strategy       text NOT NULL DEFAULT 'least_loaded' CHECK (strategy IN ('round_robin','least_loaded','skills')),
  eligible_roles text[] NOT NULL DEFAULT '{agent,supervisor}',
  required_skills text[] NOT NULL DEFAULT '{}',
  last_assigned_user_id uuid REFERENCES users(id),
  active         boolean NOT NULL DEFAULT true
);

CREATE TABLE query_types (
  key              text PRIMARY KEY,
  name             text NOT NULL,
  department_id    uuid REFERENCES departments(id),
  workflow_key     text NOT NULL DEFAULT 'default',
  queue_key        text,
  default_urgency  text NOT NULL DEFAULT 'normal',
  weight           numeric NOT NULL DEFAULT 1,      -- complexity weight used for load balancing
  skill            text,
  assist_routable  boolean NOT NULL DEFAULT true,
  active           boolean NOT NULL DEFAULT true,
  training_examples text[] NOT NULL DEFAULT '{}'
);

CREATE TABLE escalation_matrices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  query_type_key  text REFERENCES query_types(key),  -- null = any
  department_id   uuid REFERENCES departments(id),   -- null = any
  account_tier    text,                              -- null = any
  levels          jsonb NOT NULL,   -- [{"level":1,"after_minutes":0,"target_role":"supervisor","template":"escalation","channels":["in_app","teams"]}]
  active          boolean NOT NULL DEFAULT true
);

CREATE TABLE custom_field_definitions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity          text NOT NULL CHECK (entity IN ('query','company','contact')),
  key             text NOT NULL,
  label           text NOT NULL,
  field_type      text NOT NULL CHECK (field_type IN ('text','number','date','boolean','select','multiselect')),
  required        boolean NOT NULL DEFAULT false,
  options         text[] NOT NULL DEFAULT '{}',
  validation      jsonb NOT NULL DEFAULT '{}',   -- {"pattern":"...","min":0,"max":10}
  default_value   jsonb,
  help_text       text,
  visible_roles   text[] NOT NULL DEFAULT '{}',  -- empty = all staff roles
  query_types     text[] NOT NULL DEFAULT '{}',  -- empty = all types
  customer_visible boolean NOT NULL DEFAULT false,
  sort_order      int NOT NULL DEFAULT 0,
  active          boolean NOT NULL DEFAULT true,
  UNIQUE (entity, key)
);

CREATE TABLE filter_rules (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern   text NOT NULL,          -- keyword or phrase (case-insensitive, word-boundary)
  category  text NOT NULL,          -- recruitment | donation | other
  active    boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Queries / cases (Module 1)
-- ---------------------------------------------------------------------------

CREATE TABLE reference_sequences (
  port_code   text NOT NULL,
  year        int NOT NULL,
  last_value  bigint NOT NULL,
  PRIMARY KEY (port_code, year)
);

CREATE TABLE queries (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference                text UNIQUE NOT NULL,
  subject                  text NOT NULL,
  description              text NOT NULL DEFAULT '',
  company_id               uuid REFERENCES companies(id),
  contact_id               uuid REFERENCES contacts(id),
  query_type_key           text REFERENCES query_types(key),
  urgency                  text NOT NULL DEFAULT 'normal' CHECK (urgency IN ('low','normal','high','critical')),
  department_id            uuid REFERENCES departments(id),
  port_code                text NOT NULL REFERENCES ports(code),
  channel                  text NOT NULL CHECK (channel IN ('portal','widget','email','phone','assist','staff')),
  state                    text NOT NULL,
  workflow_definition_id   uuid NOT NULL REFERENCES workflow_definitions(id),
  queue_id                 uuid REFERENCES queues(id),
  assigned_to              uuid REFERENCES users(id),
  assigned_at              timestamptz,
  parent_query_id          uuid REFERENCES queries(id),
  possible_duplicate_of    uuid REFERENCES queries(id),
  duplicate_score          numeric,
  filter_reason            text,
  ai_classification        jsonb,       -- {"query_type":..,"confidence":..,"urgency":..,"department":..}
  classification_confirmed boolean NOT NULL DEFAULT false,
  sentiment                numeric,     -- -1 .. 1
  -- service clock
  sla_policy_id            uuid REFERENCES sla_policies(id),
  first_response_due_at    timestamptz,
  resolution_due_at        timestamptz,
  first_responded_at       timestamptz,
  clock_paused_at          timestamptz,
  paused_business_minutes  int NOT NULL DEFAULT 0,
  pre_breach_notified      boolean NOT NULL DEFAULT false,
  breached                 boolean NOT NULL DEFAULT false,
  breached_at              timestamptz,
  escalation_level         int NOT NULL DEFAULT 0,
  last_escalated_at        timestamptz,
  resolved_at              timestamptz,
  closed_at                timestamptz,
  resolution_note          text,
  reopen_count             int NOT NULL DEFAULT 0,
  reassignment_count       int NOT NULL DEFAULT 0,
  unassignable_alerted_at  timestamptz,
  -- port context
  vessel_call_id           uuid REFERENCES vessel_calls(id),
  cargo_reference_id       uuid REFERENCES cargo_references(id),
  corridor_id              uuid REFERENCES corridors(id),
  custom_fields            jsonb NOT NULL DEFAULT '{}',
  created_by               uuid REFERENCES users(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  search                   tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(reference,'')), 'A') ||
    setweight(to_tsvector('english', coalesce(subject,'')), 'A') ||
    setweight(to_tsvector('english', coalesce(description,'')), 'B')
  ) STORED
);
CREATE INDEX queries_state_idx ON queries (state);
CREATE INDEX queries_assigned_idx ON queries (assigned_to) WHERE assigned_to IS NOT NULL;
CREATE INDEX queries_company_idx ON queries (company_id);
CREATE INDEX queries_contact_idx ON queries (contact_id);
CREATE INDEX queries_created_idx ON queries (created_at);
CREATE INDEX queries_search_idx ON queries USING gin (search);

CREATE TABLE query_assignments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  query_id     uuid NOT NULL REFERENCES queries(id) ON DELETE CASCADE,
  from_user_id uuid REFERENCES users(id),
  to_user_id   uuid REFERENCES users(id),
  reason       text,
  strategy     text,
  actor_id     uuid,
  occurred_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE interactions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  query_id             uuid REFERENCES queries(id) ON DELETE CASCADE,
  company_id           uuid REFERENCES companies(id),
  contact_id           uuid REFERENCES contacts(id),
  channel              text NOT NULL CHECK (channel IN ('email','phone','portal','widget','assist','teams','note','system')),
  direction            text NOT NULL CHECK (direction IN ('inbound','outbound','internal')),
  visibility           text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','internal')),
  subject              text,
  body                 text NOT NULL DEFAULT '',
  external_message_id  text,
  thread_id            text,
  call_duration_seconds int,
  call_outcome         text,
  actor_type           text NOT NULL CHECK (actor_type IN ('user','contact','assist','system')),
  actor_id             uuid,
  actor_name           text,
  occurred_at          timestamptz NOT NULL DEFAULT now(),
  search               tsvector GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(subject,'') || ' ' || coalesce(body,''))
  ) STORED,
  -- internal notes can never be outbound: structurally prevented
  CONSTRAINT internal_never_outbound CHECK (NOT (visibility = 'internal' AND direction = 'outbound'))
);
-- Idempotency at the boundary: one external message id → one interaction, ever.
CREATE UNIQUE INDEX interactions_external_message_uq ON interactions (external_message_id) WHERE external_message_id IS NOT NULL;
CREATE INDEX interactions_query_idx ON interactions (query_id, occurred_at);
CREATE INDEX interactions_company_idx ON interactions (company_id, occurred_at);
CREATE INDEX interactions_search_idx ON interactions USING gin (search);

CREATE TABLE attachments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  query_id        uuid REFERENCES queries(id) ON DELETE CASCADE,
  interaction_id  uuid REFERENCES interactions(id) ON DELETE SET NULL,
  company_id      uuid REFERENCES companies(id),
  finding_id      uuid,
  task_id         uuid,
  filename        text NOT NULL,
  mime_type       text NOT NULL,
  size_bytes      bigint NOT NULL,
  object_key      text NOT NULL,
  content_hash    text NOT NULL,
  scan_status     text NOT NULL DEFAULT 'pending' CHECK (scan_status IN ('pending','clean','infected','error')),
  indexed_text    text,
  visibility      text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','internal')),
  uploaded_by_type text NOT NULL,
  uploaded_by_id  uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  search          tsvector GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(filename,'') || ' ' || coalesce(indexed_text,''))
  ) STORED
);
CREATE INDEX attachments_search_idx ON attachments USING gin (search);

CREATE TABLE classification_signals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  query_id    uuid NOT NULL REFERENCES queries(id) ON DELETE CASCADE,
  predicted   jsonb,
  final       jsonb NOT NULL,
  overridden  boolean NOT NULL,
  kind        text NOT NULL DEFAULT 'classification',  -- classification | filter_release | filter_confirm
  actor_id    uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE staff_tasks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignee_id  uuid NOT NULL REFERENCES users(id),
  query_id     uuid REFERENCES queries(id) ON DELETE CASCADE,
  interaction_id uuid REFERENCES interactions(id) ON DELETE CASCADE,
  title        text NOT NULL,
  done         boolean NOT NULL DEFAULT false,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE satisfaction_responses (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  query_id          uuid NOT NULL UNIQUE REFERENCES queries(id) ON DELETE CASCADE,
  contact_id        uuid REFERENCES contacts(id),
  token             text UNIQUE NOT NULL,
  score             int CHECK (score BETWEEN 1 AND 5),
  comment           text,
  followup_query_id uuid REFERENCES queries(id),
  requested_at      timestamptz NOT NULL DEFAULT now(),
  responded_at      timestamptz
);

CREATE TABLE saved_searches (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  filters     jsonb NOT NULL,
  shared      boolean NOT NULL DEFAULT false,
  is_queue    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Audit findings management (AM-02)
-- ---------------------------------------------------------------------------

CREATE TABLE finding_types (
  key   text PRIMARY KEY,
  name  text NOT NULL
);

CREATE TABLE findings (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference           text UNIQUE NOT NULL,
  title               text NOT NULL,
  description         text NOT NULL DEFAULT '',
  finding_type_key    text REFERENCES finding_types(key),
  source              text NOT NULL,                -- internal audit, external audit, customer complaint, regulator...
  severity            text NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  owner_id            uuid REFERENCES users(id),
  owner_accepted_at   timestamptz,
  department_id       uuid REFERENCES departments(id),
  port_code           text REFERENCES ports(code),
  due_date            date,
  state               text NOT NULL DEFAULT 'open' CHECK (state IN ('open','accepted','in_remediation','pending_verification','closed')),
  linked_query_id     uuid REFERENCES queries(id),
  linked_company_id   uuid REFERENCES companies(id),
  recurrence_of       uuid REFERENCES findings(id),
  recurrence_score    numeric,
  escalation_level    int NOT NULL DEFAULT 0,
  closed_at           timestamptz,
  created_by          uuid REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE remediation_tasks (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_id               uuid NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  title                    text NOT NULL,
  owner_id                 uuid REFERENCES users(id),
  due_date                 date,
  state                    text NOT NULL DEFAULT 'open' CHECK (state IN ('open','in_progress','done','cancelled')),
  evidence_attachment_id   uuid REFERENCES attachments(id),
  completion_note          text,
  overdue_escalated        boolean NOT NULL DEFAULT false,
  completed_at             timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Knowledge base and Sinapse Assist (Module 4)
-- ---------------------------------------------------------------------------

CREATE TABLE knowledge_articles (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title            text NOT NULL,
  body             text NOT NULL,
  category         text,
  department_id    uuid REFERENCES departments(id),
  audience_scope   text NOT NULL DEFAULT 'public' CHECK (audience_scope IN ('public','customer','staff')),
  state            text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','review','published','archived')),
  version          int NOT NULL DEFAULT 1,
  source_query_id  uuid REFERENCES queries(id),
  proposed_by_assist boolean NOT NULL DEFAULT false,
  author_id        uuid REFERENCES users(id),
  approved_by      uuid REFERENCES users(id),
  published_at     timestamptz,
  answered_count   int NOT NULL DEFAULT 0,
  helpful_count    int NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  search           tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title,'')), 'A') ||
    setweight(to_tsvector('english', coalesce(category,'')), 'B') ||
    setweight(to_tsvector('english', coalesce(body,'')), 'C')
  ) STORED
);
CREATE INDEX knowledge_search_idx ON knowledge_articles USING gin (search);

CREATE TABLE knowledge_gaps (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  normalized     text UNIQUE NOT NULL,
  sample_question text NOT NULL,
  ask_count      int NOT NULL DEFAULT 1,
  last_asked_at  timestamptz NOT NULL DEFAULT now(),
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open','addressed','dismissed')),
  article_id     uuid REFERENCES knowledge_articles(id)
);

CREATE TABLE assist_sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id        uuid REFERENCES contacts(id),
  company_id        uuid REFERENCES companies(id),
  channel           text NOT NULL DEFAULT 'portal' CHECK (channel IN ('portal','website','email')),
  turns             jsonb NOT NULL DEFAULT '[]',
  outcome           text NOT NULL DEFAULT 'open' CHECK (outcome IN ('open','answered','acted','handed_over','declined','abandoned')),
  created_query_id  uuid REFERENCES queries(id),
  handed_over_query_id uuid REFERENCES queries(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Notifications, alerts, proactive notices
-- ---------------------------------------------------------------------------

CREATE TABLE notification_templates (
  key       text PRIMARY KEY,
  subject   text NOT NULL,
  body      text NOT NULL,
  channels  text[] NOT NULL DEFAULT '{email}'
);

CREATE TABLE notifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel         text NOT NULL CHECK (channel IN ('email','teams','portal','in_app')),
  recipient_type  text NOT NULL CHECK (recipient_type IN ('user','contact','address','channel')),
  recipient_id    uuid,
  recipient_address text,
  template_key    text,
  subject         text NOT NULL,
  body            text NOT NULL,
  query_id        uuid REFERENCES queries(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','read')),
  attempts        int NOT NULL DEFAULT 0,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  read_at         timestamptz
);
CREATE INDEX notifications_recipient_idx ON notifications (recipient_type, recipient_id, created_at DESC);
CREATE INDEX notifications_pending_idx ON notifications (status) WHERE status = 'pending';

CREATE TABLE alerts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL,       -- pre_breach | breach | escalation | unassignable | threshold | finding_overdue | integration
  severity      text NOT NULL DEFAULT 'warning' CHECK (severity IN ('info','warning','critical')),
  message       text NOT NULL,
  query_id      uuid REFERENCES queries(id) ON DELETE CASCADE,
  finding_id    uuid REFERENCES findings(id) ON DELETE CASCADE,
  port_code     text,
  department_id uuid,
  target_role   text,
  dedupe_key    text UNIQUE,
  acknowledged_by uuid REFERENCES users(id),
  acknowledged_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE operational_notices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title           text NOT NULL,
  body            text NOT NULL,
  vessel_call_id  uuid REFERENCES vessel_calls(id),
  port_code       text REFERENCES ports(code),
  corridor_id     uuid REFERENCES corridors(id),
  audience        text NOT NULL DEFAULT 'affected' CHECK (audience IN ('affected','port','all')),
  recipients_count int NOT NULL DEFAULT 0,
  created_by      uuid REFERENCES users(id),
  sent_at         timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Reporting
-- ---------------------------------------------------------------------------

CREATE TABLE reports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  definition   jsonb NOT NULL,
  owner_id     uuid REFERENCES users(id),
  shared       boolean NOT NULL DEFAULT false,
  schedule     text CHECK (schedule IN ('daily','weekly','monthly')),
  format       text NOT NULL DEFAULT 'csv' CHECK (format IN ('csv','xlsx','pdf')),
  recipients   text[] NOT NULL DEFAULT '{}',
  last_run_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE dashboard_layouts (
  user_id  uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  layout   jsonb NOT NULL
);

-- ---------------------------------------------------------------------------
-- Integration fabric (Module 7)
-- ---------------------------------------------------------------------------

CREATE TABLE integration_connectors (
  key              text PRIMARY KEY,   -- entra, graph_mail, graph_calendar, teams, sap, website
  name             text NOT NULL,
  enabled          boolean NOT NULL DEFAULT true,
  status           text NOT NULL DEFAULT 'unconfigured' CHECK (status IN ('healthy','degraded','down','unconfigured','revoked')),
  config           jsonb NOT NULL DEFAULT '{}',
  last_success_at  timestamptz,
  last_error_at    timestamptz,
  last_error       text
);

CREATE TABLE integration_log (
  id             bigserial PRIMARY KEY,
  connector_key  text NOT NULL,
  direction      text NOT NULL CHECK (direction IN ('inbound','outbound')),
  operation      text NOT NULL,
  status         text NOT NULL CHECK (status IN ('success','failed','retrying','dead_letter','duplicate')),
  correlation_id text,
  payload        jsonb,
  error          text,
  attempts       int NOT NULL DEFAULT 1,
  next_retry_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX integration_log_connector_idx ON integration_log (connector_key, created_at DESC);

CREATE TABLE webhooks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  url         text NOT NULL,
  events      text[] NOT NULL,
  secret      text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id    uuid NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event         text NOT NULL,
  payload       jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','failed','dead_letter')),
  attempts      int NOT NULL DEFAULT 0,
  response_code int,
  last_error    text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_clients (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  key_hash    text UNIQUE NOT NULL,
  role_key    text NOT NULL REFERENCES roles(key),
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Retention and disposal
-- ---------------------------------------------------------------------------

CREATE TABLE retention_policies (
  entity      text PRIMARY KEY,   -- assist_sessions | notifications | attachments_closed | integration_log
  keep_days   int NOT NULL
);

CREATE TABLE disposal_log (
  id          bigserial PRIMARY KEY,
  entity      text NOT NULL,
  record_ids  text[] NOT NULL,
  count       int NOT NULL,
  disposed_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Append-only, tamper-evident event log (CM01.3, SA-01.3)
--
-- Every row carries a SHA-256 hash of its own content, computed on insert. A separate seal
-- table chains those hashes in the order rows become visible (seal_event_log(), run by the
-- scheduler), so writers never serialise on the log, and any edited, removed or reordered
-- entry breaks the chain. Both tables reject UPDATE, DELETE and TRUNCATE.
-- ---------------------------------------------------------------------------

CREATE TABLE event_log (
  id           bigserial PRIMARY KEY,
  occurred_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_type   text NOT NULL,          -- user | contact | assist | system | api | scim
  actor_id     text,
  actor_name   text,
  action       text NOT NULL,          -- e.g. query.created, query.transition, company.read, auth.login
  entity       text NOT NULL,
  entity_id    text,
  before       jsonb,
  after        jsonb,
  request_id   text,
  ip           text,
  user_agent   text,
  hash         text NOT NULL DEFAULT ''
);
CREATE INDEX event_log_entity_idx ON event_log (entity, entity_id, id);
CREATE INDEX event_log_action_idx ON event_log (action, occurred_at);

CREATE OR REPLACE FUNCTION event_log_row_hash(e event_log) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT encode(sha256(convert_to(
      e.id::text || '|' || to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') || '|' ||
      e.actor_type || '|' || coalesce(e.actor_id,'') || '|' || coalesce(e.actor_name,'') || '|' || e.action || '|' || e.entity || '|' ||
      coalesce(e.entity_id,'') || '|' || coalesce(e.before::text,'') || '|' || coalesce(e.after::text,'') || '|' ||
      coalesce(e.request_id,'') || '|' || coalesce(e.ip,''), 'UTF8')), 'hex')
$$;

CREATE OR REPLACE FUNCTION event_log_hash_trg() RETURNS trigger AS $$
BEGIN
  NEW.hash := event_log_row_hash(NEW);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER event_log_hash BEFORE INSERT ON event_log FOR EACH ROW EXECUTE FUNCTION event_log_hash_trg();

CREATE TABLE event_log_seal (
  seq         bigserial PRIMARY KEY,
  event_id    bigint NOT NULL UNIQUE REFERENCES event_log(id),
  row_hash    text NOT NULL,
  prev_hash   text NOT NULL,
  chain_hash  text NOT NULL,
  sealed_at   timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION event_log_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER event_log_no_update BEFORE UPDATE OR DELETE ON event_log FOR EACH ROW EXECUTE FUNCTION event_log_immutable();
CREATE TRIGGER event_log_no_truncate BEFORE TRUNCATE ON event_log FOR EACH STATEMENT EXECUTE FUNCTION event_log_immutable();
CREATE TRIGGER event_log_seal_no_update BEFORE UPDATE OR DELETE ON event_log_seal FOR EACH ROW EXECUTE FUNCTION event_log_immutable();
CREATE TRIGGER event_log_seal_no_truncate BEFORE TRUNCATE ON event_log_seal FOR EACH STATEMENT EXECUTE FUNCTION event_log_immutable();

-- Append every visible, unsealed entry to the chain. Single sealer at a time (advisory lock).
CREATE OR REPLACE FUNCTION seal_event_log(max_rows int DEFAULT 50000) RETURNS int AS $$
DECLARE
  prev text;
  r record;
  n int := 0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(4242) THEN RETURN 0; END IF;
  SELECT chain_hash INTO prev FROM event_log_seal ORDER BY seq DESC LIMIT 1;
  prev := coalesce(prev, 'GENESIS');
  FOR r IN SELECT e.id, e.hash FROM event_log e WHERE NOT EXISTS (SELECT 1 FROM event_log_seal s WHERE s.event_id = e.id) ORDER BY e.id LIMIT max_rows LOOP
    INSERT INTO event_log_seal (event_id, row_hash, prev_hash, chain_hash)
    VALUES (r.id, r.hash, prev, encode(sha256(convert_to(prev || '|' || r.hash, 'UTF8')), 'hex'));
    prev := encode(sha256(convert_to(prev || '|' || r.hash, 'UTF8')), 'hex');
    n := n + 1;
  END LOOP;
  RETURN n;
END;
$$ LANGUAGE plpgsql;
