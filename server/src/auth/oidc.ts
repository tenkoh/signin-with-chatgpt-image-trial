import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Config } from '../config.js';
import { isRecord } from '../record.js';
import type { AuthAttempt, IdentityClaims } from './state.js';
import type { Registration } from './registration.js';
import { s256 } from './pkce.js';

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in: number;
  scope?: string;
  token_type: 'Bearer';
}

export class TokenEndpointError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`token endpoint returned ${status}`);
  }
}

export class IdTokenError extends Error {
  constructor(readonly detail: string) {
    super(detail);
  }
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export function buildAuthorizeUrl(cfg: Config, reg: Registration, attempt: AuthAttempt): string {
  if (!attempt.redirectUri.startsWith('http://127.0.0.1:')) {
    throw new Error('redirect_uri must use the 127.0.0.1 loopback host');
  }
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: attempt.clientId,
    redirect_uri: attempt.redirectUri,
    scope: cfg.scopes.join(' '),
    resource: cfg.resource,
    state: attempt.state,
    nonce: attempt.nonce,
    code_challenge: s256(attempt.codeVerifier),
    code_challenge_method: 'S256',
    ext_agent_host_id: reg.hostId,
  });
  if (attempt.clientId === 'dynamic_agent_client') {
    params.set('agent_name_hint', cfg.agentName);
  }
  return `${cfg.authorizeUrl}?${params.toString()}`;
}

export async function exchangeCode(
  cfg: Config,
  attempt: AuthAttempt,
  code: string,
): Promise<TokenResponse> {
  const tok = await postToken(
    cfg.tokenUrl,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: attempt.redirectUri,
      client_id: attempt.clientId,
      code_verifier: attempt.codeVerifier,
      resource: cfg.resource,
    }),
  );
  if (!tok.id_token) throw new TokenEndpointError(200, 'token response omitted id_token');
  return tok;
}

export async function refreshTokens(
  cfg: Config,
  clientId: string,
  refreshToken: string,
): Promise<TokenResponse> {
  return postToken(
    cfg.tokenUrl,
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: refreshToken,
      resource: cfg.resource,
    }),
  );
}

export async function verifyIdToken(
  cfg: Config,
  idToken: string,
  clientId: string,
  nonce: string | undefined,
): Promise<IdentityClaims> {
  try {
    const { payload } = await jwtVerify(idToken, jwksFor(cfg.jwksUrl), {
      issuer: cfg.issuer,
      audience: clientId,
    });
    if (nonce !== undefined && payload.nonce !== nonce) throw new IdTokenError('nonce mismatch');
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new IdTokenError('id token is missing sub');
    }
    const scopes =
      typeof payload.scope === 'string' ? payload.scope.split(/\s+/).filter(Boolean) : [];
    const claims: IdentityClaims = { sub: payload.sub, scopes };
    if (typeof payload.email === 'string' && payload.email.length > 0) claims.email = payload.email;
    const plan = readPlan(payload);
    if (plan) claims.planType = plan;
    return claims;
  } catch (err) {
    if (err instanceof IdTokenError) throw err;
    const message = err instanceof Error ? err.message : 'id token rejected';
    throw new IdTokenError(
      message.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-jwt]'),
    );
  }
}

export function hasDirectUseScope(tok: TokenResponse, claims: IdentityClaims): boolean {
  const scopes = tok.scope === undefined ? claims.scopes : tok.scope.split(/\s+/).filter(Boolean);
  return scopes.includes('chatgpt.tokens.use.direct');
}

export function grantedScopes(tok: TokenResponse, claims: IdentityClaims): string[] {
  if (tok.scope === undefined) return claims.scopes;
  return tok.scope.split(/\s+/).filter(Boolean);
}

function jwksFor(url: string): ReturnType<typeof createRemoteJWKSet> {
  const cached = jwksCache.get(url);
  if (cached) return cached;
  const created = createRemoteJWKSet(new URL(url));
  jwksCache.set(url, created);
  return created;
}

async function postToken(url: string, form: URLSearchParams): Promise<TokenResponse> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: form,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'token request failed';
    throw new TokenEndpointError(0, message);
  }
  const text = await res.text();
  if (!res.ok) throw new TokenEndpointError(res.status, text.slice(0, 2000));
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    throw new TokenEndpointError(res.status, 'token endpoint returned non-JSON');
  }
  return parseTokenResponse(json);
}

function parseTokenResponse(raw: unknown): TokenResponse {
  if (!isRecord(raw) || typeof raw.access_token !== 'string' || raw.access_token.length === 0) {
    throw new TokenEndpointError(200, 'token response omitted access_token');
  }
  if (
    typeof raw.expires_in !== 'number' ||
    !Number.isFinite(raw.expires_in) ||
    raw.expires_in < 0
  ) {
    throw new TokenEndpointError(200, 'token response omitted expires_in');
  }
  if (raw.token_type !== undefined && raw.token_type !== 'Bearer' && raw.token_type !== 'bearer') {
    throw new TokenEndpointError(200, 'token response token_type was not Bearer');
  }
  const tok: TokenResponse = {
    access_token: raw.access_token,
    expires_in: raw.expires_in,
    token_type: 'Bearer',
  };
  if (typeof raw.refresh_token === 'string' && raw.refresh_token.length > 0)
    tok.refresh_token = raw.refresh_token;
  if (typeof raw.id_token === 'string' && raw.id_token.length > 0) tok.id_token = raw.id_token;
  if (typeof raw.scope === 'string') tok.scope = raw.scope;
  return tok;
}

function readPlan(payload: JWTPayload): string | undefined {
  const auth = payload['https://api.openai.com/auth'];
  if (isRecord(auth)) {
    const nested = auth.chatgpt_plan_type ?? auth.plan_type;
    if (typeof nested === 'string' && nested.length > 0) return nested;
  }
  const direct = payload['chatgpt_plan_type'] ?? payload['plan_type'];
  if (typeof direct === 'string' && direct.length > 0) return direct;
  return undefined;
}
