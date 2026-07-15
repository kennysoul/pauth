# AGENTS.md

## Project overview

Cloudflare Workers app (Hono + D1 + KV) with a React SPA frontend (Vite). Central passkey-only authentication service providing L1 (forward_auth for Caddy) and L2 (OAuth2 for apps).

## Key commands

```bash
# First time setup
cp wrangler.local.jsonc.example wrangler.local.jsonc   # fill in D1/KV IDs + domain vars
cp .dev.vars.example .dev.vars                           # SESSION_SECRET (≥32 chars)
npm install
npm run db:migrate:local
npm run build
npm run dev

# Deploy (local wrangler config)
npm run deploy

# CI / Workers Builds deploy
npm run deploy:workers

# Type-check (no test suite exists)
npx tsc --noEmit
```

**Build is required before `dev` or `deploy`** — Vite builds `app/` into `dist/` which the Worker serves as static assets.

## Architecture

### Three wrangler configs

| File | Purpose | Git |
|------|---------|-----|
| `wrangler.jsonc` | Workers Builds / Deploy badge CI | committed |
| `wrangler.local.jsonc` | Local dev + manual deploy | gitignored |
| `wrangler.production.jsonc` | Private GitHub Builds | committed (private repos) |

### Directory layout

| Path | Purpose |
|------|---------|
| `src/index.ts` | Worker entrypoint (Hono router) |
| `src/lib/` | DB, session, webauthn, backup, OAuth helpers |
| `src/routes/` | API route handlers |
| `src/middleware/auth.ts` | `requireAuth` + `requireAdmin` middleware |
| `src/types.ts` | `Env`, `User`, `SessionRow`, `AuthContext`, `StoredChallenge` |
| `app/` | React SPA (Vite root, outputs to `dist/`) |
| `migrations/` | D1 SQL migrations (numbered order) |

### Bindings

- **D1** (`DB`) — 15 tables: users, passkeys, sessions, audit_logs, clients, OAuth tables, etc.
- **KV** (`CHALLENGES`) — WebAuthn challenge storage (60s TTL) and OAuth anti-CSRF state
- **Assets** (`ASSETS`) — serves `dist/` with SPA fallback
- **Secrets** — `SESSION_SECRET` (HMAC cookie signing, stored in `.dev.vars` for local / Cloudflare Secrets for prod)

### Session model

Three cookie types with different paths and TTLs:
- `sid` — normal authenticated session (path `/`)
- `setup_sid` — first-time setup session (path `/api/setup`, TTL: `SETUP_TTL_SECONDS`)
- `reg_sid` — self-registration session (path `/api`, TTL: `SETUP_TTL_SECONDS`)

Cookies are HMAC-SHA-256 signed (`sessionId.signature`). Sessions are stored server-side in D1 with a `kind` column.

### Auth flows

- **Setup**: First admin (`root`) registers passkey → system transitions `NEEDS_SETUP → ACTIVE`
- **Login**: WebAuthn authentication challenge (KV, 60s) → verify → session cookie
- **Registration**: Gated by `registrationEnabled` system config toggle. New users land in `pending` status.
- **Invites**: Admin-generated token (7-day TTL) → invitee registers passkey → auto-activates
- **Passkey delegate**: Admin generates 600s token for a user to register an additional passkey without logging in
- **Social OAuth**: Google + Microsoft login/bind. Email normalization for Gmail (dots stripped).
- **L2 OAuth2**: Full authorization_code flow for third-party clients

### Root admin

Earliest-created admin is always named `root`. Cannot be renamed, disabled, or deleted. Excluded from encrypted backups; backup import never overwrites root.

### Encrypted backup

AES-256-GCM + PBKDF2 (310k iterations). Root user excluded. Import replaces all non-root data after preview+confirm.

## Gotchas

- **No linter, formatter, or test suite** — only `tsc --noEmit` for verification
- **`tsc --noEmit` currently has pre-existing errors** (~9 across 6 files): `src/index.ts` has a broken `../types` import (should be `./types`), plus a few type-cast issues in `oauth-config.ts`, `webauthn.ts`, `auth.ts`, `admin.ts`, and `passkey-delegate.ts`. The bundler (wrangler/esbuild) resolves these at build time, but new code should fix rather than replicate these patterns.
- **Passkey flows require a real browser** — platform authenticator or security key. API-only smoke tests can't exercise registration/login.
- **`SESSION_SECRET`** must be ≥32 chars and never committed (`.dev.vars` is gitignored)
- **`wrangler.jsonc`** placeholder values must be replaced before deploy (D1/KV IDs, domain vars)
- **Forward auth** (`/api/verify`) returns 302 (not 401) when unauthenticated — Caddy's `forward_auth` directive handles this correctly
- **Migrations run separately**: `db:migrate:local` before local dev, `db:migrate:remote:workers` is bundled into `deploy:workers`

## OIDC / generic SSO support

Phase 1 implemented:
- `GET /.well-known/openid-configuration` — standard OIDC discovery document
- `GET /.well-known/jwks.json` — RS256 public signing key
- `/api/l2/token` returns a proper JWT `id_token` signed with RS256
- Access tokens remain opaque (stored as SHA-256 hashes in D1)
- Signing key is auto-generated on first use and persisted in the `settings` table

PVE, Grafana, and other OIDC Relying Parties can now use the Worker as an issuer. Set the Issuer URL to `ORIGIN`.
