import crypto from 'node:crypto';
import { config } from '../config.js';

/**
 * Microsoft Entra ID single sign-on for Namport staff (OIDC authorization-code flow with PKCE).
 * The Authority's own MFA and conditional-access policies are applied by Entra before a code is
 * issued, so the CRM inherits those controls rather than creating a parallel set.
 */

const authority = () => `https://login.microsoftonline.com/${config.entra.tenantId}/v2.0`;
let jwks: { at: number; keys: any[] } | null = null;

export function authorizationUrl(state: string, nonce: string, codeVerifier: string) {
  const challenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const p = new URLSearchParams({
    client_id: config.entra.clientId, response_type: 'code', redirect_uri: config.entra.redirectUri,
    response_mode: 'query', scope: 'openid profile email offline_access', state, nonce,
    code_challenge: challenge, code_challenge_method: 'S256',
  });
  return `https://login.microsoftonline.com/${config.entra.tenantId}/oauth2/v2.0/authorize?${p}`;
}

async function keys() {
  if (jwks && Date.now() - jwks.at < 3_600_000) return jwks.keys;
  const meta = (await (await fetch(`${authority()}/.well-known/openid-configuration`)).json()) as { jwks_uri: string };
  const set = (await (await fetch(meta.jwks_uri)).json()) as { keys: any[] };
  jwks = { at: Date.now(), keys: set.keys };
  return set.keys;
}

export interface EntraIdentity { oid: string; email: string; name: string; tid: string }

/** Exchange the code, then verify the ID token's signature, issuer, audience, expiry and nonce. */
export async function redeemCode(code: string, codeVerifier: string, nonce: string): Promise<EntraIdentity> {
  const r = await fetch(`https://login.microsoftonline.com/${config.entra.tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    body: new URLSearchParams({
      client_id: config.entra.clientId, client_secret: config.entra.clientSecret, grant_type: 'authorization_code',
      code, redirect_uri: config.entra.redirectUri, code_verifier: codeVerifier,
    }),
  });
  if (!r.ok) throw new Error(`Entra token exchange failed (${r.status})`);
  const { id_token } = (await r.json()) as { id_token: string };
  const [h, p, s] = id_token.split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  const jwk = (await keys()).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('Unknown signing key');
  const ok = crypto.createVerify('RSA-SHA256').update(`${h}.${p}`).verify(crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(s, 'base64url'));
  if (!ok) throw new Error('Invalid ID token signature');
  if (claims.aud !== config.entra.clientId) throw new Error('ID token audience mismatch');
  if (claims.tid !== config.entra.tenantId) throw new Error('ID token tenant mismatch');
  if (claims.iss !== `https://login.microsoftonline.com/${config.entra.tenantId}/v2.0`) throw new Error('ID token issuer mismatch');
  if (claims.exp * 1000 < Date.now()) throw new Error('ID token expired');
  if (claims.nonce !== nonce) throw new Error('ID token nonce mismatch');
  return { oid: claims.oid, email: (claims.email ?? claims.preferred_username ?? '').toLowerCase(), name: claims.name ?? '', tid: claims.tid };
}
