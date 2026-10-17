import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { buildApp } from './app.js';
import { AuthMachine } from './auth/machine.js';
import { loadOrCreateRegistration } from './auth/registration.js';

const cfg = loadConfig(process.env);
const registration = await loadOrCreateRegistration(cfg.stateDir);
const auth = new AuthMachine(cfg, registration);
const app = buildApp(cfg, auth);

serve({ fetch: app.fetch, hostname: '127.0.0.1', port: cfg.port }, (info) => {
  console.log(`listening on http://127.0.0.1:${info.port}`);
});
