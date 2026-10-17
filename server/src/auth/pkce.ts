import { createHash, randomBytes } from 'node:crypto';

export function randomB64url(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}
