import { Hono } from 'hono';
import type { Config } from './config.js';
import { AuthMachine, NotSignedIn, type CallbackQuery } from './auth/machine.js';
import { toPublic } from './auth/state.js';
import { classify } from './probe/classify.js';
import { imageProbeRequest, textProbeRequest } from './probe/requests.js';
import { callResponses } from './probe/responses.js';
import type { ProbeKind } from './public-types.js';

export function buildApp(cfg: Config, auth: AuthMachine): Hono {
  const app = new Hono();
  const allowedHosts = new Set([`127.0.0.1:${cfg.port}`, '127.0.0.1:5173']);

  app.use('*', async (c, next) => {
    const headerHost = (c.req.header('host') ?? '').toLowerCase();
    const urlHost = new URL(c.req.url).host.toLowerCase();
    const host = headerHost || urlHost;
    if (!allowedHosts.has(host)) return c.text('forbidden', 403);
    if (
      c.req.method === 'POST' &&
      c.req.path.startsWith('/api/') &&
      !isJson(c.req.header('content-type'))
    ) {
      return c.text('unsupported media type', 415);
    }
    await next();
    c.header('Cache-Control', 'no-store');
  });

  app.get('/api/status', (c) => c.json(auth.status()));

  app.post('/api/auth/start', (c) => c.json({ authorizeUrl: auth.start() }));

  app.get('/auth/callback', async (c) => {
    const state = await auth.handleCallback(callbackQuery(c.req.query()));
    return c.html(callbackPage(toPublic(state)));
  });

  app.post('/api/auth/signout', (c) => {
    auth.signOut();
    return c.body(null, 204);
  });

  app.post('/api/probe/:kind', async (c) => {
    const kind = c.req.param('kind');
    if (!isProbeKind(kind)) return c.text('not found', 404);
    let token: string;
    try {
      token = await auth.accessToken();
    } catch (err) {
      if (err instanceof NotSignedIn) return c.json({ error: 'not_signed_in' }, 409);
      throw err;
    }
    const body = kind === 'text' ? textProbeRequest(cfg.model) : imageProbeRequest(cfg.model);
    const run = await callResponses(token, body, cfg);
    return c.json(classify(kind, run, body));
  });

  return app;
}

function isProbeKind(value: string): value is ProbeKind {
  return value === 'text' || value === 'image';
}

function isJson(contentType: string | undefined): boolean {
  const media = contentType?.split(';')[0]?.trim().toLowerCase();
  return media === 'application/json';
}

function callbackQuery(query: Record<string, string>): CallbackQuery {
  const out: CallbackQuery = {};
  if (query.code) out.code = query.code;
  if (query.state) out.state = query.state;
  if (query.error) out.error = query.error;
  if (query.error_description) out.error_description = query.error_description;
  if (query.client_id) out.client_id = query.client_id;
  return out;
}

function callbackPage(status: ReturnType<typeof toPublic>): string {
  const heading = status.auth === 'signed_in' ? 'Signed in' : 'Sign-in failed';
  let text = 'Sign-in did not finish. Return to the app and try again.';
  if (status.auth === 'signed_in') text = 'Signed in. You can close this tab.';
  if (status.auth === 'failed') {
    text = status.detail
      ? `Failed: ${status.error} (${status.detail}).`
      : `Failed: ${status.error}.`;
  }
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(heading)}</title>
</head>
<body>
  <p>${escapeHtml(text)}</p>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
