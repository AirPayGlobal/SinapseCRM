-- Secrets the application generates for itself (e.g. the session-signing key when JWT_SECRET is not
-- provided). Deliberately not granted to the sinapse_app role and never exposed through the API.
CREATE TABLE IF NOT EXISTS app_secrets (
  key         text PRIMARY KEY,
  value       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON app_secrets FROM PUBLIC;
