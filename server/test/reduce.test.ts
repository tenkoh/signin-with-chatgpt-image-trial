import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  reduce,
  toPublic,
  type AuthAttempt,
  type AuthState,
  type TokenSession,
} from '../src/auth/state.js';

const attempt: AuthAttempt = {
  state: 'csrf-secret',
  nonce: 'nonce-secret',
  codeVerifier: 'verifier-secret',
  redirectUri: 'http://127.0.0.1:1455/auth/callback',
  clientId: 'dynamic_agent_client',
  startedAt: 1,
};

const session: TokenSession = {
  accessToken: 'secret-access-token',
  refreshToken: 'secret-refresh-token',
  expiresAt: 1_700_000_060_000,
  claims: {
    sub: 'user_1',
    email: 'a@example.com',
    planType: 'plus',
    scopes: ['openid', 'chatgpt.tokens.use.direct'],
  },
};

const signedOut: AuthState = { tag: 'signed_out' };

describe('reduce', () => {
  it('starts an attempt from signed out and from failed', () => {
    const awaiting = reduce(signedOut, { type: 'START', attempt });
    assert.equal(awaiting.tag, 'awaiting_callback');
    const failed = reduce(awaiting, { type: 'TIMEOUT' });
    assert.deepEqual(failed.tag === 'failed' ? failed.error : undefined, {
      code: 'callback_timeout',
    });
    assert.equal(reduce(failed, { type: 'START', attempt }).tag, 'awaiting_callback');
  });

  it('moves a matching callback into exchanging and rejects a bad callback', () => {
    const awaiting = reduce(signedOut, { type: 'START', attempt });
    const exchanging = reduce(awaiting, {
      type: 'CALLBACK',
      state: attempt.state,
      code: 'auth-code',
    });
    assert.equal(exchanging.tag, 'exchanging');
    const mismatch = reduce(awaiting, { type: 'CALLBACK', state: 'other', code: 'auth-code' });
    assert.equal(mismatch.tag, 'failed');
    assert.equal(mismatch.tag === 'failed' ? mismatch.error.code : '', 'state_mismatch');
    const denied = reduce(awaiting, {
      type: 'CALLBACK',
      state: attempt.state,
      error: 'access_denied',
    });
    assert.equal(denied.tag === 'failed' ? denied.error.code : '', 'authorize_denied');
  });

  it('ignores a callback that arrives when no attempt is waiting', () => {
    const ignored = reduce(signedOut, {
      type: 'CALLBACK',
      state: attempt.state,
      code: 'auth-code',
    });
    assert.deepEqual(ignored, signedOut);
  });

  it('signs in only from exchanging, then refreshes, and signs out from any state', () => {
    const exchanging = reduce(reduce(signedOut, { type: 'START', attempt }), {
      type: 'CALLBACK',
      state: attempt.state,
      code: 'auth-code',
    });
    assert.equal(reduce(signedOut, { type: 'EXCHANGED', session }).tag, 'signed_out');
    const signedIn = reduce(exchanging, { type: 'EXCHANGED', session });
    assert.equal(signedIn.tag, 'signed_in');
    const inflight = Promise.resolve(session);
    const refreshing = reduce(signedIn, { type: 'REFRESH_BEGIN', inflight });
    assert.equal(refreshing.tag, 'refreshing');
    assert.equal(reduce(signedIn, { type: 'REFRESHED', session }).tag, 'signed_in');
    const replaced = reduce(refreshing, {
      type: 'REFRESHED',
      session: { ...session, accessToken: 'next-access' },
    });
    assert.equal(replaced.tag === 'signed_in' ? replaced.session.accessToken : '', 'next-access');
    const refreshFailed = reduce(refreshing, {
      type: 'FAIL',
      error: { code: 'refresh_failed', status: 400, body: 'nope' },
    });
    assert.equal(refreshFailed.tag === 'failed' ? refreshFailed.error.code : '', 'refresh_failed');
    assert.equal(reduce(replaced, { type: 'SIGN_OUT' }).tag, 'signed_out');
    assert.equal(reduce(refreshing, { type: 'SIGN_OUT' }).tag, 'signed_out');
    assert.equal(
      reduce(signedOut, { type: 'FAIL', error: { code: 'callback_timeout' } }).tag,
      'signed_out',
    );
  });

  it('publishes status without tokens, verifiers, or the attempt secret', () => {
    const now = session.expiresAt - 30_000;
    const signedIn = toPublic({ tag: 'signed_in', session }, now);
    assert.deepEqual(signedIn, {
      auth: 'signed_in',
      email: 'a@example.com',
      planType: 'plus',
      scopesOk: true,
      expiresInSec: 30,
    });
    const encoded = JSON.stringify(signedIn);
    assert.equal(encoded.includes('secret-access-token'), false);
    assert.equal(encoded.includes('secret-refresh-token'), false);
    const pending = toPublic({ tag: 'awaiting_callback', attempt });
    assert.deepEqual(pending, { auth: 'pending' });
    assert.equal(JSON.stringify(pending).includes('verifier-secret'), false);
    assert.equal(JSON.stringify(pending).includes('csrf-secret'), false);
    const refreshing = toPublic(
      { tag: 'refreshing', session, inflight: Promise.resolve(session) },
      now,
    );
    assert.equal(refreshing.auth, 'signed_in');
    assert.equal(JSON.stringify(refreshing).includes('secret-access-token'), false);
  });
});
