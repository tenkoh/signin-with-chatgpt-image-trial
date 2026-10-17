import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { buildAuthorizeUrl, hasDirectUseScope, type TokenResponse } from '../src/auth/oidc.js';
import { s256 } from '../src/auth/pkce.js';
import type { AuthAttempt, IdentityClaims } from '../src/auth/state.js';

const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

describe('pkce', () => {
  it('builds the RFC 7636 S256 challenge', () => {
    assert.equal(s256(verifier), challenge);
  });
});

describe('buildAuthorizeUrl', () => {
  const cfg = loadConfig({ SIWC_PORT: '1455' });
  const attempt: AuthAttempt = {
    state: 'state-1',
    nonce: 'nonce-1',
    codeVerifier: verifier,
    redirectUri: 'http://127.0.0.1:1455/auth/callback',
    clientId: 'dynamic_agent_client',
    startedAt: 1,
  };

  it('uses the Sign in with ChatGPT authorize endpoint and registration parameters', () => {
    const url = new URL(
      buildAuthorizeUrl(cfg, { hostId: 'urn:uuid:00000000-0000-4000-8000-000000000001' }, attempt),
    );
    assert.equal(url.origin + url.pathname, 'https://auth.openai.com/api/accounts/authorize');
    assert.equal(url.searchParams.get('client_id'), 'dynamic_agent_client');
    assert.equal(url.searchParams.get('agent_name_hint'), 'SIWC Image PoC');
    assert.equal(
      url.searchParams.get('ext_agent_host_id'),
      'urn:uuid:00000000-0000-4000-8000-000000000001',
    );
    assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:1455/auth/callback');
    assert.equal(url.searchParams.get('resource'), 'https://api.openai.com/v1');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('code_challenge'), challenge);
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(
      url.searchParams.get('scope'),
      'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
    );
    assert.equal(url.toString().includes('localhost'), false);
  });

  it('omits agent_name_hint when the attempt already has an issued client id', () => {
    const url = new URL(
      buildAuthorizeUrl(
        cfg,
        { hostId: 'urn:uuid:00000000-0000-4000-8000-000000000001', clientId: 'oaiapp_ready' },
        {
          ...attempt,
          clientId: 'oaiapp_ready',
        },
      ),
    );
    assert.equal(url.searchParams.get('client_id'), 'oaiapp_ready');
    assert.equal(url.searchParams.get('agent_name_hint'), null);
    assert.equal(
      url.searchParams.get('ext_agent_host_id'),
      'urn:uuid:00000000-0000-4000-8000-000000000001',
    );
  });
});

describe('hasDirectUseScope', () => {
  const claims: IdentityClaims = { sub: 'user', scopes: ['openid'] };

  it('requires chatgpt.tokens.use.direct on the token response when scope is present', () => {
    const granted: TokenResponse = {
      access_token: 'a',
      expires_in: 3600,
      token_type: 'Bearer',
      scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
    };
    const missing: TokenResponse = { ...granted, scope: 'openid profile email' };
    assert.equal(hasDirectUseScope(granted, claims), true);
    assert.equal(
      hasDirectUseScope(missing, { ...claims, scopes: ['chatgpt.tokens.use.direct'] }),
      false,
    );
  });

  it('falls back to id-token scopes only when the token response omits scope', () => {
    const tok: TokenResponse = { access_token: 'a', expires_in: 3600, token_type: 'Bearer' };
    assert.equal(
      hasDirectUseScope(tok, { sub: 'user', scopes: ['chatgpt.tokens.use.direct'] }),
      true,
    );
    assert.equal(hasDirectUseScope(tok, claims), false);
  });
});
