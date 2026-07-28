# AGENTS.md

## Project overview

Cloudflare Workers app (Hono + D1 + KV) with a React SPA frontend (Vite). Central passkey-only authentication service providing L1 (forward_auth for Caddy) and L2 (OAuth2 for apps). Identity is **Passkey / Google / Microsoft only** — there is no password login and no open self-registration. All accounts are created by an admin and activated by the account holder.

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

**Build is required before `dev` or `deploy`** — Vite builds `app/` (React SPA) into `dist/` which the Worker serves as static assets.

**`tsc --noEmit` only checks `src/`** (Worker code, per `tsconfig.json` `include`). The React frontend in `app/` is compiled by Vite and is not type-checked.

## Architecture

### Wrangler configs

| File | Purpose | Git |
|------|---------|-----|
| `wrangler.jsonc` | Workers Builds (primary auth domain) | committed |
| `wrangler.production.jsonc` | Alternative Workers Builds config | from `.example`, committed after provision |
| `wrangler.local.jsonc` | Local dev | gitignored |
| `wrangler.<name>.jsonc` (e.g. secondary manual-deploy domains) | Manual deploy to additional auth domains | gitignored (public repo) |

All wrangler commands need `--config <file>` to target the right config. Never run wrangler without it. Each additional auth domain gets its own gitignored `wrangler.<slug>.jsonc` — never commit these (they contain real D1/KV resource IDs tied to a specific domain).

### Directory layout

| Path | Purpose |
|------|---------|
| `src/index.ts` | Worker entrypoint (Hono router) |
| `src/lib/` | DB, session, webauthn, backup, OAuth, activation-link helpers |
| `src/routes/` | API route handlers |
| `src/middleware/auth.ts` | `requireAuth` + `requireAdmin` middleware |
| `src/types.ts` | `Env`, `User`, `SessionRow`, `AuthContext`, `StoredChallenge` |
| `app/` | React SPA (Vite root, outputs to `dist/`) |
| `app/src/pages/admin/` | Admin console (users, clients, integration, config, logs) |
| `app/src/pages/me/` | Self-service account pages (`MeLayout` + `MeProfilePage`), same sidebar layout style as admin |
| `migrations/` | D1 SQL migrations (numbered order) |

### Bindings

- **D1** (`DB`) — users, passkeys, sessions, audit_logs, clients, OAuth tables, `complete_links` (activation links), etc.
- **KV** (`CHALLENGES`) — WebAuthn challenge storage (60s TTL) and OAuth anti-CSRF state
- **Assets** (`ASSETS`) — serves `dist/` with SPA fallback
- **Secrets** — `SESSION_SECRET` (HMAC cookie signing, stored in `.dev.vars` for local / Cloudflare Secrets for prod)

### Session model

Cookie types with different paths and TTLs:
- `sid` — normal authenticated session (path `/`)
- `setup_sid` — first-time setup session (path `/api/setup`, TTL: `SETUP_TTL_SECONDS`)

Cookies are HMAC-SHA-256 signed (`sessionId.signature`). Sessions are stored server-side in D1 with a `kind` column.

### Auth flows

- **Setup**: First admin (`root`) registers passkey → system transitions `NEEDS_SETUP → ACTIVE`
- **Login**: WebAuthn authentication challenge (KV, 60s) → verify → session cookie. Login page offers three equal-weight options: Passkey, Google, Microsoft.
- **No open registration**: there is no `/register` route and no `registrationEnabled` toggle. All users are created by an admin.
- **Admin user creation**: Admin creates user (name, optional email) with `status: 'pending'`. If email is omitted, auto-generates `username@domain` (derived from `ORIGIN`; used only for OIDC email-claim matching, unrelated to Google/Microsoft identity). Duplicate names get numbered suffix.
- **Activation (`complete_links` table)**: Admin generates a one-time activation link for a pending (or already-active, for identity reset) user from **用户管理**. The link is valid 15 minutes, can be opened at most 3 times, and only one active link exists per user at a time (generating a new one invalidates the previous one). The user opens the link and completes activation via **any one of**: Passkey registration, Google OAuth, or Microsoft OAuth. Completing any one of them sets `status: 'active'` and consumes the link. See `src/lib/complete.ts` + `src/routes/complete.ts` + `app/src/pages/CompletePage.tsx`.
- **OAuth binding is self-service only**: a user (including admins) can only bind/rebind/unbind their **own** Google/Microsoft identity — via `/me/profile` for regular users, or the same icon-click flow in `AdminUsersPage` for an admin's own row. Admins **cannot** bind or unbind OAuth identities on behalf of other users (`handleBindMode` / `authorizeBindStart` in `src/routes/oauth.ts` and the `DELETE /api/admin/users/:id/{google,microsoft}-link` endpoints all enforce `targetId === operator.id`). Viewing another user's Google/Microsoft icon in the admin list is read-only.
- **Passkey delegate** (`/link-device`): Admin generates a 600s one-time token so any user (already pending or active) can register an *additional* Passkey from another device via QR/link, without a full activation flow. Separate from the `complete_links` mechanism above.
- **Legacy invite flow** (`src/routes/invite.ts`, `app/src/pages/InvitePage.tsx`, `POST /api/admin/invites`): still present in the codebase but **no longer wired into the admin UI** — superseded by the `complete_links` activation mechanism. Treat as dead code unless explicitly revived.
- **Social OAuth**: Google + Microsoft login/bind. Email normalization for Gmail (dots stripped).
- **L2 OAuth2**: Full authorization_code flow for third-party clients

### Root admin

Earliest-created admin is always named `root`. Cannot be renamed, disabled, or deleted. Excluded from encrypted backups; backup import never overwrites root.

### Encrypted backup

AES-256-GCM + PBKDF2 (100k iterations, Workers Web Crypto API limit). Root user excluded. Import replaces all non-root data after preview+confirm.

## Gotchas

- **No linter, formatter, or test suite** — only `tsc --noEmit` for verification
- **`tsc --noEmit` must pass** — all TypeScript errors were fixed. Keep it clean.
- **Passkey flows require a real browser** — platform authenticator or security key. API-only smoke tests can't exercise registration/login.
- **`SESSION_SECRET`** must be ≥32 chars and never committed (`.dev.vars` is gitignored)
- **Additional-domain wrangler configs must not be committed** (public repo, contains real D1/KV IDs). Deploy manually: `npm run build && npx wrangler deploy --config wrangler.<slug>.jsonc`
- **Forward auth** (`/api/verify`) returns 302 (not 401) when unauthenticated — Caddy's `forward_auth` directive handles this correctly
- **Migrations run separately**: `db:migrate:local` before local dev, `db:migrate:remote:workers` is bundled into `deploy:workers`
- **Email field**: users have an email (unique) used **only** for OIDC relying-party matching (e.g. Immich) — it has no relationship to the Google/Microsoft identity used for login. Admin sets it on creation (optional — auto-generates `username@domain` if blank). Users can edit their own email via `PUT /me/email`. Admin can edit any user's email.
- **Global button styling**: `button`/`.btn` base rules were unified to match the `.credential-btn` look (dark navy fill `#121f36`, `#3e4c69` border) used in **用户管理**. Any new page should rely on the shared base styles rather than introducing a new button look.
- **Deploy scripts** (`scripts/`) handle full provisioning (D1, KV, secrets, domain binding) from just an auth hostname. `npm run deploy:full` calls `scripts/full-deploy-cloudflare.sh`. Use these for greenfield deploys; manual `wrangler deploy` for updates to an existing Worker.

## OIDC / generic SSO support

Phase 1 implemented:
- `GET /.well-known/openid-configuration` — standard OIDC discovery document
- `GET /.well-known/jwks.json` — RS256 public signing key
- `/api/l2/token` returns a proper JWT `id_token` signed with RS256
- Access tokens remain opaque (stored as SHA-256 hashes in D1)
- Signing key is auto-generated on first use and persisted in the `settings` table

PVE, Grafana, Immich, and other OIDC Relying Parties can now use the Worker as an issuer. Set the Issuer URL to `ORIGIN`.

When integrating with Immich: ensure pauth users have a real email set (not the auto-generated placeholder). Immich matches users by email claim. Users and admins can update email via the web UI. The mobile app redirect URI `app.immich:///oauth-callback` is supported (pauth accepts any valid URL scheme as `redirect_uri`).
