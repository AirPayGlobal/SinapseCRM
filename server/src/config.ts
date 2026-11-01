import path from 'node:path';

const env = process.env;

export const config = {
  port: Number(env.PORT ?? 4000),
  databaseUrl: env.DATABASE_URL ?? 'postgres://postgres@localhost:5432/sinapse',
  /** Reporting reads a replica so dashboards never contend with the agent console. Falls back to primary. */
  analyticsDatabaseUrl: env.ANALYTICS_DATABASE_URL ?? env.DATABASE_URL ?? 'postgres://postgres@localhost:5432/sinapse',
  /** Role assumed for every request so that row-level security applies. Empty disables SET ROLE. */
  dbAppRole: env.DB_APP_ROLE ?? 'sinapse_app',
  jwtSecret: env.JWT_SECRET ?? 'dev-only-change-me',
  publicUrl: env.PUBLIC_URL ?? 'http://localhost:5173',
  objectStorageDir: env.OBJECT_STORAGE_DIR ?? path.resolve(process.cwd(), 'storage'),
  maxUploadBytes: Number(env.MAX_UPLOAD_BYTES ?? 25 * 1024 * 1024),
  runScheduler: env.RUN_SCHEDULER !== 'false',
  schedulerIntervalMs: Number(env.SCHEDULER_INTERVAL_MS ?? 30_000),
  scimToken: env.SCIM_TOKEN ?? '',
  entra: {
    tenantId: env.ENTRA_TENANT_ID ?? '',
    clientId: env.ENTRA_CLIENT_ID ?? '',
    clientSecret: env.ENTRA_CLIENT_SECRET ?? '',
    redirectUri: env.ENTRA_REDIRECT_URI ?? 'http://localhost:4000/api/auth/entra/callback',
  },
  graph: {
    mailbox: env.GRAPH_SHARED_MAILBOX ?? '',      // e.g. customercare@namport.com.na
  },
  teamsWebhookUrl: env.TEAMS_WEBHOOK_URL ?? '',
  sap: {
    baseUrl: env.SAP_ODATA_BASE_URL ?? '',
    username: env.SAP_USERNAME ?? '',
    password: env.SAP_PASSWORD ?? '',
  },
  clamav: { host: env.CLAMAV_HOST ?? '', port: Number(env.CLAMAV_PORT ?? 3310) },
  /** Optional LLM used only to phrase answers from retrieved, approved passages. */
  anthropicApiKey: env.ANTHROPIC_API_KEY ?? '',
  assistModel: env.ASSIST_MODEL ?? 'claude-opus-5-5',
  allowLocalPasswordLogin: env.ALLOW_LOCAL_LOGIN !== 'false',
};

export const isEntraConfigured = () => Boolean(config.entra.tenantId && config.entra.clientId && config.entra.clientSecret);
