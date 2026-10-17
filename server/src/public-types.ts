export type PublicAuthErrorCode =
  | 'state_mismatch'
  | 'authorize_denied'
  | 'callback_timeout'
  | 'token_exchange_failed'
  | 'id_token_invalid'
  | 'missing_scope'
  | 'refresh_failed';

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
  | { auth: 'failed'; error: PublicAuthErrorCode; detail?: string };

export type ProbeKind = 'text' | 'image';

export type Verdict = 'pass' | 'unsupported' | 'auth_failed' | 'error';

export type ResponseTerminal =
  | 'response.completed'
  | 'response.failed'
  | 'response.incomplete'
  | 'error';

export interface ProbeReport {
  kind: ProbeKind;
  verdict: Verdict;
  reason: string;
  output?: string;
  imageDataUrl?: string;
  evidence: {
    httpStatus: number;
    errorCode?: string;
    terminal?: ResponseTerminal;
    eventTypes: string[];
    errorBody?: unknown;
  };
  request: { model: string; tools: string[]; toolChoice: string };
  durationMs: number;
}
