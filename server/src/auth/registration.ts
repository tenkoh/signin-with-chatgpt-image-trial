import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isRecord } from '../record.js';

export interface Registration {
  hostId: string;
  clientId?: string;
}

const HOST_ID = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function loadOrCreateRegistration(dir: string): Promise<Registration> {
  const path = join(dir, 'registration.json');
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (!isEnoent(err)) throw err;
    const created: Registration = { hostId: `urn:uuid:${randomUUID()}` };
    await writeRegistration(dir, created);
    return created;
  }
  return parseRegistration(text);
}

export async function saveIssuedClientId(dir: string, clientId: string): Promise<void> {
  if (!clientId.startsWith('oaiapp_')) return;
  const current = await loadOrCreateRegistration(dir);
  if (current.clientId === clientId) return;
  await writeRegistration(dir, { hostId: current.hostId, clientId });
}

async function writeRegistration(dir: string, registration: Registration): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const path = join(dir, 'registration.json');
  const tmp = join(dir, `.registration.${process.pid}.tmp`);
  await writeFile(tmp, `${JSON.stringify(registration, null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
  await chmod(path, 0o600);
}

function parseRegistration(text: string): Registration {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new Error('registration.json is not valid JSON');
  }
  if (!isRecord(raw) || typeof raw.hostId !== 'string' || !HOST_ID.test(raw.hostId)) {
    throw new Error('registration.json hostId must be a urn:uuid value');
  }
  const registration: Registration = { hostId: raw.hostId };
  if (raw.clientId === undefined) return registration;
  if (typeof raw.clientId !== 'string' || !raw.clientId.startsWith('oaiapp_')) {
    throw new Error('registration.json clientId must be an issued oaiapp_ id');
  }
  registration.clientId = raw.clientId;
  return registration;
}

function isEnoent(err: unknown): boolean {
  return isRecord(err) && err.code === 'ENOENT';
}
