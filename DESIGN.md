# SIWC Image-Gen PoC — Design (candidate 1)

**Question this PoC answers:** after a Plus/Pro user does _Sign in with ChatGPT_ (dynamic agent registration), can an OSS local client run the `image_generation` tool on `POST /v1/responses` while billing goes to the ChatGPT plan?

**Shape in one sentence:** a single Hono process bound to `127.0.0.1` owns the OAuth loopback callback, the in-memory token vault, and two _probes_ (text, image). A React+Vite page only starts sign-in, shows the status, runs probes, and renders verdicts. The browser never sees a token.

Docs say the image tool is **unsupported** on this route. So the expected result is `text: PASS` and `image: UNSUPPORTED`. The PoC is built so that this result, or any surprise, is unambiguous.

---

## 1. Usage (README)

```bash
pnpm install
pnpm lint           # oxlint
pnpm format         # oxfmt (write)
pnpm format:check   # oxfmt --check
pnpm dev            # runs Hono on http://127.0.0.1:1455 and Vite on http://127.0.0.1:5173
# open http://127.0.0.1:5173
```

Lint/format toolchain is **oxlint** + **oxfmt** only (no eslint/prettier/biome).

Live UI verification uses **agent-browser** (snapshot + click refs), not Playwright/Puppeteer.

1. Click **Sign in with ChatGPT**. A new tab opens on the OpenAI authorize page. Approve.
2. The tab lands on `http://127.0.0.1:1455/auth/callback`, shows "Signed in, you can close this tab", and the UI updates (it polls `/api/status`).
3. Click **Run text probe**. It should show `PASS` with the model's reply.
4. Click **Run image probe**. It shows exactly one of:
   - `PASS`: the image is rendered (the docs were wrong or have changed)
   - `UNSUPPORTED`: the route rejected the tool (`route_not_supported`, 403, or a `response.failed` naming the tool)
   - `AUTH_FAILED` / `ERROR`: anything else, with the raw HTTP status, error body, and SSE event trace

Environment (all optional):

| var              | default       | purpose                                                           |
| ---------------- | ------------- | ----------------------------------------------------------------- |
| `SIWC_PORT`      | `1455`        | loopback port, which becomes part of `redirect_uri`               |
| `SIWC_STATE_DIR` | `~/.siwc-poc` | location of `registration.json` (host id + issued client_id only) |
| `SIWC_MODEL`     | `gpt-5.6-sol` | model for both probes                                             |

Only two things are written to disk: `ext_agent_host_id` and the issued `oaiapp_…` client_id. Tokens live in process memory and are gone on restart. That is intentional, because the PoC has no session or history.

### Call-site examples

**A. Browser (the whole frontend API)**

```ts
import { api } from './api';

await api.startSignIn(); // opens the authorize URL in a new tab
const s = await api.status(); // { auth: "signed_in", email, planType, scopesOk: true }
const text = await api.probe('text'); // { kind: "text", verdict: "pass", output: "pong", ... }
const img = await api.probe('image'); // { kind: "image", verdict: "unsupported", evidence: {...} }
```

**B. Headless check with curl (after signing in through the UI)**

```bash
curl -s -X POST http://127.0.0.1:1455/api/probe/text  | jq .verdict   # "pass"
curl -s -X POST http://127.0.0.1:1455/api/probe/image | jq '{verdict, evidence}'
```

**C. Server internals: what a probe call looks like**

```ts
const token = await vault.accessToken(); // refreshes if near expiry; throws NotSignedIn
const run = await callResponses(token, imageProbeRequest(cfg.model));
const report = classify('image', run); // pure function, unit tested on fixtures
```

---

## 2. Domain types and state machines

### 2.1 Auth lifecycle (server-side, single instance)

```
             start()                    callback(code,state ok)          exchange ok + id_token valid + scope ok
 signed_out ─────────▶ awaiting_callback ───────────────────────▶ exchanging ─────────────────────────────▶ signed_in
     ▲                    │  timeout(5m) / state mismatch / error=        │ any failure                         │  │
     │                    ▼                                               ▼                                     │  │ near expiry
     │                  failed ◀──────────────────────────────────────────┘                                     │  ▼
     │                    │ start()                                                    refresh ok ◀─────── refreshing
     │                    └──────────▶ awaiting_callback                               refresh fail ──▶ failed
     └──────────────────────────── signOut() (from any state) ─────────────────────────────────────────────────┘
```

```ts
// server/auth/state.ts
export type AuthState =
  | { tag: 'signed_out' }
  | { tag: 'awaiting_callback'; attempt: AuthAttempt }
  | { tag: 'exchanging'; attempt: AuthAttempt }
  | { tag: 'signed_in'; session: TokenSession }
  | { tag: 'refreshing'; session: TokenSession; inflight: Promise<TokenSession> }
  | { tag: 'failed'; error: AuthError; at: number };

export interface AuthAttempt {
  state: string; // CSRF, 32B random, base64url
  nonce: string; // bound into id_token
  codeVerifier: string; // PKCE S256
  redirectUri: string; // http://127.0.0.1:<port>/auth/callback
  clientId: string; // "dynamic_agent_client" or persisted "oaiapp_..."
  startedAt: number;
}

export interface TokenSession {
  accessToken: string; // NEVER leaves the server
  refreshToken?: string; // NEVER leaves the server
  expiresAt: number; // epoch ms
  claims: IdentityClaims;
}

export interface IdentityClaims {
  sub: string;
  email?: string;
  planType?: string; // from the ChatGPT auth claim, if present
  scopes: string[];
}

export type AuthError =
  | { code: 'state_mismatch' }
  | { code: 'authorize_denied'; detail: string } // ?error= on the callback
  | { code: 'callback_timeout' }
  | { code: 'token_exchange_failed'; status: number; body: string }
  | { code: 'id_token_invalid'; detail: string } // signature / iss / aud / nonce / exp
  | { code: 'missing_scope'; scope: 'chatgpt.tokens.use.direct' }
  | { code: 'refresh_failed'; status: number; body: string };

// The ONLY auth shape the browser ever receives:
export type PublicAuthStatus =
  | { auth: 'signed_out' }
  | { auth: 'pending' } // awaiting_callback | exchanging
  | { auth: 'signed_in'; email?: string; planType?: string; scopesOk: true; expiresInSec: number }
  | { auth: 'plan_disabled'; email?: string } // grafted: ID ok, chatgpt.tokens.use.direct missing
  | { auth: 'failed'; error: AuthError['code']; detail?: string };
```

### Grafts from arena candidate-2 (keep single-Hono base)

- UI CTA label: **Continue with ChatGPT**.
- Composed summary line after both probes that separates text-smoke success from image-tool outcome.
- Classify `subscription_sharing_route_not_supported` and `subscription_sharing_unsupported_capability` as `unsupported`.
- From `plan_disabled`, re-auth may send `prompt=consent` with the saved issued client id.
- Rejected: dual-port vault (8787+1455), SSE-only sync.

Transitions go through one pure reducer, so illegal moves (for example a callback while `signed_out`) are rejected in a single place:

```ts
export type AuthEvent =
  | { type: 'START'; attempt: AuthAttempt }
  | { type: 'CALLBACK'; state: string; code?: string; error?: string }
  | { type: 'EXCHANGED'; session: TokenSession }
  | { type: 'FAIL'; error: AuthError }
  | { type: 'REFRESH_BEGIN'; inflight: Promise<TokenSession> }
  | { type: 'REFRESHED'; session: TokenSession }
  | { type: 'TIMEOUT' }
  | { type: 'SIGN_OUT' };

export function reduce(s: AuthState, e: AuthEvent): AuthState;
```

Side effects (HTTP, JWKS) live in `AuthMachine`, which dispatches events. The reducer stays I/O-free.

### 2.2 Probe (one generate attempt)

The probe has no persisted state machine. It is a single request/response whose outcome is a **classified verdict**:

```ts
// server/probe/types.ts
export type ProbeKind = 'text' | 'image';

export type Verdict =
  | 'pass' // text: got output_text. image: got an image_generation_call with a result
  | 'unsupported' // route explicitly rejects the tool (expected for image)
  | 'auth_failed' // 401, or 403 that is NOT route_not_supported
  | 'error'; // anything else: 4xx/5xx, stream broke, completed but no image, etc.

export interface ResponsesRun {
  // raw facts, produced by callResponses
  httpStatus: number;
  errorBody?: unknown; // parsed JSON body on non-2xx
  events: SseEventSummary[]; // type + compact payload, b64 truncated
  terminal?: 'response.completed' | 'response.failed' | 'response.incomplete' | 'error';
  outputText: string;
  images: { b64: string; mime: string }[]; // from image_generation_call.result
  durationMs: number;
}

export interface SseEventSummary {
  type: string;
  data: unknown;
}

export interface ProbeReport {
  // what /api/probe returns
  kind: ProbeKind;
  verdict: Verdict;
  reason: string; // one human sentence
  output?: string; // text probe
  imageDataUrl?: string; // image probe on pass
  evidence: {
    httpStatus: number;
    errorCode?: string; // e.g. "route_not_supported"
    terminal?: ResponsesRun['terminal'];
    eventTypes: string[]; // ordered, deduped runs
    errorBody?: unknown;
  };
  request: { model: string; tools: string[]; toolChoice: string }; // what was attempted
  durationMs: number;
}
```

Classification rules for `classify(kind, run)`, in order:

1. `httpStatus === 401` → `auth_failed`
2. Error code `route_not_supported` (from the body or a failed event), **or** a 400/403 whose message names `image_generation` / tool unsupported → `unsupported`
3. `httpStatus === 403` → `auth_failed`
4. Non-2xx → `error`
5. Terminal is `response.failed` or `error` → `unsupported` if rule 2 matches the event payload, else `error`
6. `kind === "text"` and `outputText.trim()` → `pass`
7. `kind === "image"` and `images.length > 0` → `pass`
8. Otherwise `error` ("completed without the expected output")

The image probe uses `tool_choice: { type: "image_generation" }`, so the model cannot quietly answer in text. A completed response without an image therefore counts as a failure, not as ambiguity.

---

## 3. Module map

```
siwc-poc/
  package.json              # workspaces: server, web; "dev" runs both via concurrently
  server/
    src/
      main.ts               # loads config, builds the app, serve({ hostname: "127.0.0.1", port })
      config.ts             # env → Config (port, stateDir, model, OpenAI endpoints)
      app.ts                # Hono routes (the full HTTP surface, see below)
      auth/
        state.ts            # AuthState, AuthEvent, reduce(), toPublic()
        machine.ts          # AuthMachine: start / handleCallback / accessToken / signOut
        pkce.ts             # random(), s256()
        oidc.ts             # buildAuthorizeUrl, exchangeCode, refresh, verifyIdToken (jose + JWKS)
        registration.ts     # load/save { hostId, clientId? } in stateDir/registration.json (0600)
      probe/
        types.ts
        requests.ts         # textProbeRequest(model), imageProbeRequest(model)
        responses.ts        # callResponses(token, body) → ResponsesRun (fetch + SSE parse)
        sse.ts              # parseSse(ReadableStream) → AsyncIterable<{event,data}>
        classify.ts         # classify(kind, run) → ProbeReport (pure)
    test/
      reduce.test.ts
      classify.test.ts      # fixtures: route_not_supported 403, failed event, success image, 401
      fixtures/*.sse
  web/
    vite.config.ts          # server.host "127.0.0.1"; proxy /api → 127.0.0.1:1455
    src/
      main.tsx
      App.tsx               # status panel + 2 probe cards
      api.ts                # status(), startSignIn(), signOut(), probe(kind)
      ProbeCard.tsx         # verdict badge, reason, output/image, collapsible evidence JSON
      useStatus.ts          # polls /api/status every 1s while pending, else on focus
```

### HTTP surface (the entire public API)

| method | path                | caller          | returns                                                           |
| ------ | ------------------- | --------------- | ----------------------------------------------------------------- |
| `GET`  | `/api/status`       | UI              | `PublicAuthStatus`                                                |
| `POST` | `/api/auth/start`   | UI              | `{ authorizeUrl }` (UI calls `window.open`)                       |
| `GET`  | `/auth/callback`    | OpenAI redirect | small HTML page "Signed in / Failed: …"                           |
| `POST` | `/api/auth/signout` | UI              | `204`                                                             |
| `POST` | `/api/probe/:kind`  | UI, curl        | `ProbeReport` (always 200 when a probe ran. 409 if not signed in) |

Hardening that costs one line each: bind only to `127.0.0.1`; reject requests whose `Host` is not `127.0.0.1:<port>` or the Vite origin (prevents DNS rebinding); `/api/*` POSTs require `Content-Type: application/json` (blocks cross-site simple-form CSRF); no CORS headers (same origin through the Vite proxy).

---

## 4. Signatures

```ts
// server/src/config.ts
export interface Config {
  port: number;
  stateDir: string;
  model: string;
  issuer: string; // "https://auth.openai.com"   (verify against SIWC docs)
  authorizeUrl: string; // `${issuer}/oauth/authorize`
  tokenUrl: string; // `${issuer}/oauth/token`
  jwksUrl: string; // `${issuer}/.well-known/jwks.json`
  responsesUrl: string; // "https://api.openai.com/v1/responses"
  resource: string; // "https://api.openai.com/v1"
  scopes: string[]; // openid profile email offline_access resource.invoke chatgpt.tokens.use.direct
}
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  throw new Error('not implemented');
}
```

```ts
// server/src/auth/registration.ts
export interface Registration {
  hostId: string;
  clientId?: string;
} // hostId = "urn:uuid:<v4>"
export async function loadOrCreateRegistration(dir: string): Promise<Registration> {
  // TODO: read dir/registration.json; if missing → { hostId: `urn:uuid:${randomUUID()}` }, write 0600
  throw new Error('not implemented');
}
export async function saveIssuedClientId(dir: string, clientId: string): Promise<void> {
  // TODO: only when clientId startsWith("oaiapp_") and differs from stored value
  throw new Error('not implemented');
}
```

```ts
// server/src/auth/pkce.ts
export function randomB64url(bytes?: number): string {
  throw new Error('not implemented');
}
export function s256(verifier: string): string {
  throw new Error('not implemented');
}
```

```ts
// server/src/auth/oidc.ts
export function buildAuthorizeUrl(cfg: Config, reg: Registration, a: AuthAttempt): string {
  // TODO: response_type=code, client_id=a.clientId, redirect_uri, scope=cfg.scopes.join(" "),
  //       resource=cfg.resource, state, nonce, code_challenge=s256(verifier), code_challenge_method=S256,
  //       ext_agent_host_id=reg.hostId
  throw new Error('not implemented');
}
export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token: string;
  expires_in: number;
  scope?: string;
  token_type: 'Bearer';
}
export async function exchangeCode(
  cfg: Config,
  a: AuthAttempt,
  code: string,
): Promise<TokenResponse> {
  // TODO: POST form grant_type=authorization_code, code, redirect_uri, client_id, code_verifier, resource
  throw new Error('not implemented');
}
export async function refreshTokens(
  cfg: Config,
  clientId: string,
  refreshToken: string,
): Promise<TokenResponse> {
  throw new Error('not implemented');
}
export async function verifyIdToken(
  cfg: Config,
  idToken: string,
  clientId: string,
  nonce: string,
): Promise<IdentityClaims> {
  // TODO: jose.createRemoteJWKSet(cfg.jwksUrl); jwtVerify({ issuer, audience: clientId }); check nonce;
  //       extract email + plan claim
  throw new Error('not implemented');
}
export function hasDirectUseScope(tok: TokenResponse, claims: IdentityClaims): boolean {
  // TODO: "chatgpt.tokens.use.direct" in tok.scope ?? claims.scopes
  throw new Error('not implemented');
}
```

```ts
// server/src/auth/machine.ts
export class NotSignedIn extends Error {}

export class AuthMachine {
  constructor(cfg: Config, reg: Registration) {}

  /** Moves to awaiting_callback (replacing any prior attempt) and returns the URL for the browser. */
  start(): string {
    throw new Error('not implemented');
  }

  /** Handles GET /auth/callback. Never throws; the outcome is the resulting state. */
  async handleCallback(q: {
    code?: string;
    state?: string;
    error?: string;
    error_description?: string;
    client_id?: string;
  }): Promise<AuthState> {
    // TODO: dispatch CALLBACK → (state check in reduce) → exchanging
    //   if q.client_id?.startsWith("oaiapp_"): attempt.clientId = q.client_id; saveIssuedClientId
    //   exchangeCode → verifyIdToken(nonce) → hasDirectUseScope → EXCHANGED | FAIL
    throw new Error('not implemented');
  }

  /** The only way code gets a bearer token. Single-flight refresh if expiresAt - now < 60s. */
  async accessToken(): Promise<string> {
    throw new Error('not implemented');
  }

  status(): PublicAuthStatus {
    throw new Error('not implemented');
  }
  signOut(): void {
    throw new Error('not implemented');
  }
}
```

```ts
// server/src/probe/requests.ts
export interface ResponsesBody {
  model: string;
  input: unknown;
  store: false;
  stream: true;
  tools?: unknown[];
  tool_choice?: unknown;
}
export function textProbeRequest(model: string): ResponsesBody {
  // { model, input: "Reply with exactly: pong", store: false, stream: true }
  throw new Error('not implemented');
}
export function imageProbeRequest(model: string): ResponsesBody {
  // { model, input: "A small red circle on white.", store: false, stream: true,
  //   tools: [{ type: "image_generation", size: "1024x1024", quality: "low" }],
  //   tool_choice: { type: "image_generation" } }
  throw new Error('not implemented');
}
```

```ts
// server/src/probe/responses.ts
export async function callResponses(
  accessToken: string,
  body: ResponsesBody,
  cfg: Config,
): Promise<ResponsesRun> {
  // TODO: fetch POST cfg.responsesUrl, Authorization: Bearer, Accept: text/event-stream
  //   non-2xx → read JSON body, return { httpStatus, errorBody, events: [] }
  //   2xx → for await parseSse: record summary (truncate b64 > 64 chars),
  //         accumulate response.output_text.delta, collect image_generation_call.result on
  //         response.output_item.done, set terminal on completed/failed/incomplete/error
  //   AbortSignal.timeout(120s) → terminal undefined, the classifier reports "error: stream timeout"
  throw new Error('not implemented');
}

// server/src/probe/sse.ts
export async function* parseSse(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<{ event?: string; data: string }> {
  throw new Error('not implemented');
}

// server/src/probe/classify.ts
export function classify(kind: ProbeKind, run: ResponsesRun, req: ResponsesBody): ProbeReport {
  // TODO: rules from §2.2 in order; extract errorCode from errorBody.error.code or failed-event payload
  throw new Error('not implemented');
}
```

```ts
// server/src/app.ts
export function buildApp(cfg: Config, auth: AuthMachine): Hono {
  // GET  /api/status          → c.json(auth.status())
  // POST /api/auth/start      → c.json({ authorizeUrl: auth.start() })
  // GET  /auth/callback       → s = await auth.handleCallback(c.req.query()); c.html(page(s))
  // POST /api/auth/signout    → auth.signOut(); 204
  // POST /api/probe/:kind     → token = await auth.accessToken() (NotSignedIn → 409)
  //                             body = kind==="text" ? textProbeRequest : imageProbeRequest
  //                             c.json(classify(kind, await callResponses(token, body, cfg), body))
  // middleware: host allowlist, JSON content-type on POST
  throw new Error('not implemented');
}
```

```ts
// web/src/api.ts
export const api = {
  status(): Promise<PublicAuthStatus> {
    throw new Error('not implemented');
  },
  async startSignIn(): Promise<void> {
    /* POST start → window.open(authorizeUrl, "_blank") */ throw new Error('not implemented');
  },
  signOut(): Promise<void> {
    throw new Error('not implemented');
  },
  probe(kind: ProbeKind): Promise<ProbeReport> {
    throw new Error('not implemented');
  },
};
```

Types shared by the server and web (`PublicAuthStatus`, `ProbeKind`, `ProbeReport`) live in `server/src/public-types.ts`, and web imports them through a path alias. They contain no token fields, so that leak path is closed by construction.

---

## 5. Rationale: alternatives considered and rejected

| Alternative                                                                | Why rejected                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SPA-only PKCE (no backend)**                                             | The access token would sit in browser JS, which violates the token rule. The browser also can't verify a loopback redirect to a non-Vite port. Hono is required, not optional.                                                         |
| **Separate ephemeral-port callback listener per attempt** (RFC 8252 style) | Two servers and a port per attempt, plus the redirect*uri changes every time, and the issued `oaiapp*` client may be bound to the registered redirect. One fixed, configurable loopback port on the Hono server is simpler and stable. |
| **Vite serves the callback** (`127.0.0.1:5173/auth/callback` proxied)      | It works in dev but ties the OAuth redirect to the dev server. A Hono-owned callback also works headless and in a built mode.                                                                                                          |
| **Booleans (`isLoggedIn`, `isPending`, `error`)**                          | They allow impossible combinations, such as a callback with no attempt, or a refresh racing a sign-out. A tagged union plus a pure reducer makes these illegal and testable.                                                           |
| **Persisting tokens (keychain/file)**                                      | Out of scope ("no session"). Signing in again per run costs a few seconds. Only the host id and issued client_id are persisted, because re-registering every run would create orphan clients and change identity.                      |
| **Relaying the SSE stream to the browser**                                 | More surface (an SSE endpoint, partial UI state) for no added information. The question is pass/fail, so the server consumes the stream and returns a report that includes the event-type trace as evidence.                           |
| **OpenAI SDK for Responses**                                               | The SDK normalizes errors and events. We need the raw HTTP status, raw error body, and exact event types to tell `route_not_supported` apart from auth failures. Plain `fetch` plus a 30-line SSE parser keeps the evidence intact.    |
| **`tool_choice: "auto"` for the image probe**                              | The model could answer in text, and the result would be ambiguous. Forcing the tool turns "completed without an image" into a hard failure.                                                                                            |
| **One combined probe**                                                     | It can't separate "auth/plan path broken" from "image tool unsupported". The text probe proves auth and plan routing. The image probe then isolates tool support.                                                                      |
| **Generic `/api/responses` passthrough**                                   | This would effectively hand out a bearer proxy to any local page and widen the public surface. Two fixed probes are the smallest surface that answers the question.                                                                    |
| **Fallback to the Images API (`/v1/images`) when the tool fails**          | It answers a different question (and may not accept SIWC tokens). It could be noted as a follow-up probe, but it is deliberately out of scope so the verdict stays about the documented route.                                         |

### Open items to confirm against the SIWC docs during implementation

- The exact authorize/token/JWKS URLs and the parameter name for `ext_agent_host_id`, and whether the issued `client_id` arrives as a callback query param or in the token response. `handleCallback` accepts both.
- The claim path for plan type in the id_token (informational only, not gating).
- The exact error shape for `route_not_supported` (HTTP 403 body vs. a `response.failed` event). The classifier checks both, and the fixtures should be replaced with real captures on first run.
