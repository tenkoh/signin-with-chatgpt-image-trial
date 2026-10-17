import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface Config {
  port: number;
  stateDir: string;
  model: string;
  agentName: string;
  issuer: string;
  authorizeUrl: string;
  tokenUrl: string;
  jwksUrl: string;
  responsesUrl: string;
  resource: string;
  scopes: string[];
}

const SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'resource.invoke',
  'chatgpt.tokens.use.direct',
] as const;

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const issuer = 'https://auth.openai.com';
  return {
    port: parsePort(env.SIWC_PORT ?? '1455'),
    stateDir: resolveStateDir(env.SIWC_STATE_DIR),
    model: env.SIWC_MODEL?.trim() ? env.SIWC_MODEL.trim() : 'gpt-5',
    agentName: 'SIWC Image PoC',
    issuer,
    authorizeUrl: `${issuer}/api/accounts/authorize`,
    tokenUrl: `${issuer}/api/accounts/oauth/token`,
    jwksUrl: `${issuer}/.well-known/jwks.json`,
    responsesUrl: 'https://api.openai.com/v1/responses',
    resource: 'https://api.openai.com/v1',
    scopes: [...SCOPES],
  };
}

function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error('SIWC_PORT must be an integer');
  const port = Number(value);
  if (port < 1 || port > 65535) throw new Error('SIWC_PORT must be between 1 and 65535');
  return port;
}

function resolveStateDir(value: string | undefined): string {
  if (!value?.trim()) return join(homedir(), '.siwc-poc');
  const trimmed = value.trim();
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/')) return join(homedir(), trimmed.slice(2));
  return resolve(trimmed);
}
