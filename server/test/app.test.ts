import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { buildApp } from '../src/app.js';
import { AuthMachine } from '../src/auth/machine.js';
import { loadConfig } from '../src/config.js';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'siwc-app-'));
  dirs.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('http surface', () => {
  it('reports signed_out, rejects a foreign host, and requires JSON on API posts', async () => {
    const dir = await tempDir();
    const cfg = loadConfig({ SIWC_PORT: '1455', SIWC_STATE_DIR: dir });
    const app = buildApp(
      cfg,
      new AuthMachine(cfg, { hostId: 'urn:uuid:00000000-0000-4000-8000-000000000001' }),
    );

    const status = await app.request('http://127.0.0.1:1455/api/status');
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), { auth: 'signed_out' });

    const viaVite = await app.request('http://127.0.0.1:5173/api/status');
    assert.equal(viaVite.status, 200);

    const foreign = await app.request('http://evil.example/api/status');
    assert.equal(foreign.status, 403);

    const form = await app.request('http://127.0.0.1:1455/api/auth/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: '',
    });
    assert.equal(form.status, 415);

    const probe = await app.request('http://127.0.0.1:1455/api/probe/text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(probe.status, 409);
    assert.deepEqual(await probe.json(), { error: 'not_signed_in' });
  });

  it('returns an authorize URL and a callback page that does not echo the code', async () => {
    const dir = await tempDir();
    const cfg = loadConfig({ SIWC_PORT: '1455', SIWC_STATE_DIR: dir });
    const app = buildApp(
      cfg,
      new AuthMachine(cfg, { hostId: 'urn:uuid:00000000-0000-4000-8000-000000000001' }),
    );

    const start = await app.request('http://127.0.0.1:1455/api/auth/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(start.status, 200);
    const started = (await start.json()) as { authorizeUrl: string };
    const authorize = new URL(started.authorizeUrl);
    assert.equal(
      authorize.origin + authorize.pathname,
      'https://auth.openai.com/api/accounts/authorize',
    );
    assert.equal(started.authorizeUrl.includes('localhost'), false);
    assert.equal(JSON.stringify(started).includes('code_verifier'), false);

    const pending = await app.request('http://127.0.0.1:1455/api/status');
    assert.deepEqual(await pending.json(), { auth: 'pending' });

    const callback = await app.request(
      'http://127.0.0.1:1455/auth/callback?code=super-secret-code&state=nope',
    );
    assert.equal(callback.status, 200);
    const html = await callback.text();
    assert.match(html, /state_mismatch/);
    assert.equal(html.includes('super-secret-code'), false);

    const signOut = await app.request('http://127.0.0.1:1455/api/auth/signout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(signOut.status, 204);
    const after = await app.request('http://127.0.0.1:1455/api/status');
    assert.deepEqual(await after.json(), { auth: 'signed_out' });
  });
});
