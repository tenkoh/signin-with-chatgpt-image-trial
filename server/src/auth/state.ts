import type { PublicAuthErrorCode, PublicAuthStatus } from '../public-types.js';

export type AuthState =
  | { tag: 'signed_out' }
  | { tag: 'awaiting_callback'; attempt: AuthAttempt }
  | { tag: 'exchanging'; attempt: AuthAttempt }
  | { tag: 'signed_in'; session: TokenSession }
  | { tag: 'refreshing'; session: TokenSession; inflight: Promise<TokenSession> }
  | { tag: 'failed'; error: AuthError; at: number };

export interface AuthAttempt {
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
  startedAt: number;
}

export interface TokenSession {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  claims: IdentityClaims;
}

export interface IdentityClaims {
  sub: string;
  email?: string;
  planType?: string;
  scopes: string[];
}

export type AuthError =
  | { code: 'state_mismatch' }
  | { code: 'authorize_denied'; detail: string }
  | { code: 'callback_timeout' }
  | { code: 'token_exchange_failed'; status: number; body: string }
  | { code: 'id_token_invalid'; detail: string }
  | { code: 'missing_scope'; scope: 'chatgpt.tokens.use.direct' }
  | { code: 'refresh_failed'; status: number; body: string };

export type AuthEvent =
  | { type: 'START'; attempt: AuthAttempt }
  | { type: 'CALLBACK'; state: string; code?: string; error?: string }
  | { type: 'EXCHANGED'; session: TokenSession }
  | { type: 'FAIL'; error: AuthError }
  | { type: 'REFRESH_BEGIN'; inflight: Promise<TokenSession> }
  | { type: 'REFRESHED'; session: TokenSession }
  | { type: 'TIMEOUT' }
  | { type: 'SIGN_OUT' };

export function reduce(state: AuthState, event: AuthEvent): AuthState {
  switch (event.type) {
    case 'START':
      return { tag: 'awaiting_callback', attempt: event.attempt };
    case 'SIGN_OUT':
      return { tag: 'signed_out' };
    case 'CALLBACK':
      return applyCallback(state, event);
    case 'TIMEOUT':
      if (state.tag !== 'awaiting_callback') return state;
      return fail({ code: 'callback_timeout' });
    case 'EXCHANGED':
      if (state.tag !== 'exchanging') return state;
      return { tag: 'signed_in', session: event.session };
    case 'FAIL':
      if (state.tag !== 'exchanging' && state.tag !== 'refreshing') return state;
      return fail(event.error);
    case 'REFRESH_BEGIN':
      if (state.tag !== 'signed_in') return state;
      return { tag: 'refreshing', session: state.session, inflight: event.inflight };
    case 'REFRESHED':
      if (state.tag !== 'refreshing') return state;
      return { tag: 'signed_in', session: event.session };
  }
}

function applyCallback(
  state: AuthState,
  event: Extract<AuthEvent, { type: 'CALLBACK' }>,
): AuthState {
  if (state.tag !== 'awaiting_callback') return state;
  if (event.state !== state.attempt.state) return fail({ code: 'state_mismatch' });
  if (event.error) return fail({ code: 'authorize_denied', detail: event.error });
  if (!event.code) return fail({ code: 'authorize_denied', detail: 'missing authorization code' });
  return { tag: 'exchanging', attempt: state.attempt };
}

function fail(error: AuthError): AuthState {
  return { tag: 'failed', error, at: Date.now() };
}

export function toPublic(state: AuthState, now = Date.now()): PublicAuthStatus {
  switch (state.tag) {
    case 'signed_out':
      return { auth: 'signed_out' };
    case 'awaiting_callback':
    case 'exchanging':
      return { auth: 'pending' };
    case 'signed_in':
    case 'refreshing':
      return signedInStatus(state.session, now);
    case 'failed':
      return failedStatus(state.error);
  }
}

function signedInStatus(session: TokenSession, now: number): PublicAuthStatus {
  const status: PublicAuthStatus = {
    auth: 'signed_in',
    scopesOk: true,
    expiresInSec: Math.max(0, Math.floor((session.expiresAt - now) / 1000)),
  };
  if (session.claims.email) status.email = session.claims.email;
  if (session.claims.planType) status.planType = session.claims.planType;
  return status;
}

function failedStatus(error: AuthError): PublicAuthStatus {
  const detail = publicDetail(error);
  const status: PublicAuthStatus = {
    auth: 'failed',
    error: error.code satisfies PublicAuthErrorCode,
  };
  if (detail) status.detail = detail;
  return status;
}

function publicDetail(error: AuthError): string | undefined {
  switch (error.code) {
    case 'authorize_denied':
    case 'id_token_invalid':
      return redactSecrets(error.detail);
    case 'token_exchange_failed':
    case 'refresh_failed':
      return `HTTP ${error.status}: ${redactSecrets(error.body)}`;
    case 'missing_scope':
      return error.scope;
    case 'state_mismatch':
    case 'callback_timeout':
      return undefined;
  }
}

function redactSecrets(value: string): string {
  return value
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-jwt]')
    .slice(0, 240);
}
