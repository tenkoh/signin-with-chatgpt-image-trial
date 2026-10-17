# Run the Sign in with ChatGPT image probe

This app answers one question. After you sign in with ChatGPT, can a local client run the Responses `image_generation` tool on your ChatGPT plan?

OpenAI's preview limits say image generation is not supported on that route. The text probe checks sign-in and plan usage. The image probe forces the tool. The page shows `pass`, `unsupported`, `auth_failed`, or `error`.

The browser receives account status and probe reports. Access tokens stay in the Hono process and are dropped when that process exits.

## Start the app

From this directory:

```bash
pnpm install
pnpm dev
```

Hono listens on `http://127.0.0.1:1455`. Vite listens on `http://127.0.0.1:5173` and proxies `/api` to Hono. The OAuth callback is `http://127.0.0.1:1455/auth/callback`.

Open `http://127.0.0.1:5173`.

1. Click **Sign in with ChatGPT**. Approve the request in the new tab.
2. Close the callback tab when it says you are signed in. The original page updates within about a second.
3. Click **Run text probe**. The verdict is `pass` when the model returns text.
4. Click **Run image probe**.
   - `pass` means the route returned an image.
   - `unsupported` means the route rejected image generation.
   - `auth_failed` means the token was rejected, or a 403 was not a route-support error.
   - `error` means the call failed for another reason. Open **Evidence** for the status and the event list.

Check the code without starting the servers:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
```

`pnpm format` writes formatting changes. `pnpm lint:fix` applies oxlint fixes.

## Change the port, model, or state directory

| Variable         | Default       | What it sets                                                                                                              |
| ---------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `SIWC_PORT`      | `1455`        | Loopback port. The redirect URI uses this port. Set it in the environment of `pnpm dev` so Vite proxies to the same port. |
| `SIWC_STATE_DIR` | `~/.siwc-poc` | Directory for `registration.json`.                                                                                        |
| `SIWC_MODEL`     | `gpt-5.6-sol` | Model name sent on both probes.                                                                                           |

`registration.json` stores this machine's host id and, after the first sign-in, the issued client id. The file mode is `0600`. The first authorization uses `client_id=dynamic_agent_client` and `agent_name_hint=SIWC Image PoC`. Later sign-ins reuse the issued client id.

The redirect URI is `http://127.0.0.1:<port>/auth/callback`. Do not use `localhost`.
