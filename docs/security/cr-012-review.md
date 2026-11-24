# Security review: the owner panel (CR-012)

- **Date:** 2026-11-19
- **Reviewer:** the integrator session, which wrote none of the reviewed code. This is an AI
  code review, not a third-party audit. It must never be cited as an audit.
- **Scope:** `main` at `4e82a7e`.
  - guard-core:
    - owner sessions: `http/owner-session.ts`, `service/sessions.ts`;
    - step-up: `service/step-up.ts`, `service/passkeys.ts`, `db/passkeys.ts`;
    - owner routes: `http/owner-panel.ts`, `http/control.ts`, `domain/loosen.ts`;
    - panel serving: `http/panel.ts`;
    - Web Push: `service/push.ts`, `adapters/push.ts`, `domain/push-host.ts`;
    - `TELEGRAM_APPROVALS` in `http/bot.ts`.
  - The panel: `packages/panel`.
  - The bot's owner commands, as they interact with CR-012.
- **Method:** read the code against SPEC v0.10 and the threat model CR-012 states: an approval
  must not depend on the owner's Telegram account. Each finding names an attack path, the fix
  and the owner of the fix.

## Findings

### H1: a stolen Telegram account can still widen what an agent may do, with no passkey

CR-012 makes every approval a passkey approval. With `TELEGRAM_APPROVALS=false`, Telegram can
reject but not approve.

The bot's owner commands (CR-011) still loosen policy through the admin API, with no passkey:

- `/agent new <id>` creates an agent and shows its token in the chat;
- `/policy` presets raise limits;
- `/allow` adds x402 domains;
- `/mode live` turns signing on;
- `/resume` lifts a pause, which in the panel needs a step-up.

**Attack path.** Someone who takes over the owner's Telegram account:

1. creates an agent and gets its token;
2. allows a domain they control;
3. raises the agent's limits and switches it live.

That agent then pays the attacker's x402 endpoint, below the approval threshold, up to the
onchain cap. The onchain cap still bounds the loss, but the passkey, the protection CR-012 adds,
is never asked for.

**Root cause.** The bot holds `ADMIN_TOKEN`. guard-core cannot tell the bot apart from the
owner's own scripts.

**Fix.**

1. **Bot (panel role), now.** With `TELEGRAM_APPROVALS=false`, the bot refuses every command that
   loosens anything: `/agent new`, `/allow`, a `/policy` preset that raises a limit, `/mode live`,
   `/resume`. It answers "Do this in the DefiMind panel." Tightening commands stay: `/deny`,
   `/mode shadow`, `/pause`, `/kill`, `/agent revoke`. This closes the attack path, because the
   attacker controls Telegram, not the bot's server.
2. **guard-core and SPEC, CR-016.** The bot stops holding `ADMIN_TOKEN`. It gets tightening-only
   routes under `/v1/bot/*`, authenticated with its own `BOT_TOKEN`. Then a compromised bot server
   cannot loosen policy either.

**Test.** The e2e suite shows that, with Telegram approvals off, none of these commands changes
the policy, and that the panel's step-up is the only way to make those changes.

### M1: the first passkey can be enrolled from Telegram

`/passkey enrol` asks guard-core for an enrolment code and sends the link to the chat. While no
passkey is enrolled, the code alone adds one (CR-010).

**Attack path.** Someone who controls the owner's Telegram account before the owner enrols a
passkey can enrol their own passkey first, and then own the panel. The `passkey_enrolled` alert
goes to the same Telegram account, so the owner may never see it.

**Fix (bot, panel role).** With `TELEGRAM_APPROVALS=false`, `/passkey enrol` refuses and tells the
owner to run `pnpm passkey-code` on the machine. The wizard already does that at its last step,
which makes the machine the only place a first passkey can come from.

**Test.** The bot test shows that the command issues no code when Telegram approvals are off.

### L1: the public listener's rate limit trusts `Fly-Client-IP` from anyone

On the public listener, the rate-limit key is the `fly-client-ip` header whenever it is a valid
IP. Behind Fly the proxy sets that header. Anywhere else a client can set a new value on each
request and is never limited. That matters for `POST /v1/owner/session/options`, which writes a
row per call.

**Fix (guard-core).** Trust the header only when a setting says guard-core runs behind Fly, for
example `TRUST_FLY_CLIENT_IP=true`, which `deploy-fly.sh` sets. Use the socket address otherwise.

### Info: the admin API needs no passkey

`PUT /v1/admin/policy` and the other admin routes on the private listener loosen policy with the
admin token alone. That is by design: they serve the owner's scripts and the wizard.

The self-host guide should say plainly that `ADMIN_TOKEN` is worth as much as the owner, so it
belongs only on the machine. H1's fix removes the one place outside the machine that holds it,
the bot.

## What holds

- **Sessions.**
  - The token is 32 random bytes, and only its SHA-256 is stored.
  - The cookie is HttpOnly, Secure, `SameSite=Strict` and `Path=/v1/owner`.
  - A session lasts 30 minutes idle and 12 hours in all. Removing a passkey ends its sessions in
    the same transaction.
  - Cookies and `Set-Cookie` are redacted from logs.
- **CSRF.**
  - Every state change needs `X-DefiMind-Request: 1` and `Origin == PASSKEY_ORIGIN`, sign-in
    included.
  - GET routes send no CORS headers, so a foreign page cannot read them.
- **Step-up.**
  - The challenge is keyed by `sha256(canonical {action, body})`, and the body is rebuilt from the
    request that carries the assertion. The policy body is hashed exactly as sent.
  - A challenge is used up only by a verified answer, with compare-and-delete, so it cannot be
    replayed or raced.
  - A sign-in assertion cannot serve as a step-up or the other way round, because their purposes
    differ.
  - User verification is required everywhere.
- **Loosening.**
  - Every `Policy` field that can widen access is covered, including the three CR-015 adds.
  - An omitted field keeps its stored value, so leaving a field out cannot skip the check.
- **Panel serving.**
  - Only a fixed list of build files is read from disk, so there is no path traversal.
  - The CSP matches SPEC, with `nosniff`, `frame-ancestors 'none'`, HSTS and `no-referrer`.
  - `index.html` and `sw.js` are served `no-cache`.
- **The panel itself.**
  - It runs no third-party script, and there is no `innerHTML` or `eval`.
  - Every response is parsed with zod and set as text.
  - Money is handled as bigint.
  - Only `401 no_session` ends the session.
  - The service worker caches the app shell only, never API data, and opens only `/panel/` paths.
- **Web Push.**
  - Endpoints are limited to the browser push services, over https on port 443, by name, and are
    checked again before every send.
  - Payloads carry no recipient or URL.
  - Failures log only the status and host.
  - The VAPID key is a file in tmpfs.
- **Telegram.** With `TELEGRAM_APPROVALS=false`, `/v1/bot/decision` and the mandate decision refuse
  approve with 403 `approve_in_panel`. e2e covers it (INT-30).

## Status

| Finding | Fixed in | Note                                                                                                          |
| ------- | -------- | ------------------------------------------------------------------------------------------------------------- |
| H1      | #20      | With `TELEGRAM_APPROVALS=false` the bot refuses every loosening command. Server-side scoping waits on CR-016. |
| M1      | #20      | `/passkey enrol` points to `passkey-code` on the machine.                                                     |
| L1      | #19, #21 | `TRUST_FLY_CLIENT_IP`, set in `fly.toml` and in the self-host compose behind Caddy.                           |

## Before launch

1. CR-016, the bot without the admin token, decided by the owner.
2. The owner decides whether a paid third-party audit comes before the panel's mainnet launch.
