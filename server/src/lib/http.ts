import crypto from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { PUBLIC, withScope, withSystem, type Scope, type Tx } from '../db/pool.js';
import { apiClientPrincipal, customerCtx, loadCustomer, loadStaff, staffCtx, verifyToken } from '../services/auth.js';
import { can, type Ctx } from './context.js';
import { forbidden, HttpError, unauthorized } from './errors.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      ctx: Ctx;
    }
  }
}

export const ah = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => { fn(req, res, next).catch(next); };

/** Resolve the caller: staff bearer token, customer bearer token, API key, or anonymous public. */
export const authenticate: RequestHandler = (req, _res, next) => {
  const meta = {
    requestId: (req.headers['x-request-id'] as string) || crypto.randomUUID(),
    ip: (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() || req.socket.remoteAddress || undefined,
    userAgent: req.headers['user-agent']?.slice(0, 300),
  };
  const anon: Ctx = { actorType: 'system', actorId: null, actorName: 'anonymous', scope: PUBLIC, ...meta };
  const header = req.headers.authorization;
  const apiKey = req.headers['x-api-key'] as string | undefined;
  (async () => {
    if (apiKey) {
      const p = await withSystem((tx) => apiClientPrincipal(tx, apiKey));
      if (!p) throw unauthorized('Invalid API key');
      req.ctx = { ...staffCtx(p, meta), actorType: 'api' };
      return;
    }
    if (!header?.startsWith('Bearer ')) { req.ctx = anon; return; }
    const claims = verifyToken(header.slice(7));
    if (claims.realm === 'staff') {
      const s = await withSystem((tx) => loadStaff(tx, claims.sub));
      if (!s) throw unauthorized('Your account is no longer active');
      req.ctx = staffCtx(s, meta);
    } else {
      const c = await withSystem((tx) => loadCustomer(tx, claims.sub));
      if (!c) throw unauthorized('Your account is no longer active');
      req.ctx = customerCtx(c, meta);
    }
  })().then(() => next(), next);
};

export const isStaff = (ctx: Ctx) => ctx.actorType === 'user' || ctx.actorType === 'api';

/** Require a staff principal, optionally holding any one of the given permissions. */
export const staff = (...permissions: string[]): RequestHandler => (req, _res, next) => {
  if (!isStaff(req.ctx)) return next(req.ctx.actorType === 'contact' ? forbidden() : unauthorized());
  if (permissions.length && !permissions.some((p) => can(req.ctx, p))) return next(forbidden());
  next();
};

export const customer: RequestHandler = (req, _res, next) => {
  if (req.ctx.actorType !== 'contact') return next(unauthorized('Sign in to the customer portal'));
  next();
};

/** Run the handler's database work under the caller's own data scope. */
export const db = <T>(req: Request, fn: (tx: Tx) => Promise<T>, scope: Scope = req.ctx.scope) => withScope(scope, fn);

export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, details: err.details });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body' });
  if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File is too large' });
  // PostgreSQL errors that are the caller's fault
  if (err?.code === '22P02') return res.status(400).json({ error: 'Invalid identifier or value' });
  if (err?.code === '23505') return res.status(409).json({ error: 'That record already exists', details: err.detail });
  if (err?.code === '23503') return res.status(400).json({ error: 'A referenced record does not exist', details: err.detail });
  if (err?.code === '23514') return res.status(400).json({ error: 'A value is not allowed', details: err.constraint });
  if (err?.code === '42501') return res.status(403).json({ error: 'You do not have access to that record' });
  console.error(`[${req.ctx?.requestId ?? '-'}]`, err);
  res.status(500).json({ error: 'Something went wrong. The incident has been logged.', request_id: req.ctx?.requestId });
}

export const qp = (req: Request) => req.query as Record<string, any>;
