# pauth L1/L2 Specification and Implementation Status

This document describes the authentication model and the current implementation in pauth.

---

## 1) Architecture

### 1.1 Layer definitions

- **L1**: gateway access gate for browser traffic (`GET /api/verify`, Caddy `forward_auth`)
- **App OAuth** (`/api/l2/*`): application-level identity via OAuth-style authorization code flow

pauth acts as a **self-hosted IdP** (similar to Google OAuth): apps register a Client ID; **all active pauth users** may sign in via OAuth. Per-app authorization (roles, feature access) is managed by each application, not by pauth.

### 1.2 User admission

| Path | Approval |
|------|----------|
| Self-registration | Admin approves once (`pending` → `active`) |
| Admin invite link | No second approval; Passkey registration sets `active` |

After admission, the only pauth-managed permission toggle is **L1 gateway access**.

### 1.3 Effective decision rule (app OAuth)

For client `C` and user `U`:

```text
ALLOW =
  U.status == active
  AND client.enabled
  AND (
    C.access_mode != L1_AND_L2
    OR l1_granted(U)
  )
```

There is **no per-app user grant** in pauth. Registering a new OAuth client makes it available to all active users immediately (subject to L1 requirement if configured).

---

## 2) Data Model (implemented)

Migrations: `0001_init.sql` … `0007_root_admin_name.sql` (see `migrations/`)

Latest additions: `0005_social_oauth.sql`, `0006_passkey_delegate.sql`, `0007_root_admin_name.sql`.

### 2.1 `clients`

| Column | Notes |
|--------|--------|
| `client_id` | Unique string, chosen by admin (e.g. `sumusic`) |
| `name` | Display name |
| `access_mode` | `L2_ONLY` (default) or `L1_AND_L2` (requires L1 grant) |
| `client_secret_hash` | SHA-256 of secret (token exchange) |
| `client_secret` | Plaintext secret (admin retrieval only) |
| `redirect_uris` | Legacy column, unused (always `[]`) |
| `enabled` | Boolean |

Admin UI shows `access_mode` as **「需 L1 网关」** checkbox (`L1_AND_L2` = checked).

### 2.2 `user_l1_access`

- `user_id`, `enabled`, `updated_at`
- Only user-level permission managed by pauth after admission

### 2.3 `user_client_access` (legacy)

- Retained in schema for backward compatibility; **not used** for access decisions in the simplified model

### 2.4 `auth_codes`

- One-time authorization codes (TTL 600s, single-use)

### 2.5 `access_tokens`

- Opaque bearer tokens stored as SHA-256 hash (TTL 600s)

### 2.6 `invites`

- Admin-created invite tokens for Passkey registration with optional pre-set L1 (7-day TTL, single-use)

### 2.7 `oauth_identities` (migration `0005`)

- Links pauth users to Google / Microsoft accounts; admin allow-list email per user

### 2.8 `passkey_delegate_tokens` (migration `0006`)

- One-time admin-generated links for registering Passkey on behalf of a user

---

## 3) API Overview (implemented)

### 3.1 Public / system

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/system/state` | `{ state, registrationEnabled, origin }` |
| GET | `/api/verify` | L1 forward-auth (302 → login if unauthenticated; 200 + headers if active + L1) |
| GET | `/api/l2/authorize` | Start OAuth flow |
| POST | `/api/l2/token` | Exchange code for token |
| GET | `/api/l2/userinfo` | User profile from Bearer token |
| GET | `/api/invite/:token` | Invite metadata |
| POST | `/api/invite/:token/begin` | Start invite registration session |
| POST | `/api/invite/:token/passkey/*` | Passkey registration for invite |

### 3.2 Admin (`/api/admin/*`, admin session required)

| Method | Path | Purpose |
|--------|------|---------|
| GET/PATCH | `/config` | Registration toggle (`registrationEnabled`) |
| GET | `/users` | List users (L1, OAuth, Passkey, `isRoot`) |
| POST | `/users` | Create user |
| PATCH | `/users/:id` | Update `name` / `status` (root protected) |
| DELETE | `/users/:id` | Delete user (root protected) |
| PUT | `/users/:id/permissions` | Set `{ l1Enabled }` |
| GET/POST/DELETE | `/users/:id/passkeys/*` | Passkey list, delegate link, delete |
| POST/DELETE | `/users/:id/google-*`, `/microsoft-*` | OAuth allow-list / unlink |
| POST | `/invites` | Create user + invite URL |
| GET/POST/PATCH/DELETE | `/clients` | OAuth client CRUD + secret rotate |
| GET/POST | `/integration/webauth`, `/google`, `/microsoft` | Social login + WEBAUTH config |
| POST | `/backup/export`, `/preview`, `/import` | Password-encrypted backup (excludes root) |
| GET | `/audit-logs` | Audit log query |
| POST | `/system/reset` | Factory reset |

Admin UI pages: **用户管理** (incl. open registration), **应用管理**, **集成与安全**, **系统设置** (backup + reset), **审计日志**.

### 3.3 Root bootstrap admin

- Setup creates a single bootstrap admin named **`root`** (fixed; UI does not accept another name)
- Identified as earliest-created admin (`createdAt`); migration `0007` renames legacy bootstrap admin to `root`
- **Protected:** cannot rename, disable, or delete; display name `root` reserved for this account only
- Encrypted backup export/import **never includes** root user, root Passkeys, or root OAuth rows

### 3.4 Encrypted backup

- Envelope: `pauth-backup-encrypted-v1` (PBKDF2 + AES-GCM)
- Payload kind: `pauth-backup-v1`
- Includes: non-root users, passkeys, clients, settings, OAuth identities, L1 grants, invites, `registrationEnabled`
- Excludes: root admin, sessions, audit logs
- Import: wipes non-root users and related rows; replaces clients/settings; does not touch root

### 3.5 Deploy tooling

Script `scripts/deploy-cloudflare.sh` (`npm run deploy:bootstrap`):

- Provisions D1 + KV; writes `wrangler.local.jsonc` and optionally `wrangler.production.jsonc`
- Config merge on upgrade: keep / merge-bindings / overwrite
- Deploy modes: **local** (`wrangler deploy`) or **git** (prepare Cloudflare Builds)
- Auto-binds `AUTH_HOST` Custom Domain when zone is on the account (`scripts/lib/bind-custom-domain.py`)

---

## 4) OAuth redirect URI policy

**No per-client redirect URI registration.** At authorize time, `redirect_uri` must be:

- A valid absolute **HTTPS** URL, or
- `http://localhost` / `http://127.0.0.1` (local development)

Access control is enforced by **Client ID + client secret + active user (+ L1 if required)**, not by a redirect URI allowlist.

Login `return_to` on auth host remains restricted to `RP_ID` and subdomains (open-redirect protection).

---

## 5) Security (current behavior)

1. Mandatory `state` in OAuth authorize flow
2. Optional `nonce` (stored on auth code, not validated further in v1)
3. Authorization code TTL: **600 seconds**, single-use
4. Access token TTL: **600 seconds**, stored as hash
5. Client secret required for token exchange; stored hashed for verification, plaintext for admin display
6. CSRF origin check on mutating `/api/*` (server-to-server token calls pass without Origin)
7. Structured audit logs for OAuth authorize/token and admin actions

Cookie requirements: `HttpOnly`, `Secure` (HTTPS), `SameSite=Lax`, `Domain` from `COOKIE_DOMAIN`.

---

## 6) App integration

1. Admin creates client in **应用管理**, copies config:

```text
PAUTH_CLIENT_ID=<clientId>
PAUTH_CLIENT_SECRET=<secret>
PAUTH_AUTHORIZE_URL=<ORIGIN>/api/l2/authorize
PAUTH_TOKEN_URL=<ORIGIN>/api/l2/token
```

2. App redirects browser to `/api/l2/authorize?client_id=...&redirect_uri=...&response_type=code&state=...`

3. App backend `POST /api/l2/token` with `grant_type=authorization_code`, code, client credentials, matching `redirect_uri`.

4. App creates **local session** from `user.sub` / `user.name` and manages app-specific roles internally.

Passkey authentication happens on the auth host during the authorize flow; the app never handles pauth passkeys directly.

---

## 7) Implementation status

| Phase | Status |
|-------|--------|
| Schema (clients, grants, codes, tokens, invites) | Done |
| L1 `/api/verify` with `user_l1_access` | Done |
| OAuth authorize / token / userinfo | Done |
| Google / Microsoft social login | Done |
| Admin client CRUD + secret management | Done |
| Admin user L1 + invites + Passkey delegate | Done |
| Encrypted backup (root excluded) | Done |
| Root admin protection | Done |
| Deploy bootstrap script + domain bind | Done |
| Admin UI (SuMusic-style) | Done |
| SuMusic / external app OAuth adapter | App-side (not in pauth repo) |

---

## 8) Acceptance checklist

- [x] L1 `/api/verify` checks `user_l1_access`
- [x] OAuth authorize issues code for any active user on enabled client
- [x] OAuth token exchange validates client secret and redirect_uri match
- [x] `L1_AND_L2` client blocks users without L1
- [x] Disabling user blocks next authorize/token
- [x] Root admin cannot be renamed/disabled/deleted; backup excludes root
- [ ] Audit log filters by layer/client (basic logging exists; filtered UI TBD)

---

## 9) Out of scope (v1)

- OIDC discovery / JWKS
- JWT id_tokens (opaque `id_token` placeholder only)
- Per-client redirect URI allowlists
- Per-app user grants in pauth (apps manage their own authorization)
- Fine-grained consent UI beyond `openid profile`
- Automated D1 migration on Git push (run `db:migrate:remote` manually after schema changes)
