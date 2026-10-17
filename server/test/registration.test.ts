import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { loadOrCreateRegistration, saveIssuedClientId } from '../src/auth/registration.js';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'siwc-reg-'));
  dirs.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('registration', () => {
  it('creates a host id once and stores only an issued client id', async () => {
    const dir = await tempDir();
    const created = await loadOrCreateRegistration(dir);
    assert.match(created.hostId, /^urn:uuid:[0-9a-f-]{36}$/i);
    assert.equal(created.clientId, undefined);
    const again = await loadOrCreateRegistration(dir);
    assert.deepEqual(again, created);

    await saveIssuedClientId(dir, 'dynamic_agent_client');
    assert.equal((await loadOrCreateRegistration(dir)).clientId, undefined);

    await saveIssuedClientId(dir, 'oaiapp_issued');
    assert.deepEqual(await loadOrCreateRegistration(dir), {
      hostId: created.hostId,
      clientId: 'oaiapp_issued',
    });
    await saveIssuedClientId(dir, 'oaiapp_issued');
    assert.equal((await loadOrCreateRegistration(dir)).clientId, 'oaiapp_issued');

    const mode = (await stat(join(dir, 'registration.json'))).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  it('refuses a registration file whose client id is not an issued id', async () => {
    const dir = await tempDir();
    const { hostId } = await loadOrCreateRegistration(dir);
    await writeFile(
      join(dir, 'registration.json'),
      JSON.stringify({ hostId, clientId: 'dynamic_agent_client' }),
    );
    await assert.rejects(() => loadOrCreateRegistration(dir), /oaiapp_/);
  });
});
