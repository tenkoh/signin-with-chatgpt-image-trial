import type { ProbeKind, ProbeReport, PublicAuthStatus } from '@siwc/public';

export type { ProbeKind, ProbeReport, PublicAuthStatus };

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status}: ${body}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const api = {
  status(): Promise<PublicAuthStatus> {
    return fetch('/api/status').then((r) => json(r));
  },
  async startSignIn(): Promise<void> {
    const popup = window.open('about:blank', '_blank');
    try {
      const res = await fetch('/api/auth/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: '{}',
      });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok || !isRecord(body) || typeof body.authorizeUrl !== 'string') {
        throw new Error(`Sign-in failed to start (HTTP ${res.status}).`);
      }
      if (popup) popup.location.href = body.authorizeUrl;
      else window.location.assign(body.authorizeUrl);
    } catch (err) {
      popup?.close();
      throw err;
    }
  },
  signOut(): Promise<void> {
    return fetch('/api/auth/signout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }).then((r) => json(r));
  },
  probe(kind: ProbeKind): Promise<ProbeReport> {
    return fetch(`/api/probe/${kind}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }).then((r) => json(r));
  },
};
