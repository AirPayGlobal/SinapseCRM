-- Access control evaluated at the data layer (§1.3.3, §1.3.6, SA-01.1).
--
-- The application executes every request inside a transaction that sets
--   SET LOCAL ROLE sinapse_app
--   app.scope       = system | staff | customer
--   app.ports       = '*' | 'WB,LZ'
--   app.departments = '*' | '<uuid>,<uuid>'
--   app.companies   = '<uuid>,...'            (customer realm)
--   app.contact     = '<uuid>'                (customer realm)
-- Row-level security policies then filter inside the query itself, so an API call,
-- an export and a report are subject to exactly the same rules as a screen.

-- On managed databases without CREATEROLE (e.g. Render, some Azure tiers) the dedicated role
-- cannot be created. The policies below use FORCE ROW LEVEL SECURITY, so they still bind the
-- (non-superuser) owner account; the application detects the missing role at start-up.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sinapse_app') THEN
    CREATE ROLE sinapse_app NOLOGIN;
  END IF;
  -- the migrating user must be able to SET ROLE to it
  EXECUTE format('GRANT sinapse_app TO %I', current_user);
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'sinapse_app role not created (%); row-level security will apply to the owner account', SQLERRM;
END$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sinapse_app') THEN
    GRANT USAGE ON SCHEMA public TO sinapse_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sinapse_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sinapse_app;
    -- the event log is append-only for the application role at the privilege level as well
    REVOKE UPDATE, DELETE, TRUNCATE ON event_log FROM sinapse_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON event_log_seal FROM sinapse_app;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'could not grant to sinapse_app (%)', SQLERRM;
END$$;

CREATE OR REPLACE FUNCTION app_scope() RETURNS text LANGUAGE sql STABLE AS
$$ SELECT coalesce(nullif(current_setting('app.scope', true), ''), 'none') $$;

CREATE OR REPLACE FUNCTION app_list(setting text) RETURNS text[] LANGUAGE sql STABLE AS
$$ SELECT string_to_array(coalesce(nullif(current_setting(setting, true), ''), ''), ',') $$;

CREATE OR REPLACE FUNCTION app_port_ok(p text) RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT current_setting('app.ports', true) = '*' OR p = ANY (app_list('app.ports')) $$;

CREATE OR REPLACE FUNCTION app_dept_ok(d uuid) RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT current_setting('app.departments', true) = '*' OR d IS NULL OR d::text = ANY (app_list('app.departments')) $$;

CREATE OR REPLACE FUNCTION app_company_ok(c uuid) RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT c IS NOT NULL AND c::text = ANY (app_list('app.companies')) $$;

-- queries ------------------------------------------------------------------
ALTER TABLE queries ENABLE ROW LEVEL SECURITY;
ALTER TABLE queries FORCE ROW LEVEL SECURITY;
CREATE POLICY queries_scope ON queries
  USING (
    app_scope() = 'system'
    OR (app_scope() = 'staff' AND app_port_ok(port_code) AND app_dept_ok(department_id))
    OR (app_scope() = 'customer' AND (app_company_ok(company_id)
        OR (company_id IS NULL AND contact_id::text = current_setting('app.contact', true))))
  )
  WITH CHECK (
    app_scope() = 'system'
    OR (app_scope() = 'staff' AND app_port_ok(port_code) AND app_dept_ok(department_id))
    OR (app_scope() = 'customer' AND (app_company_ok(company_id)
        OR (company_id IS NULL AND contact_id::text = current_setting('app.contact', true))))
  );

-- interactions: customers never see internal notes, structurally -------------
ALTER TABLE interactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE interactions FORCE ROW LEVEL SECURITY;
CREATE POLICY interactions_scope ON interactions
  USING (
    app_scope() IN ('system','staff') AND (query_id IS NULL OR EXISTS (SELECT 1 FROM queries q WHERE q.id = query_id))
    OR (app_scope() = 'customer' AND visibility = 'public'
        AND (EXISTS (SELECT 1 FROM queries q WHERE q.id = query_id)
             OR (query_id IS NULL AND app_company_ok(company_id))))
  )
  WITH CHECK (
    app_scope() IN ('system','staff')
    OR (app_scope() = 'customer' AND visibility = 'public' AND direction = 'inbound')
  );

-- attachments ----------------------------------------------------------------
ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachments FORCE ROW LEVEL SECURITY;
CREATE POLICY attachments_scope ON attachments
  USING (
    app_scope() IN ('system','staff') AND (query_id IS NULL OR EXISTS (SELECT 1 FROM queries q WHERE q.id = query_id))
    OR (app_scope() = 'customer' AND visibility = 'public'
        AND (EXISTS (SELECT 1 FROM queries q WHERE q.id = query_id) OR app_company_ok(company_id)))
  )
  WITH CHECK (
    app_scope() IN ('system','staff')
    OR (app_scope() = 'customer' AND visibility = 'public')
  );

-- companies ------------------------------------------------------------------
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies FORCE ROW LEVEL SECURITY;
CREATE POLICY companies_scope ON companies
  USING (app_scope() IN ('system','staff') OR (app_scope() = 'customer' AND app_company_ok(id)))
  WITH CHECK (app_scope() IN ('system','staff') OR (app_scope() = 'customer' AND app_company_ok(id)));

-- contacts: a customer sees themself and colleagues of companies they belong to
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts FORCE ROW LEVEL SECURITY;
CREATE POLICY contacts_scope ON contacts
  USING (
    app_scope() IN ('system','staff')
    OR (app_scope() = 'customer' AND (id::text = current_setting('app.contact', true)
        OR EXISTS (SELECT 1 FROM company_contacts cc WHERE cc.contact_id = id AND app_company_ok(cc.company_id))))
  );

ALTER TABLE company_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_contacts FORCE ROW LEVEL SECURITY;
CREATE POLICY company_contacts_scope ON company_contacts
  USING (app_scope() IN ('system','staff') OR (app_scope() = 'customer' AND app_company_ok(company_id)));

-- customer-owned records ------------------------------------------------------
ALTER TABLE assist_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE assist_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY assist_sessions_scope ON assist_sessions
  USING (app_scope() IN ('system','staff')
         OR (app_scope() = 'customer' AND contact_id::text = current_setting('app.contact', true)));

ALTER TABLE satisfaction_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE satisfaction_responses FORCE ROW LEVEL SECURITY;
CREATE POLICY satisfaction_scope ON satisfaction_responses
  USING (app_scope() IN ('system','staff')
         OR (app_scope() = 'customer' AND EXISTS (SELECT 1 FROM queries q WHERE q.id = query_id)));

-- knowledge: customers only ever read published, customer-facing articles -----
ALTER TABLE knowledge_articles ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_articles FORCE ROW LEVEL SECURITY;
CREATE POLICY knowledge_scope ON knowledge_articles
  USING (app_scope() IN ('system','staff')
         OR (app_scope() IN ('customer','public') AND state = 'published' AND audience_scope IN ('public','customer')
             AND (audience_scope = 'public' OR app_scope() = 'customer')));

-- findings are staff-only and port/department scoped ---------------------------
ALTER TABLE findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE findings FORCE ROW LEVEL SECURITY;
CREATE POLICY findings_scope ON findings
  USING (app_scope() = 'system'
         OR (app_scope() = 'staff' AND (port_code IS NULL OR app_port_ok(port_code)) AND app_dept_ok(department_id)));
