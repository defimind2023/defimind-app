# @defimind/panel

The owner panel: a web app, installable on a phone, where the owner approves payments with a
passkey, edits each agent's policy in dollars and stops everything with one button. guard-core
serves it at `/panel/` on its public listener (SPEC, "Owner panel", CR-012). The Telegram bot is
optional next to it.

## What it does

| Screen       | Path                   | Notes                                                                         |
| ------------ | ---------------------- | ----------------------------------------------------------------------------- |
| First access | `/panel/setup`         | CR-019: the host's setup code issues the enrol link, until a passkey exists   |
| Enrol        | `/panel/enrol#code=…`  | First passkey only, from the link `passkey-code.ts` prints                    |
| Sign in      | `/panel/login`         | Passkey, then a 30-minute session cookie (`dm_session`)                       |
| Overview     | `/panel/`              | Waiting approvals, each chain's onchain allowance, agents                     |
| Approval     | `/panel/approvals/:id` | Reject, or approve with a fresh passkey assertion                             |
| Task budget  | `/panel/mandates/:id`  | The same for a mandate                                                        |
| Agents       | `/panel/agents`        | List, and create with a passkey: the token is shown once                      |
| Agent        | `/panel/agents/:id`    | Shadow or live with the shadow total, pause, resume, policy                   |
| Report       | `/panel/report`        | The last 7 days per agent                                                     |
| Executions   | `/panel/executions`    | CR-013 record: integrity, anchor, timeline, proof download                    |
| Doctor       | `/panel/doctor`        | guard-core's checks                                                           |
| Guided setup | `/panel/start[/:step]` | CR-019: nine steps, progress from guard-core, any step can be reopened        |
| Deposit      | `/panel/deposit`       | Each vault: balance, days of the daily limit, QR code, Phantom deposit        |
| Settings     | `/panel/settings`      | Each chain's RPC and vault (passkey), push on this device, passkeys, sign out |
| Stop         | `/panel/kill`          | Pauses every agent, then each chain's onchain step                            |

Every step-up (approve, approve a task budget, loosen a policy, resume, create an agent, change
settings) first asks `POST /v1/owner/challenge` for options bound to that exact action and body, then sends the
assertion with the call. The panel works out on its own whether a policy change loosens it
(`src/domain/policy.ts`, SPEC's list), so the passkey prompt comes before Save, not after a refusal.
guard-core decides again on its side.

## Security

- Static files only. No framework, no third-party script, no inline script or style: the page runs
  under SPEC's CSP (`script-src 'self'`, `connect-src 'self'`, `base-uri 'none'` …).
- Everything guard-core sends is checked with zod and only ever set as text, never as markup: the
  strings in an approval started with an agent or a 402 server.
- Every state-changing call sends `X-DefiMind-Request: 1`, which a cross-site form cannot.
- The enrol code is read from the fragment, so it never reaches a request line or a log, and the
  page drops it from the history once it is spent.
- The service worker caches the app shell only. API answers are never cached. A push payload holds
  no recipient and no link: a notification only opens a panel path.
- Amounts are bigint throughout. Dollars are shown only for the chain's verified dollar token;
  anything else is shown in base units with its address.

## Build and test

```sh
pnpm --filter @defimind/panel build      # dist/: index.html app.js app.css sw.js manifest.webmanifest icons/
pnpm --filter @defimind/panel test       # domain and API client
pnpm --filter @defimind/panel test:web   # Chromium with a virtual passkey, at 390 and 1280 px
```

`test:web` needs Chromium (`npx playwright install chromium`). It runs the built panel against a
stand-in guard-core (`test/web/guard.ts`) that checks the session cookie, the request header, the
Origin, and that each step-up assertion signs a challenge issued for that action and body. The
flows: enrol and sign in, approve with step-up, reject, loosen and tighten a policy, stop
everything, and a signed-out link coming back to its screen after sign-in.

## Serving it (guard-core)

`dist` is flat. guard-core redirects `/panel` to `/panel/`, serves files that exist, and answers
`index.html` for any other path under `/panel/` (the routes are client-side). `index.html` and
`sw.js` go out with `Cache-Control: no-cache` so a deploy reaches devices at once; the others can
be cached. The worker's scope is `/panel/`.

## Open items

- The logo is a placeholder drawn by `icons.ts` until the owner's arrives.
- Push reads `GET /v1/owner/push/key -> { publicKey }`, proposed (CR-014), not in SPEC until the owner approves it.
- `POST /v1/owner/kill` gains `link` (Phantom) and `pageLink` (desktop) per chain when guard-core has
  `SIGN_PAGE_URL`: proposed (CR-014). Without them the panel shows the transaction, and the bot's `/kill` buttons still
  work.
- `app.js` is about 480 kB minified, nearly all zod. The worker caches it, so only the first load
  pays for it.

## Guided setup (CR-019)

- The progress bar and the step the guide opens on come from `GET /v1/owner/setup/progress`, never
  from a flag the panel keeps. Phantom leaves no trace on the server, so it counts as done once the
  vault does.
- guard-core adopts a vault only once its daily limit names guard-core's hot wallet. The guide keeps
  the pasted address on this device (`localStorage`, public data) from the vault step to the limit
  step, then saves it with the `change_settings` passkey.
- Signing-page links point at `/sign` on the panel's own origin and never name a hot wallet.
- The deposit QR code is made in the page (`src/domain/qr.ts`: byte mode, level M, versions 1 to 10)
  and drawn as one SVG path, so the CSP stays as it is. Its tests decode every size with jsQR.
- The agent step prints the MCP setup command with `--guard-url` and `--agent-id`; the command asks
  for the token at a hidden prompt, so the token is never on a command line.
