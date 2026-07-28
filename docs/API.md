# pauth API Reference

Route index for the **implemented** pauth Worker API. Replace `https://auth.example.com` with your deployment `ORIGIN`.

**Detailed examples:** [`md/pauth-l1-l2-api-json-examples.md`](../md/pauth-l1-l2-api-json-examples.md)  
**OpenAPI:** [`md/pauth-l2-openapi-v1.yaml`](../md/pauth-l2-openapi-v1.yaml)  
**Architecture & flows:** [`cf-passkey-auth-v3.md`](../cf-passkey-auth-v3.md), [`md/pauth-l1-l2-upgrade-plan-and-spec.md`](../md/pauth-l1-l2-upgrade-plan-and-spec.md)

---

## Terminology

| Term | Prefix | Purpose |
|------|--------|---------|
| **L1** | `GET /api/verify` | Gateway forward-auth (Caddy). Requires session + `active` user + L1 grant. |
| **OAuth L2** | `/api/l2/*` | Application login (authorization code). Apps register a Client ID. |
| **Social login** | `/api/oauth/*` | Google / Microsoft sign-in on the auth host (not app OAuth). |
| **Passkey delegate** | `/api/passkey-delegate/*` | One-time admin link so an existing user can register an *additional* Passkey on another device. |
| **Account activation** | `/api/complete/*` | One-time admin link for activating a new user (or letting an active user add/reset an identity). Supports Passkey, Google, or Microsoft. |
| **Invite (legacy)** | `/api/invite/*` | Older invite flow; still served but **no longer wired into the admin UI** — superseded by `/api/complete/*`. Treat as dead code unless explicitly revived. |

---

## Auth legend

| Symbol | Meaning |
|--------|---------|
| — | No session required |
| cookie | Valid `sid` cookie; user `status === active` |
| admin | cookie + `role === admin` |
| setup | Valid `setup_sid` cookie (bootstrap only) |

**CSRF:** Mutating `/api/*` requests check `Origin` (server-to-server L2 token calls may omit Origin).

**Cookies:** `sid` (normal authenticated session), `setup_sid` (bootstrap only). Sessions are HMAC-SHA-256 signed and stored server-side in D1 with a `kind` column. There is no longer a `reg_sid` cookie — see the **Account activation** section below.

---

## System

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/system/state` | — | `{ state, origin }` (no `registrationEnabled` — open self-registration is not supported) |
| GET | `/api/verify` | cookie† | L1 gateway check. **200** + `X-Auth-User-*` or **302** → `/login?return_to=...` |

† Requires L1 grant (`user_l1_access.enabled`). Used by Caddy `forward_auth`, not browser navigation.

---

## Bootstrap (setup)

Only when `state === NEEDS_SETUP`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/setup/begin` | — | Create/resume bootstrap admin (`name: root`); sets `setup_sid` |
| POST | `/api/setup/passkey/options` | setup | WebAuthn registration options |
| POST | `/api/setup/passkey/verify` | setup | Complete bootstrap; `state → ACTIVE`; sets `sid` |

---

## Login & logout

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/login/options` | — | WebAuthn authentication options (discoverable) |
| POST | `/api/login/verify` | — | Verify Passkey; sets `sid`. Returns `{ ok, redirect }` (JSON, not HTTP 302) |
| POST | `/api/login/logout` | cookie | Delete session; clear `sid` |

Login rejects `pending` / `disabled` users. `return_to` in verify body must pass [`return-to` whitelist](../src/lib/return-to.ts).

---

## Account activation (`/api/complete/*`)

Admin creates a user (pending) and generates a **completion link**. The user opens the link and activates via **any one of**: Passkey registration, Google OAuth, or Microsoft OAuth. Each user has at most one active link at a time; generating a new one invalidates the previous one.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/complete/:token` | — | `{ name, role, status, expiresAt, openCount, maxOpens }` — also increments `openCount` (hard cap = 3) |
| POST | `/api/complete/:token/passkey/options` | — | WebAuthn registration options |
| POST | `/api/complete/:token/passkey/verify` | — | Save Passkey; `status → active` if pending; mark token used |

OAuth activation (`mode=register`) flows through `/api/oauth/{google,microsoft}/start?mode=register&complete_token=...` → callback → activates user (if pending) and binds the identity in one step. The same `sub` may not be bound to two users at once.

Frontend: `/complete/:token`

---

## Passkey delegate (`/api/passkey-delegate/*`)

Separate from activation above: an **existing** user opens the link to register an *additional* Passkey on a new device. Status does not change (the user is already active). Does **not** consume a token until the user actually registers.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/passkey-delegate/:token` | — | `{ name, valid }` |
| POST | `/api/passkey-delegate/:token/options` | — | WebAuthn registration options |
| POST | `/api/passkey-delegate/:token/verify` | — | Add Passkey to target user; mark token used |

Admin: `POST /api/admin/users/:id/passkeys/delegate` → `{ token, link, expiresIn }`  
Frontend: `/link-device?t=<token>`

---

## Invites (legacy, kept for backwards compatibility)

Admin-created invite links. User becomes **`active`** after Passkey registration (no second approval). **No longer wired into the admin UI** — superseded by `/api/complete/*`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/invite/:token` | — | `{ name, role }` metadata |
| POST | `/api/invite/:token/begin` | — | Start invite session; sets `reg_sid` |
| POST | `/api/invite/:token/passkey/options` | register | WebAuthn options |
| POST | `/api/invite/:token/passkey/verify` | register | Complete invite; `status → active` |

Frontend: `/invite/:token`

---

## Current user (`/api/me`)

Self-service account management. **All OAuth link/unlink endpoints enforce self-service only** — the `targetId` must match the caller's own user id; the server rejects any attempt to bind or unbind on behalf of another user (including admin attempting to bind/unlink another user's OAuth).

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/me` | cookie | Current user profile |
| GET | `/api/me/passkeys` | cookie | List own Passkeys |
| POST | `/api/me/passkeys/options` | cookie | Add Passkey — options |
| POST | `/api/me/passkeys/verify` | cookie | Add Passkey — verify |
| DELETE | `/api/me/passkeys/:id` | cookie | Delete Passkey (must keep ≥1 identity: Passkey or OAuth) |
| PUT | `/api/me/name` | cookie | Update own display name |
| PUT | `/api/me/email` | cookie | Update own email (used for OIDC RP matching) |
| GET | `/api/me/oauth` | cookie | `{ googleLinked, googleEmail, microsoftLinked, microsoftEmail, hasPasskey, ... }` |
| DELETE | `/api/me/oauth/google-link` | cookie | Unlink own Google (must keep ≥1 identity) |
| DELETE | `/api/me/oauth/microsoft-link` | cookie | Unlink own Microsoft (must keep ≥1 identity) |

---

## OIDC Discovery

Standard OpenID Connect Discovery (RFC 8414). No authentication required.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/.well-known/openid-configuration` | — | `{ issuer, authorization_endpoint, token_endpoint, userinfo_endpoint, jwks_uri, … }` |
| GET | `/.well-known/jwks.json` | — | RS256 public signing key (`{ keys: [{ kid, kty, use, alg, n, e }] }`) |

Discovery returns all endpoint URLs derived from `ORIGIN`. OIDC clients only need the **Issuer URL** (`ORIGIN`) to auto-configure.

---

## OAuth L2 (application login)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/l2/authorize` | cookie | Browser redirect; issues auth code. Query: `client_id`, `redirect_uri`, `response_type=code`, **`state`** (required), optional `scope`, `nonce` |
| POST | `/api/l2/token` | — | Exchange code (`application/x-www-form-urlencoded`). Requires `client_secret` |
| GET | `/api/l2/userinfo` | Bearer | `{ sub, email, name }` from access token |

**Access rule:** active user + enabled client + (`L2_ONLY` or user has L1 if `L1_AND_L2`).  
**redirect_uri:** any HTTPS URL (or `http://localhost` / `127.0.0.1` for dev); must match between authorize and token.  
**TTL:** authorization code and access token **600s**; code single-use.

App env vars (from admin **应用管理**):

```text
PAUTH_CLIENT_ID=
PAUTH_CLIENT_SECRET=
PAUTH_AUTHORIZE_URL=<ORIGIN>/api/l2/authorize
PAUTH_TOKEN_URL=<ORIGIN>/api/l2/token
```

---

## Social login (Google / Microsoft)

Configured in admin **集成与安全**. Used by `/login`, account activation, and `/me` self-service linking.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/oauth/google/public-status` | — | `{ enabled }` |
| GET | `/api/oauth/microsoft/public-status` | — | `{ enabled }` |
| GET | `/api/oauth/google/start` | — | Redirect to Google. Query: `mode=login\|bind\|register`, `next=`, optionally `complete_token=` |
| GET | `/api/oauth/google/callback` | — | OAuth callback (browser) |
| GET | `/api/oauth/microsoft/start` | — | Redirect to Microsoft |
| GET | `/api/oauth/microsoft/callback` | — | OAuth callback (browser) |

`mode=login` — sign in (legacy + activation). `mode=bind` — link to current session (self-service `/me`). `mode=register` — bind during activation via `/complete/:token`. All bind/register flows reject sub reuse across users.

---

## Admin (`/api/admin/*`)

All routes require **admin** session unless noted. Admins can create users, generate activation links, manage clients, and configure OAuth providers — but **cannot** bind or unbind another user's Google/Microsoft identity.

### Users

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/users` | List users. Query: `?status=pending\|active\|disabled` |
| POST | `/api/admin/users` | Create user (`status: pending`); returns `{ userId }` |
| PATCH | `/api/admin/users/:id` | Update `name` / `email` / `status` (approve/disable). **root** protected. Email changes don't affect OAuth identity. |
| DELETE | `/api/admin/users/:id` | Delete user (cascade: passkeys / oauth_identities / sessions / complete_links / user_l1_access / user_client_access / invites). Cannot delete self, **root**, or last active admin |
| PUT | `/api/admin/users/:id/permissions` | `{ l1Enabled }` — only pauth-managed permission |
| POST | `/api/admin/users/:id/complete-link` | Generate (or regenerate) activation link. Returns `{ completeUrl, completeToken, expiresAt, ttlSeconds }`. Old tokens for the same user are voided. |

### User Passkeys (read-only listing; admin cannot bind)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/users/:id/passkeys` | List user's Passkeys (no secret material) |
| DELETE | `/api/admin/users/:id/passkeys/:pkId` | Delete user's Passkey |

### Passkey delegate link

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/admin/users/:id/passkeys/delegate` | Generate one-time `/link-device` URL (10-minute TTL). Returns `{ token, link, expiresIn }` |

### Invites (legacy, not surfaced in UI)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/admin/invites` | `{ name, role?, l1Enabled? }` → invite URL (7-day TTL). Kept for backwards compatibility; new flows use `/complete/*`. |

### User social OAuth (self-service only — see `/api/me`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| DELETE | `/api/admin/users/:id/google-link` | admin = caller id only | Unlink Google (must keep ≥1 identity) |
| DELETE | `/api/admin/users/:id/microsoft-link` | admin = caller id only | Unlink Microsoft (must keep ≥1 identity) |

Admins cannot bind or unlink another user's Google/Microsoft identity. Self-service bind/unlink lives under `/api/me/oauth/*`.

### OAuth clients (L2 apps)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/clients` | List clients |
| POST | `/api/admin/clients` | Create client; returns `clientSecret` once |
| PATCH | `/api/admin/clients/:clientId` | Update `name`, `accessMode`, `enabled` |
| POST | `/api/admin/clients/:clientId/regenerate-secret` | New secret |
| DELETE | `/api/admin/clients/:clientId` | Delete client |
| GET | `/api/admin/clients/:clientId/users` | List users with L1 grant for this client |
| PUT | `/api/admin/clients/:clientId/users` | Bulk set L1 grants (`{ userIds: string[] }`) |

`accessMode`: `L2_ONLY` (default) or `L1_AND_L2` (requires L1 grant for OAuth).

### Integration

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/integration/webauth` | WEBAUTH runtime display config |
| GET | `/api/admin/integration/google` | Google OAuth config (no secret) |
| POST | `/api/admin/integration/google` | Save Google OAuth config |
| POST | `/api/admin/integration/google/validate` | Validate Google credentials (returns `{ ok }` or error) |
| GET | `/api/admin/integration/microsoft` | Microsoft OAuth config |
| POST | `/api/admin/integration/microsoft` | Save Microsoft OAuth config |
| POST | `/api/admin/integration/microsoft/validate` | Validate Microsoft credentials |

### Encrypted backup

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/admin/backup/export` | `{ password }` → encrypted bundle (**excludes root** and their Passkeys/OAuth) |
| POST | `/api/admin/backup/preview` | `{ password, bundle }` → import preview |
| POST | `/api/admin/backup/import` | Replace non-root data |

UI: **系统设置 → 加密备份**

### Audit & reset

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/audit-logs` | Audit log list |
| DELETE | `/api/admin/audit-logs` | Clear all audit logs (admin action; writes a `AUDIT_CLEAR` entry first) |
| POST | `/api/admin/system/reset` | `{ confirmation: "RESET_ALL_I_UNDERSTAND" }` → `NEEDS_SETUP` |

---

## SPA frontend routes

| Path | When | Purpose |
|------|------|---------|
| `/setup` | `NEEDS_SETUP` | Bootstrap root admin Passkey |
| `/login` | `ACTIVE` | Passkey / Google / Microsoft login; `?return_to=` |
| `/invite/:token` | Valid invite token | Invite registration (legacy) |
| `/link-device` | Valid delegate token (`?t=`) | Passkey delegate registration (additional device) |
| `/complete/:token` | Valid completion token | Account activation (Passkey / Google / Microsoft) |
| `/complete/:token/passkey` | Valid completion token | Passkey activation shortcut (mobile deep link) |
| `/me` | cookie | Redirect to `/me/profile` |
| `/me/profile` | cookie | User sidebar — profile, name/email edit, own Passkey list, own OAuth bind/unlink |
| `/admin/users` | admin | Users, activation links, Passkey management (Google/Microsoft read-only for other rows) |
| `/admin/clients` | admin | OAuth client CRUD |
| `/admin/integration` | admin | Google / Microsoft / WEBAUTH |
| `/admin/config` | admin | Backup, factory reset |
| `/admin/logs` | admin | Audit logs |

All other paths → SPA (`dist/`) via Worker Assets.

---

## Common HTTP outcomes

| Endpoint | Success | Failure |
|----------|---------|---------|
| `/api/verify` | **200** + identity headers | **302** → login |
| `/api/login/verify` | **200** JSON `{ redirect }` | **403** pending/disabled; **400** bad Passkey |
| `/api/complete/:token/passkey/verify` | **200** JSON `{ ok: true }` | **410** "已失效" if token used/expired/voided/exhausted |
| `/api/oauth/{provider}/callback` (mode=login) | **302** → `/me` or `/admin` | **302** → `/login?oauth_error=...` (身份不符合) |
| `/api/oauth/{provider}/callback` (mode=register) | **302** → `/me` | **302** → `/login?oauth_error=激活链接已失效` if token bad |
| `/api/l2/authorize` | **302** → app with `code` | **302** `error=access_denied` or **400** JSON |
| `/api/l2/token` | **200** token JSON | **401** bad secret; **400** invalid_grant |
| `/api/me/oauth/{provider}-link` (DELETE) | **200** `{ ok: true }` | **400** "唯一验证身份，不可解绑" if it's the only identity |
| Admin mutations | **200** / **201** `{ ok: true }` | **400** / **403** / **409` with `{ error }` |

---

## root admin rules

- Bootstrap creates fixed display name **`root`** (earliest-created admin).
- API returns computed **`isRoot: true`** for this account (not a DB column).
- Cannot rename, disable, or delete via admin API.
- Encrypted backup **never includes** root or root Passkeys/OAuth.
- Factory reset **deletes all users** including root and returns to `NEEDS_SETUP`.

---

## Source of truth

Route mounting: [`src/index.ts`](../src/index.ts). When this document and code disagree, **code wins** — please file an issue or update this file.