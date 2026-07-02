# Passkey Auth

Central Passkey authentication for `*.xxx.com` (v3).

## Requirements

- Node.js 20+ (Wrangler 3 for local dev on Node 20; upgrade to Node 22+ and `wrangler@4` for production deploy)

## Local development

1. Copy the local Wrangler config template and fill in your domain and Cloudflare resource IDs:

```bash
cp wrangler.local.jsonc.example wrangler.local.jsonc
cp .dev.vars.example .dev.vars
```

Edit `wrangler.local.jsonc` (gitignored) with your values. Do **not** put real domains or resource IDs in `wrangler.jsonc`.

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
3. Enable self-registration in **用户管理** (toggle at top of user list)
4. Register a test user at `/register` — approve in **用户管理**

### Admin console

| Page | Purpose |
|------|---------|
| 用户管理 | Users, open registration toggle, L1 grants, Passkey/OAuth per user |
| 应用管理 | OAuth clients (L2 / L1+L2) |
| 集成与安全 | Google / Microsoft OAuth, WEBAUTH runtime display |
| 系统设置 | Encrypted backup export/import, factory reset |
| 审计日志 | Audit trail |

### Root bootstrap admin

- First admin created at setup is always named **`root`** (earliest-created admin by `createdAt`)
- **Cannot** rename, disable, or delete `root`
- Other users cannot use the display name `root`
- Encrypted backup **excludes** `root` and their Passkey/OAuth data; import never overwrites `root`

### Disaster recovery (encrypted backup)

Admin **系统设置 → 加密备份**:

- **Export:** password (≥8 chars) → AES-GCM encrypted JSON download
- **Import:** file + password → preview → confirm; replaces all non-root users, clients, and settings

API: `POST /api/admin/backup/export|preview|import` (admin session required).

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
4. After Passkey login, the Worker sets the cookie on `.xxx.com`; the user is redirected back to the original URL

### Notes

- Always wrap `import auth_verify` and `reverse_proxy` in a **`route { }`** block so authentication runs before the backend is reached
- Do **not** wrap `forward_auth` in extra `handle_errors` for 401→redirect; the Worker already returns 302
- Backend apps may have their own login (e.g. LuCI `root` password) — Passkey is the **outer** gate only
- Optional: pass `X-Auth-User-*` headers to the backend if your app can read them

### Quick test

From a machine **without** a session cookie:

```bash
curl -sk -o /dev/null -w "%{http_code} -> %{redirect_url}\n" \
  -H "sec-fetch-mode: navigate" \
  https://site.xxx.com/
# → 302 -> https://auth.xxx.com/login?return_to=...
```

## Deploy to Cloudflare

Recommended: use the bootstrap script (`npm run deploy:bootstrap`). It creates D1 + KV, writes wrangler config, uploads `SESSION_SECRET`, runs migrations, deploys (local mode), and **auto-binds** `AUTH_HOST` as a Worker Custom Domain.

### Bootstrap script

```bash
npm run deploy:bootstrap

# Non-interactive — local deploy
./scripts/deploy-cloudflare.sh --zone kass.cc --auth-host auth.kass.cc --dir ~/pauth --yes

# Git mode — generate wrangler.production.jsonc for Cloudflare Builds
./scripts/deploy-cloudflare.sh --zone kass.cc --deploy-mode git --config-policy merge-bindings --yes

# Upgrade — keep existing wrangler config unchanged
./scripts/deploy-cloudflare.sh --dir ~/pauth --skip-clone --config-policy keep --yes
```

**Wrangler config files**

| File | Purpose | Git |
|------|---------|-----|
| `wrangler.local.jsonc` | Local `wrangler deploy` / dev | gitignored |
| `wrangler.production.jsonc` | Cloudflare Git Builds CI | commit to private repo |

When a config file already exists, the script prompts: **保留** / **仅同步 D1/KV** / **完全覆盖**.

The script verifies the zone is on your Cloudflare account and force-binds `AUTH_HOST` to the Worker (overrides conflicting Worker/DNS). Use `--skip-domain-bind` to skip.

### GitHub Builds (optional)

After `--deploy-mode git`:

1. Install [Cloudflare Workers & Pages GitHub App](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/) on your private repo
2. Dashboard → Worker → Settings → Builds → Connect to Git
3. **Build:** `npm run build` · **Deploy:** `npx wrangler deploy --config wrangler.production.jsonc`
4. Commit `wrangler.production.jsonc` to the repo; keep `SESSION_SECRET` in Cloudflare Secrets only
5. Run `npm run db:migrate:remote` manually after schema migrations

See `wrangler.production.jsonc.example`.

### Manual deploy (existing checkout)

```bash
cp wrangler.local.jsonc.example wrangler.local.jsonc   # fill in IDs + domain
cp .dev.vars.example .dev.vars                           # SESSION_SECRET
npm install && npm run db:migrate:remote && npm run deploy
```

Production **vars** (`wrangler.local.jsonc` or Dashboard):

| Var | Example |
|-----|---------|
| `RP_ID` | `xxx.com` |
| `ORIGIN` | `https://auth.xxx.com` |
| `COOKIE_DOMAIN` | `.xxx.com` |
| `AUTH_HOST` | `auth.xxx.com` |

```bash
npx wrangler secret put SESSION_SECRET -c wrangler.local.jsonc
```

## Production vars example

```jsonc
"RP_ID": "xxx.com",
"ORIGIN": "https://auth.xxx.com",
"COOKIE_DOMAIN": ".xxx.com",
"AUTH_HOST": "auth.xxx.com"
```
