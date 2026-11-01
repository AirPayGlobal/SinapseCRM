import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { config } from './config.js';
import { pool } from './db/pool.js';
import { authenticate, errorHandler } from './lib/http.js';
import { adminRouter } from './routes/admin.js';
import { authRouter } from './routes/auth.js';
import { customersRouter } from './routes/customers.js';
import { findingsRouter } from './routes/findings.js';
import { integrationsRouter } from './routes/integrations.js';
import { kbRouter } from './routes/kb.js';
import { meRouter } from './routes/me.js';
import { portRouter } from './routes/port.js';
import { portalRouter } from './routes/portal.js';
import { attachmentsRouter, queriesRouter } from './routes/queries.js';
import { reportsRouter } from './routes/reports.js';
import { scimRouter } from './routes/scim.js';
import { openApiDocument } from './openapi.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({ origin: true, credentials: false }));
  app.use(express.json({ limit: '2mb', type: ['application/json', 'application/scim+json'] }));

  app.get('/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok', time: new Date().toISOString() });
    } catch {
      res.status(503).json({ status: 'database unavailable' });
    }
  });

  app.use('/scim/v2', (req, _res, next) => { (req as any).ctx = { requestId: req.headers['x-request-id'], ip: req.ip }; next(); }, scimRouter);

  const api = express.Router();
  api.use(authenticate);
  api.get('/openapi.json', (_req, res) => res.json(openApiDocument()));
  api.use('/auth', authRouter);
  api.use('/me', meRouter);
  api.use('/queries', queriesRouter);
  api.use('/attachments', attachmentsRouter);
  api.use('/customers', customersRouter);
  api.use('/findings', findingsRouter);
  api.use('/kb', kbRouter);
  api.use('/reports', reportsRouter);
  api.use('/port', portRouter);
  api.use('/admin', adminRouter);
  api.use('/integrations', integrationsRouter);
  api.use('/portal', portalRouter);
  api.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use('/api/v1', api);

  // Serve the built web application (agent console, portal, widget) when present.
  const webDist = path.resolve(here, '../../web/dist');
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api|scim|health).*/, (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}

export { config };
