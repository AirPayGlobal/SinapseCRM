import crypto from 'node:crypto';
import { Router } from 'express';
import { config, isEntraConfigured } from '../config.js';
import { badRequest } from '../lib/errors.js';
import { ah } from '../lib/http.js';
import { staffPasswordLogin, staffSsoLogin } from '../services/auth.js';
import { authorizationUrl, redeemCode } from '../integrations/entra.js';
import { logIntegration } from '../integrations/fabric.js';

export const authRouter = Router();
const pending = new Map<string, { nonce: string; verifier: string; at: number }>();
const meta = (req: any) => ({ requestId: req.ctx.requestId, ip: req.ctx.ip, userAgent: req.ctx.userAgent });

authRouter.get('/methods', (_req, res) => res.json({ entra: isEntraConfigured(), local: config.allowLocalPasswordLogin }));

authRouter.post('/login', ah(async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) throw badRequest('Email and password are required');
  res.json(await staffPasswordLogin(email, password, meta(req)));
}));

/** Entra ID SSO: redirect to Microsoft, then back to the web app with a session token in the fragment. */
authRouter.get('/entra/start', (req, res) => {
  if (!isEntraConfigured()) return res.status(404).json({ error: 'Microsoft Entra ID sign-in is not configured' });
  const state = crypto.randomBytes(16).toString('base64url');
  const nonce = crypto.randomBytes(16).toString('base64url');
  const verifier = crypto.randomBytes(32).toString('base64url');
  for (const [k, v] of pending) if (Date.now() - v.at > 10 * 60_000) pending.delete(k);
  pending.set(state, { nonce, verifier, at: Date.now() });
  res.redirect(authorizationUrl(state, nonce, verifier));
});

authRouter.get('/entra/callback', ah(async (req, res) => {
  const { code, state, error, error_description } = req.query as Record<string, string>;
  if (error) return res.redirect(`${config.publicUrl}/login#error=${encodeURIComponent(error_description ?? error)}`);
  const p = state ? pending.get(state) : undefined;
  if (!p || !code) return res.redirect(`${config.publicUrl}/login#error=${encodeURIComponent('Sign-in session expired, please try again')}`);
  pending.delete(state);
  try {
    const identity = await redeemCode(code, p.verifier, p.nonce);
    await logIntegration(null, { connector: 'entra', direction: 'inbound', operation: 'oidc.login', status: 'success', correlationId: identity.oid });
    const { token } = await staffSsoLogin(identity, meta(req));
    res.redirect(`${config.publicUrl}/login#token=${token}`);
  } catch (e) {
    await logIntegration(null, { connector: 'entra', direction: 'inbound', operation: 'oidc.login', status: 'failed', error: (e as Error).message });
    res.redirect(`${config.publicUrl}/login#error=${encodeURIComponent((e as Error).message)}`);
  }
}));
