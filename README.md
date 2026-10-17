# Sign in with ChatGPT — image generation PoC

Local PoC that asks one question: after Sign in with ChatGPT (OSS plan usage), can `POST /v1/responses` run the `image_generation` tool on the user’s ChatGPT plan?

Docs currently mark that tool unsupported on this route. The UI separates a text smoke (auth/plan path) from a forced image-tool probe so the failure mode is clear.

## Stack

- Hono server on `127.0.0.1:1455` (OAuth callback + tokens + probes)
- React + Vite on `127.0.0.1:5173` (proxies `/api` and `/auth`)
- Lint/format: `oxlint` + `oxfmt`

## Run

```bash
pnpm install
pnpm dev
```

Open `http://127.0.0.1:5173`.

1. Click **Continue with ChatGPT** and approve in the browser.
2. Run **text probe**, then **image probe**.
3. Read the summary line and each verdict (`pass` / `unsupported` / `auth_failed` / `error`).

## Scripts

```bash
pnpm lint
pnpm format
pnpm format:check
pnpm test
```

## Env

| Variable          | Default          | Meaning                                  |
| ----------------- | ---------------- | ---------------------------------------- |
| `SIWC_PORT`       | `1455`           | Loopback port inside `redirect_uri`      |
| `SIWC_STATE_DIR`  | `~/.siwc-poc`    | Stores host id + issued `client_id` only |
| `SIWC_MODEL`      | `gpt-5`          | Model slug for both probes               |
| `SIWC_AGENT_NAME` | `siwc-image-poc` | `agent_name_hint` on first registration  |

Tokens stay in process memory. Restarting the server requires sign-in again.
