import type { Config } from '../config.js';
import type { PublicAuthStatus } from '../public-types.js';
import {
  buildAuthorizeUrl,
  exchangeCode,
  grantedScopes,
  hasDirectUseScope,
  IdTokenError,
  refreshTokens,
  TokenEndpointError,
  verifyIdToken,
} from './oidc.js';
import { randomB64url } from './pkce.js';
import { saveIssuedClientId, type Registration } from './registration.js';
import {
  reduce,
  toPublic,
  type AuthAttempt,
  type AuthError,
  type AuthState,
  type TokenSession,
} from './state.js';

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
const REFRESH_SKEW_MS = 60_000;
const DYNAMIC_CLIENT = 'dynamic_agent_client';

export class NotSignedIn extends Error {
  constructor() {
    super('not signed in');
  }
}

export interface CallbackQuery {
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
  client_id?: string;
}

export class AuthMachine {
  private state: AuthState = { tag: 'signed_out' };
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly cfg: Config,
    private registration: Registration,
  ) {}

  start(): string {
    const attempt: AuthAttempt = {
      state: randomB64url(),
      nonce: randomB64url(),
      codeVerifier: randomB64url(),
      redirectUri: `http://127.0.0.1:${this.cfg.port}/auth/callback`,
      clientId: this.registration.clientId ?? DYNAMIC_CLIENT,
      startedAt: Date.now(),
    };
    this.state = reduce(this.state, { type: 'START', attempt });
    this.armTimeout();
    return buildAuthorizeUrl(this.cfg, this.registration, attempt);
  }

  async handleCallback(query: CallbackQuery): Promise<AuthState> {
    this.clearTimer();
    const code = query.code;
    const denied = callbackError(query);
    const next = reduce(this.state, {
      type: 'CALLBACK',
      state: query.state ?? '',
      ...(code ? { code } : {}),
      ...(denied ? { error: denied } : {}),
    });
    this.state = next;
    if (next.tag !== 'exchanging' || !code) return this.state;

    const resolved = resolveIssuedClient(next.attempt.clientId, query.client_id);
    if (!resolved.ok) {
      this.state = reduce(this.state, { type: 'FAIL', error: resolved.error });
      return this.state;
    }
    try {
      if (resolved.persist) {
        await saveIssuedClientId(this.cfg.stateDir, resolved.clientId);
        this.registration = { ...this.registration, clientId: resolved.clientId };
      }
      const attempt = { ...next.attempt, clientId: resolved.clientId };
      this.state = { tag: 'exchanging', attempt };
      const tok = await exchangeCode(this.cfg, attempt, code);
      const verified = await verifyIdToken(
        this.cfg,
        tok.id_token ?? '',
        attempt.clientId,
        attempt.nonce,
      );
      const scopes = grantedScopes(tok, verified);
      const claims = { ...verified, scopes };
      if (!hasDirectUseScope(tok, claims)) {
        this.state = reduce(this.state, {
          type: 'FAIL',
          error: { code: 'missing_scope', scope: 'chatgpt.tokens.use.direct' },
        });
        return this.state;
      }
      const session: TokenSession = {
        accessToken: tok.access_token,
        expiresAt: Date.now() + tok.expires_in * 1000,
        claims,
      };
      if (tok.refresh_token) session.refreshToken = tok.refresh_token;
      this.state = reduce(this.state, { type: 'EXCHANGED', session });
      return this.state;
    } catch (err) {
      if (this.state.tag === 'exchanging') {
        this.state = reduce(this.state, { type: 'FAIL', error: toExchangeError(err) });
      }
      return this.state;
    }
  }

  async accessToken(): Promise<string> {
    const current = this.state;
    if (current.tag === 'refreshing') return (await current.inflight).accessToken;
    if (current.tag !== 'signed_in') throw new NotSignedIn();
    if (current.session.expiresAt - Date.now() >= REFRESH_SKEW_MS)
      return current.session.accessToken;

    let resolveInflight: (session: TokenSession) => void = () => {};
    let rejectInflight: (err: unknown) => void = () => {};
    const inflight = new Promise<TokenSession>((resolve, reject) => {
      resolveInflight = resolve;
      rejectInflight = reject;
    });
    this.state = reduce(current, { type: 'REFRESH_BEGIN', inflight });
    void this.runRefresh(current.session, resolveInflight, rejectInflight);
    return (await inflight).accessToken;
  }

  status(): PublicAuthStatus {
    return toPublic(this.state);
  }

  signOut(): void {
    this.clearTimer();
    this.state = reduce(this.state, { type: 'SIGN_OUT' });
  }

  private async runRefresh(
    previous: TokenSession,
    resolve: (session: TokenSession) => void,
    reject: (err: unknown) => void,
  ): Promise<void> {
    try {
      const session = await this.fetchRefresh(previous);
      this.state = reduce(this.state, { type: 'REFRESHED', session });
      if (this.state.tag !== 'signed_in') {
        reject(new NotSignedIn());
        return;
      }
      resolve(this.state.session);
    } catch (err) {
      if (this.state.tag === 'refreshing') {
        this.state = reduce(this.state, { type: 'FAIL', error: toRefreshError(err) });
      }
      reject(err instanceof NotSignedIn ? err : new NotSignedIn());
    }
  }

  private async fetchRefresh(previous: TokenSession): Promise<TokenSession> {
    const clientId = this.registration.clientId;
    if (!clientId || !previous.refreshToken) {
      throw new TokenEndpointError(0, 'missing refresh token or issued client_id');
    }
    const tok = await refreshTokens(this.cfg, clientId, previous.refreshToken);
    let claims = previous.claims;
    if (tok.id_token) {
      const verified = await verifyIdToken(this.cfg, tok.id_token, clientId, undefined);
      const scopes = grantedScopes(tok, verified);
      claims = { ...verified, scopes: scopes.length > 0 ? scopes : previous.claims.scopes };
    } else if (tok.scope !== undefined) {
      claims = { ...claims, scopes: grantedScopes(tok, claims) };
    }
    if (!claims.scopes.includes('chatgpt.tokens.use.direct')) {
      throw new MissingDirectScope();
    }
    const session: TokenSession = {
      accessToken: tok.access_token,
      expiresAt: Date.now() + tok.expires_in * 1000,
      claims,
    };
    if (tok.refresh_token) session.refreshToken = tok.refresh_token;
    else if (previous.refreshToken) session.refreshToken = previous.refreshToken;
    return session;
  }

  private armTimeout(): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.state = reduce(this.state, { type: 'TIMEOUT' });
    }, CALLBACK_TIMEOUT_MS);
    this.timer.unref();
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

class MissingDirectScope extends Error {
  constructor() {
    super('missing chatgpt.tokens.use.direct');
  }
}

function callbackError(query: CallbackQuery): string | undefined {
  const parts = [query.error, query.error_description].filter(
    (part): part is string => !!part && part.length > 0,
  );
  if (parts.length === 0) return undefined;
  return parts.join(': ');
}

function resolveIssuedClient(
  pendingClientId: string,
  callbackClientId: string | undefined,
): { ok: true; clientId: string; persist: boolean } | { ok: false; error: AuthError } {
  if (pendingClientId === DYNAMIC_CLIENT) {
    if (!callbackClientId?.startsWith('oaiapp_')) {
      return {
        ok: false,
        error: {
          code: 'authorize_denied',
          detail: 'registration callback omitted the issued client_id',
        },
      };
    }
    return { ok: true, clientId: callbackClientId, persist: true };
  }
  if (callbackClientId && callbackClientId !== pendingClientId) {
    return {
      ok: false,
      error: {
        code: 'authorize_denied',
        detail: 'callback client_id does not match this sign-in attempt',
      },
    };
  }
  return { ok: true, clientId: pendingClientId, persist: false };
}

function toExchangeError(err: unknown): AuthError {
  if (err instanceof TokenEndpointError) {
    return { code: 'token_exchange_failed', status: err.status, body: err.body.slice(0, 2000) };
  }
  if (err instanceof IdTokenError) return { code: 'id_token_invalid', detail: err.detail };
  const message = err instanceof Error ? err.message : 'token exchange failed';
  return { code: 'token_exchange_failed', status: 0, body: message.slice(0, 500) };
}

function toRefreshError(err: unknown): AuthError {
  if (err instanceof MissingDirectScope) {
    return { code: 'missing_scope', scope: 'chatgpt.tokens.use.direct' };
  }
  if (err instanceof IdTokenError) return { code: 'id_token_invalid', detail: err.detail };
  if (err instanceof TokenEndpointError) {
    return { code: 'refresh_failed', status: err.status, body: err.body.slice(0, 2000) };
  }
  return { code: 'refresh_failed', status: 0, body: 'refresh failed' };
}
