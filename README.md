# Passkey Auth

Cloudflare Workers auth for one root domain (`*.xxx.com`): **L1** (Caddy `forward_auth`) + **L2** (OIDC for apps).

Sign-in is **Passkey / Google / Microsoft only** — no passwords, no open self-registration. Admins create accounts; users activate via an activation link. Stack: Hono + D1 + KV + Vite SPA.

**API route index:** [`docs/API.md`](docs/API.md)

## Requirements

- Node.js 20+ (`package.json` `engines.node`: `>=20.9.0`)
- Wrangler 4 (`wrangler@^4` in `package.json`) — used by `npm run dev` / `npm run deploy`

## Local development

1. Copy the local Wrangler config template and fill in your domain and Cloudflare resource IDs:

```bash
cp wrangler.local.jsonc.example wrangler.local.jsonc
cp .dev.vars.example .dev.vars
```

Edit `wrangler.local.jsonc` (gitignored) with your values. `wrangler.jsonc` (the Workers Builds config) is a **placeholder template** in upstream — `npm run provision:cloudflare` overwrites it with your real values on your first deploy; do **not** commit real domains or resource IDs back into the template.

For **API-only local smoke tests** on `http://127.0.0.1:8787`, you may set `RP_ID=localhost`, `ORIGIN=http://127.0.0.1:8787`, and leave `COOKIE_DOMAIN` empty. The template `wrangler.local.jsonc.example` uses `example.com` placeholders to mirror production layout. Passkey flows in a real browser typically need a stable hostname (reverse proxy or dev domain), not bare `127.0.0.1`.

2. Install, migrate, build, and run:

```bash
npm install
npm run db:migrate:local
npm run build
npm run dev
```

Open `https://auth.<your-domain>/setup` (via your reverse proxy) or http://127.0.0.1:8787 for API-only smoke tests.

**Passkey flows require a real browser** (Safari/Chrome with platform authenticator or security key).

### First-time setup

1. Visit `/setup` — register Passkey for the fixed **root** bootstrap admin (name is always `root`)
2. Admin panel at `/admin`
3. (Optional) **集成与安全** — configure Google / Microsoft OAuth; until then, login only shows Passkey
4. Create a user in **用户管理** (name + optional email)
5. Generate an **激活链接** (activation link) for that user — they open it and complete activation via Passkey, Google, or Microsoft

### Admin console

| Page | Purpose |
|------|---------|
| 用户管理 | Users, activation links, L1 grants, Passkey per user (read-only Google/Microsoft status for others; self-service only) |
| 应用管理 | OAuth clients (L2 / L1+L2) |
| 集成与安全 | Google / Microsoft client IDs & secrets (required before those buttons appear on `/login`) |
| 系统设置 | Encrypted backup export/import, factory reset |
| 审计日志 | Audit trail |

### Self-service account page

Regular users (and admins managing their own account) land on `/me/profile` — a sidebar layout mirroring the admin console, with a **用户信息** section: edit name/email, manage own Passkeys, and bind/unbind own Google/Microsoft identity. Nobody (including admins) can bind or unbind another user's OAuth identity — only the account holder.

### Root bootstrap admin

- First admin created at setup is always named **`root`** (earliest-created admin by `createdAt`)
- **Cannot** rename, disable, or delete `root`
- Other users cannot use the display name `root`
- Encrypted backup **excludes** `root` and their Passkey/OAuth data; import never overwrites `root`

### Disaster recovery (encrypted backup)

Admin **系统设置 → 加密备份**:

- **Export:** password (≥8 chars) → AES-256-GCM + PBKDF2 (100k iterations) encrypted JSON download
- **Import:** file + password → preview → confirm; replaces all non-root users, clients, and settings

API: `POST /api/admin/backup/export|preview|import` (admin session required).

### Session API

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/login/logout` | End session; clear `sid` cookie (admin UI uses this) |

### Account activation (new user / identity reset)

Admin generates an **激活链接** (activation link) from **用户管理** for a pending user, or to let an already-active user add/reset an identity. The link is valid for 15 minutes and can be opened up to 3 times; only one active link exists per user at a time. Opening it lets the user complete activation via **any one of**: Passkey registration, Google OAuth, or Microsoft OAuth. `POST /api/admin/users/:id/complete-link`, consumed via `/api/complete/:token/*`.

### Passkey delegate (admin-assisted, additional device)

Separate from account activation above: admins generate a one-time link from **用户管理 → Passkey** so an existing user can register an *additional* Passkey from another device. User opens `/link-device?t=<token>` and registers a Passkey via `/api/passkey-delegate/:token/*`.

### Smoke test (API only)

```bash
curl -s http://localhost:8787/api/system/state
# → {"state":"NEEDS_SETUP",...}

curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8787/api/verify
# → 302
```

### Verify API (Forward Auth)

Unauthenticated requests return **302** to the login page (with `return_to`). Authenticated requests return **200** and identity headers.

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8787/api/verify
# → 302
```

## Caddy integration (Forward Auth)

Protect backend sites (e.g. `site.xxx.com`, OpenWrt LuCI, internal apps) by delegating authentication to this Worker. Caddy calls `GET /api/verify` on every request; the Worker returns **302** when unauthenticated (browser is redirected to login) or **200** when the session cookie is valid.

### Prerequisites

- Worker deployed at `auth.xxx.com` with `wrangler.jsonc` vars aligned (`RP_ID`, `ORIGIN`, `COOKIE_DOMAIN`, `AUTH_HOST`)
- Session cookie domain is `.xxx.com`, so one login covers all subdomains
- Caddy terminates TLS on your origin server; DNS for protected hostnames points to that server

### Caddyfile template

Replace placeholders:

| Placeholder | Example |
|-------------|---------|
| `auth.xxx.com` | Your auth Worker hostname |
| `site.xxx.com` | A protected site hostname |
| `192.168.1.100` | Backend IP (router, NAS, etc.) |
| `80` / `2023` | Backend port |

```caddy
{
	ocsp_stapling off
}

# TLS via Cloudflare DNS (optional — use your own ACME / cert method)
(tls_xxx) {
	tls {
		dns cloudflare {env.CF_API_TOKEN}
	}
}

# ── Forward Auth snippet ──
# Strip Sec-Fetch-* before calling auth — avoids edge cases where navigation
# headers cause the verify subrequest to be mishandled before Worker logic runs.
(auth_verify) {
	forward_auth https://auth.xxx.com {
		uri /api/verify
		header_up Host auth.xxx.com
		header_up Cookie {http.request.header.Cookie}
		header_up X-Forwarded-Proto {scheme}
		header_up X-Forwarded-Host {http.request.hostport}
		header_up X-Forwarded-Uri {uri}
		header_up -Sec-Fetch-Mode
		header_up -Sec-Fetch-Dest
		header_up -Sec-Fetch-Site
		header_up -Sec-Fetch-User
		copy_headers X-Auth-User-Id X-Auth-User-Email X-Auth-User-Name X-Auth-User-Role
	}
	header Cache-Control "no-store"
}

# ── Protected site (route enforces: auth first, then reverse_proxy) ──
site.xxx.com {
	import tls_xxx
	route {
		import auth_verify
		reverse_proxy 192.168.1.100:80
	}
}

# Non-standard HTTPS port (e.g. daed panel on backend :2023, exposed as :9023)
site.xxx.com:9023 {
	import tls_xxx
	route {
		import auth_verify
		reverse_proxy 192.168.1.100:2023
	}
}
```

Apply and reload:

```bash
caddy fmt --overwrite /etc/caddy/Caddyfile
caddy reload --config /etc/caddy/Caddyfile
```

### How it works

1. User visits `https://site.xxx.com/...`
2. Caddy `forward_auth` sends a subrequest to `https://auth.xxx.com/api/verify` with the browser’s cookies and `X-Forwarded-*` headers
3. Worker validates the `.xxx.com` session cookie:
   - **No valid session** → **302** to `https://auth.xxx.com/login?return_to=...`
   - **Valid session** → **200** + `X-Auth-User-*` headers; Caddy proxies to the backend
4. After login (Passkey, Google, or Microsoft), the Worker sets the cookie on `.xxx.com` and redirects to `return_to` (must be under the same `RP_ID` root domain)

### Notes

- Protected host and `auth.xxx.com` must share the same root domain (`RP_ID` / `COOKIE_DOMAIN`) — otherwise `return_to` is rejected and the user may land on `/admin` instead of the app
- Always wrap `import auth_verify` and `reverse_proxy` in a **`route { }`** block so authentication runs before the backend is reached
- Do **not** wrap `forward_auth` in extra `handle_errors` for 401→redirect; the Worker already returns 302
- Backend apps may have their own login (e.g. LuCI `root` password) — pauth is the **outer** gate only
- Optional: pass `X-Auth-User-*` headers to the backend if your app can read them

### Quick test

From a machine **without** a session cookie:

```bash
curl -sk -o /dev/null -w "%{http_code} -> %{redirect_url}\n" \
  -H "sec-fetch-mode: navigate" \
  https://site.xxx.com/
# → 302 -> https://auth.xxx.com/login?return_to=...
```

## OpenID Connect (OIDC) / L2 OAuth

pauth implements the standard OpenID Connect Provider protocol, so any OIDC Relying Party (PVE, Grafana, GitLab, etc.) can use it as an identity provider.

### OIDC endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /.well-known/openid-configuration` | OIDC Discovery document — lists all endpoints automatically |
| `GET /.well-known/jwks.json` | RS256 public key for verifying `id_token` signatures |
| `/api/l2/authorize` | Authorization endpoint (browser redirect) |
| `/api/l2/token` | Token endpoint (returns JWT `id_token`) |
| `/api/l2/userinfo` | UserInfo endpoint (`sub`, `email`, `name`) |

### Configuration for OIDC clients

| Field | Example |
|-------|---------|
| **Issuer URL** | `https://auth.xxx.com` |
| **Client ID** | Created in admin **应用管理** |
| **Client Secret** | Provided on client creation |

No manual endpoint configuration needed — the Issuer URL auto-discovers `authorization_endpoint`, `token_endpoint`, `userinfo_endpoint`, and `jwks_uri` via the discovery document.

### Token details

- `id_token` is a signed JWT (`RS256`) with `iss`, `sub`, `aud`, `exp`, `iat`, and optionally `nonce`, `email`, `name`
- `access_token` is opaque (SHA-256 hash stored in D1), 600s TTL
- Authorization codes are single-use, 600s TTL
- `redirect_uri` accepts any valid URL (HTTPS, HTTP localhost, or custom schemes like `app.immich://` for mobile apps)

### Email management & third-party integration

Each pauth user has an `email` field (unique). The email claim is returned in OIDC `id_token` and `userinfo` responses, enabling Relying Parties to match users by email.

- **Admin creates users** with an optional email field in 用户管理. If left blank, auto-generates `username@domain` (derived from `ORIGIN`).
- **Users edit their own email** in the web UI.
- **Admin can edit any user's email** in 用户管理 → 编辑.
- **Immich OIDC**: ensure pauth users have a real email address (not the auto-generated placeholder). Immich matches users by the `email` claim.

API endpoint: `PUT /me/email` (user self-edit) and `PATCH /admin/users/:id` (admin edit).

API route index: [`docs/API.md`](docs/API.md)

## Deploy to Cloudflare

| Method | Use when |
|--------|----------|
| **[Bootstrap](#1-bootstrap-recommended)** (`full-deploy-cloudflare.sh`) | First deploy / greenfield — pass only the auth hostname |
| **[Code-only upgrade](#2-code-only-upgrade-keep-data)** | Worker already exists; update code **without** touching D1/KV/secrets |
| **[Workers Builds](#3-workers-builds-optional)** | Auto-deploy from GitHub (one primary Worker per repo) |
| **[Manual](#4-manual-from-existing-checkout)** | You already have resource IDs and want full control |

### Prerequisites

- Node.js 20+, git, python3, curl
- Cloudflare auth: `npx wrangler login` or `CLOUDFLARE_API_TOKEN`
- The auth hostname’s **zone must already be on this Cloudflare account**
- `SESSION_SECRET` ≥32 characters — store in Cloudflare Secrets (never commit)
- **One auth host = one isolated stack** (Worker + D1 + KV + users). `auth.a.com` and `auth.b.com` do **not** share accounts
- **L1 forward_auth sites must live under the same root domain as that auth host** (`RP_ID` / `COOKIE_DOMAIN`). Example: protect `*.example.com` with `auth.example.com`, not with `auth.other.com`

### 1. Bootstrap (recommended)

One-shot: provision D1/KV if needed, write config, build, migrate, deploy, bind custom domain. Self-contained script (helpers embedded; can clone the repo).

**Only argument required:** the Passkey auth hostname.

```bash
npx wrangler login   # first time

# From a downloaded copy of the script (set PAUTH_REPO_URL if you use a fork)
export PAUTH_REPO_URL=https://github.com/your-org/pauth.git   # optional
curl -fsSL https://raw.githubusercontent.com/your-org/pauth/main/scripts/full-deploy-cloudflare.sh -o full-deploy.sh
chmod +x full-deploy.sh
./full-deploy.sh --yes auth.example.com
# equivalent: ./full-deploy.sh --yes --auth-host auth.example.com

# From a repo checkout
./scripts/full-deploy-cloudflare.sh --yes auth.example.com
# or: npm run deploy:full -- --yes auth.example.com
```

Then open `https://auth.example.com/setup` and register the **root** admin Passkey.

#### What the hostname implies

| Item | Rule | Example (`auth.example.com`) |
|------|------|------------------------------|
| Zone | Drop leftmost label | `example.com` |
| Worker | `pauth-<auth-host-slug>` | `pauth-auth-example-com` |
| D1 | `pauth-<auth-host-slug>-db` | `pauth-auth-example-com-db` |
| KV | `CHALLENGES-pauth-<auth-host-slug>` | `CHALLENGES-pauth-auth-example-com` |
| Install dir | `~/pauth-<auth-host-slug>` | `~/pauth-auth-example-com` |
| `RP_ID` / cookie | From zone | `example.com` / `.example.com` |
| `ORIGIN` / `AUTH_HOST` | Auth URL / host | `https://auth.example.com` / `auth.example.com` |

#### New vs upgrade (same command)

| Situation | Behavior |
|-----------|----------|
| No Worker / no local config for that host | **Create** D1, KV, Worker |
| `~/pauth-<slug>/wrangler.local.jsonc` exists and `AUTH_HOST` matches | **Upgrade** — keep vars and resource IDs |
| Cloudflare already has a Worker bound to that hostname (API token required) | **Upgrade** — reuse that Worker |

Re-running the same command upgrades by default (`merge-bindings`). The script checks the zone, then force-binds `AUTH_HOST` to the Worker (overrides conflicting Worker/DNS). Use `--skip-domain-bind` to skip binding.

If a wrangler config already exists, the script prompts: **keep** / **sync D1/KV only** / **overwrite**.

#### Multiple auth domains

Each host gets its own stack (users are **not** shared):

```bash
./scripts/full-deploy-cloudflare.sh --yes auth.example.com
./scripts/full-deploy-cloudflare.sh --yes auth.example2.com
```

#### Wrangler config files

| File | Purpose | Git |
|------|---------|-----|
| `wrangler.jsonc` | Workers Builds primary (`npm run deploy:workers`) — upstream is a **placeholder**; commit **your** values after provision | commit after provision |
| `wrangler.production.jsonc` | Optional Builds config (`--deploy-mode git`) | commit after provision |
| `wrangler.local.jsonc` | Local `wrangler deploy` / `dev` | gitignored |
| `wrangler.<slug>.jsonc` | Extra auth domain (manual deploy) | gitignored (contains real D1/KV IDs) |

Resources-only (no build/deploy): `scripts/provision-cloudflare.sh` / `npm run provision:cloudflare` — see comments at the top of that file.

#### Advanced options

| Flag | Purpose |
|------|---------|
| `--zone` | Override root zone (e.g. `co.uk`) |
| `--dir` | Install directory (default `~/pauth-<slug>`) |
| `--worker-name` | Fixed Worker name (e.g. legacy `passkey-auth`) |
| `--d1-name` / `--kv-title` | Custom D1 / KV names |
| `--deploy-mode git` | Also write `wrangler.production.jsonc` for Builds |
| `--config-policy keep\|merge-bindings\|overwrite` | How to treat an existing wrangler config |
| `--skip-clone` | Use an existing checkout (`--dir`) |
| `--skip-domain-bind` | Do not bind the custom domain |
| `--rotate-secret` | Force a new `SESSION_SECRET` |
| `--allow-worker-overwrite` | Allow replacing a Worker bound to another hostname |

```bash
# Prepare Builds config
./scripts/full-deploy-cloudflare.sh --yes auth.example.com --deploy-mode git

# Custom names / directory
./scripts/full-deploy-cloudflare.sh --yes auth.example.com \
  --zone example.com --worker-name passkey-auth --dir ~/pauth-example

# Upgrade existing checkout; keep wrangler file as-is
./scripts/full-deploy-cloudflare.sh --yes auth.example.com \
  --dir ~/pauth-auth-example-com --skip-clone --config-policy keep
```

### 2. Code-only upgrade (keep data)

When the Worker, D1, KV, routes, vars, and secrets are already correct — ship **code + static assets only**:

```bash
npm run build
npx wrangler deploy --config wrangler.<slug>.jsonc   # or wrangler.local.jsonc / wrangler.jsonc
```

Apply remote migrations only when new files appear under `migrations/` (e.g. `npm run db:migrate:remote` with the matching `--config`). Do **not** re-run bootstrap with `--config-policy overwrite` or `--rotate-secret` unless you intend to replace config/secrets.

### 3. Workers Builds (optional)

1. Install the [Cloudflare Workers GitHub App](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/)
2. Dashboard → Worker → Settings → Builds → Connect to Git
3. **Build:** `npm run build` · **Deploy:** `npm run deploy:workers` (runs `lint:wrangler`, remote D1 migrate, then deploy)
4. After provision, commit your real `wrangler.jsonc` (not the upstream placeholder)
5. Keep `SESSION_SECRET` in Cloudflare Secrets only

Only **one** Worker per repo can use Builds (it reads root `wrangler.jsonc`). Extra auth domains: code-only deploy with `wrangler.<slug>.jsonc` (see above).

### 4. Manual from existing checkout

```bash
cp wrangler.local.jsonc.example wrangler.local.jsonc   # fill D1/KV IDs + domain vars
cp .dev.vars.example .dev.vars                           # SESSION_SECRET ≥32 chars
npm install
npm run db:migrate:remote
npm run deploy                                           # build + deploy via wrangler.local.jsonc
npx wrangler secret put SESSION_SECRET -c wrangler.local.jsonc
```

### Production vars

| Var | Example | Role |
|-----|---------|------|
| `RP_ID` | `xxx.com` | WebAuthn RP ID; L1 `return_to` allowlist root |
| `ORIGIN` | `https://auth.xxx.com` | Public origin / OIDC issuer |
| `COOKIE_DOMAIN` | `.xxx.com` | Session cookie domain (one login across subdomains) |
| `AUTH_HOST` | `auth.xxx.com` | Host used in login redirect URLs |

```jsonc
"RP_ID": "xxx.com",
"ORIGIN": "https://auth.xxx.com",
"COOKIE_DOMAIN": ".xxx.com",
"AUTH_HOST": "auth.xxx.com"
```
