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
| **Passkey delegate** | `/api/passkey-delegate/*` | One-time admin link for registering a Passkey on another device. |

---

## Auth legend

| Symbol | Meaning |
|--------|---------|
| — | No session required |
| cookie | Valid `sid` cookie; user `status === active` |
| admin | cookie + `role === admin` |
| setup | Valid `setup_sid` cookie (bootstrap only) |
| register | Valid `reg_sid` cookie (self-register or invite flow) |
| Bearer | `Authorization: Bearer <access_token>` from L2 token exchange |

**CSRF:** Mutating `/api/*` requests check `Origin` (server-to-server L2 token calls may omit Origin).

**Cookies:** `sid` (session), `setup_sid` (bootstrap), `reg_sid` (registration). See [`cf-passkey-auth-v3.md` §8](../cf-passkey-auth-v3.md).

---

## System

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/system/state` | — | `{ state, registrationEnabled, origin }` |
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

## Self-registration

Requires `state === ACTIVE` and `registrationEnabled === true`. New users stay **`pending`** until admin approval.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/register/begin` | — | `{ name, email }` → creates pending user; sets `reg_sid` |
| POST | `/api/register/passkey/options` | register | WebAuthn registration options |
| POST | `/api/register/passkey/verify` | register | Save Passkey; status stays `pending`; clears `reg_sid` |

---

## Invites

Admin-created invite links. User becomes **`active`** after Passkey registration (no second approval).

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/invite/:token` | — | `{ name, role }` metadata |
| POST | `/api/invite/:token/begin` | — | Start invite session; sets `reg_sid` |
| POST | `/api/invite/:token/passkey/options` | register | WebAuthn options |
| POST | `/api/invite/:token/passkey/verify` | register | Complete invite; `status → active` |

Frontend: `/invite/:token`

---

## Passkey delegate

Admin generates a one-time link from **用户管理 → Passkey → 代注册**.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/passkey-delegate/:token` | — | `{ name, valid }` |
| POST | `/api/passkey-delegate/:token/options` | — | WebAuthn registration options |
| POST | `/api/passkey-delegate/:token/verify` | — | Add Passkey to target user; invalidates token |

Admin: `POST /api/admin/users/:id/passkeys/delegate` → `{ token, link, expiresIn }`  
Frontend: `/link-device?t=<token>`

---

## Current user (`/api/me`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/me` | cookie | Current user profile |
| GET | `/api/me/passkeys` | cookie | List own Passkeys |
| POST | `/api/me/passkeys/options` | cookie | Add Passkey — options |
| POST | `/api/me/passkeys/verify` | cookie | Add Passkey — verify |
| DELETE | `/api/me/passkeys/:id` | cookie | Delete Passkey (must keep ≥1) |

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

Configured in admin **集成与安全**. Used by `/login` and account linking.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/oauth/google/public-status` | — | `{ enabled }` |
| GET | `/api/oauth/microsoft/public-status` | — | `{ enabled }` |
| GET | `/api/oauth/google/start` | — | Redirect to Google. Query: `mode=login|bind`, `next=` |
| GET | `/api/oauth/google/callback` | — | OAuth callback (browser) |
| GET | `/api/oauth/microsoft/start` | — | Redirect to Microsoft |
| GET | `/api/oauth/microsoft/callback` | — | OAuth callback (browser) |

Per-user allow-list and unlink: admin routes under `/api/admin/users/:id/google-*` and `microsoft-*`.

---

## Admin (`/api/admin/*`)

All routes require **admin** session unless noted.

### System config

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/config` | `{ state, registrationEnabled }` |
| PATCH | `/api/admin/config` | `{ registrationEnabled }` — UI toggle also on **用户管理** |

### Users

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/users` | List users. Query: `?status=pending\|active\|disabled` |
| POST | `/api/admin/users` | Create user |
| PATCH | `/api/admin/users/:id` | Update `name` and/or `status` (approve/disable). **root** protected |
| DELETE | `/api/admin/users/:id` | Delete user. Cannot delete self, **root**, or last active admin |
| PUT | `/api/admin/users/:id/permissions` | `{ l1Enabled }` — only pauth-managed permission |

### User Passkeys

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/users/:id/passkeys` | List user's Passkeys |
| POST | `/api/admin/users/:id/passkeys/delegate` | Generate one-time `/link-device` URL |
| DELETE | `/api/admin/users/:id/passkeys/:pkId` | Delete user's Passkey |

### User social OAuth (allow-list / unlink)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/admin/users/:id/google-allow-email` | Set allowed Google email |
| POST | `/api/admin/users/:id/microsoft-allow-email` | Set allowed Microsoft email |
| DELETE | `/api/admin/users/:id/google-link` | Unlink Google |
| DELETE | `/api/admin/users/:id/microsoft-link` | Unlink Microsoft |

### Invites

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/admin/invites` | `{ name, role?, l1Enabled? }` → invite URL (7-day TTL) |

### OAuth clients (L2 apps)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/clients` | List clients |
| POST | `/api/admin/clients` | Create client; returns `clientSecret` once |
| PATCH | `/api/admin/clients/:clientId` | Update `name`, `accessMode`, `enabled` |
| POST | `/api/admin/clients/:clientId/regenerate-secret` | New secret |
| DELETE | `/api/admin/clients/:clientId` | Delete client |

`accessMode`: `L2_ONLY` (default) or `L1_AND_L2` (requires L1 grant for OAuth).

### Integration

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/integration/webauth` | WEBAUTH runtime display config |
| GET | `/api/admin/integration/google` | Google OAuth config (no secret) |
| POST | `/api/admin/integration/google` | Save Google OAuth config |
| GET | `/api/admin/integration/microsoft` | Microsoft OAuth config |
| POST | `/api/admin/integration/microsoft` | Save Microsoft OAuth config |

### Encrypted backup

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/admin/backup/export` | `{ password }` → encrypted bundle (**excludes root**) |
| POST | `/api/admin/backup/preview` | `{ password, bundle }` → import preview |
| POST | `/api/admin/backup/import` | Replace non-root data |

UI: **系统设置 → 加密备份**

### Audit & reset

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/audit-logs` | Audit log list |
| POST | `/api/admin/system/reset` | `{ confirmation: "RESET_ALL_I_UNDERSTAND" }` → `NEEDS_SETUP` |

---

## SPA frontend routes

| Path | When | Purpose |
|------|------|---------|
| `/setup` | `NEEDS_SETUP` | Bootstrap root admin Passkey |
| `/login` | `ACTIVE` | Passkey / social login; `?return_to=` |
| `/register` | `ACTIVE` + registration open | Self-register (pending approval) |
| `/invite/:token` | Valid invite | Invite registration |
| `/link-device` | Valid delegate token (`?t=`) | Passkey delegate registration |
| `/admin/users` | admin | Users, L1, invites, registration toggle |
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
| `/api/l2/authorize` | **302** → app with `code` | **302** `error=access_denied` or **400** JSON |
| `/api/l2/token` | **200** token JSON | **401** bad secret; **400** invalid_grant |
| Admin mutations | **200** / **201** `{ ok: true }` | **400** / **403** / **409** with `{ error }` |

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
