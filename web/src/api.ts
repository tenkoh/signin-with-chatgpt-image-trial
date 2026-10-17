export type PublicAuthStatus =
  | { auth: 'signed_out' }
  | { auth: 'pending' }
  | {
      auth: 'signed_in';
      email?: string;
      planType?: string;
      scopesOk: true;
      expiresInSec: number;
    }
  | { auth: 'plan_disabled'; email?: string }
  | { auth: 'failed'; error: string; detail?: string };

export type ProbeKind = 'text' | 'image';

export type Verdict = 'pass' | 'unsupported' | 'auth_failed' | 'error';

export interface ProbeReport {
  kind: ProbeKind;
  verdict: Verdict;
  reason: string;
  output?: string;
  imageDataUrl?: string;
  evidence: {
    httpStatus: number;
    errorCode?: string;
    terminal?: string;
    eventTypes: string[];
    errorBody?: unknown;
  };
  request: { model: string; tools: string[]; toolChoice: string };
  durationMs: number;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status}: ${body}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  status(): Promise<PublicAuthStatus> {
    return fetch('/api/status').then((r) => json(r));
  },
  async startSignIn(): Promise<void> {
    const { authorizeUrl } = await fetch('/api/auth/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }).then((r) => json<{ authorizeUrl: string }>(r));
    window.open(authorizeUrl, '_blank', 'noopener,noreferrer');
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
