# Passkey Auth

Central Passkey authentication for `*.xxx.com` (v3).

## Requirements

- Node.js 20+ (Wrangler 3 for local dev on Node 20; upgrade to Node 22+ and `wrangler@4` for production deploy)

## Local development

```bash
npm install
npm run db:migrate:local
npm run build
npx wrangler dev
```

Open http://localhost:8787

**Passkey flows require a real browser** (Safari/Chrome with platform authenticator or security key).

### Smoke test (API only)

```bash
curl -s http://localhost:8787/api/system/state
# → {"state":"NEEDS_SETUP",...}

curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8787/api/verify
# → 401
```

### First-time setup

1. Visit `/setup` — create admin + register Passkey
2. Admin panel at `/admin`
3. Enable registration in **系统设置**
4. Register a test user at `/register` — approve in **待审批**

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

## Deploy via GitHub (Cloudflare Workers)

### 1. One-time Cloudflare setup

```bash
# Create resources (run locally once)
npx wrangler d1 create passkey-auth-db
npx wrangler kv namespace create CHALLENGES
```

Copy the returned IDs into `wrangler.jsonc` (`database_id`, KV `id`).

Set production **vars** in `wrangler.jsonc` (or Cloudflare dashboard → Settings → Variables):

| Var | Example |
|-----|---------|
| `RP_ID` | `xxx.com` |
| `ORIGIN` | `https://auth.xxx.com` |
| `COOKIE_DOMAIN` | `.xxx.com` |
| `AUTH_HOST` | `auth.xxx.com` |

Set **secret** (Dashboard → Settings → Secrets, or CLI):

```bash
npx wrangler secret put SESSION_SECRET
```

Apply database migration to production:

```bash
npm run db:migrate:remote
```

Add custom domain `auth.xxx.com` in Cloudflare Workers → Settings → Domains.

### 2. Push to GitHub

```bash
git init
git add .
git commit -m "Initial passkey auth (v3)"
git branch -M main
git remote add origin https://github.com/YOUR_USER/passkey-auth.git
git push -u origin main
```

### 3. Connect Cloudflare to GitHub

1. [Cloudflare Dashboard](https://dash.cloudflare.com) → **Workers & Pages** → **Create**
2. Choose **Connect to Git** → authorize GitHub → select this repository
3. Build settings:
   - **Build command:** `npm run build`
   - **Deploy command:** `npx wrangler deploy`
   - **Root directory:** `/` (repo root)
4. Ensure D1/KV bindings in `wrangler.jsonc` match the created resources (Wrangler reads them on deploy)
5. Add `SESSION_SECRET` under **Settings → Variables and Secrets**
6. Save and deploy

Each push to `main` triggers a new deployment.

### Manual deploy (alternative)

```bash
npm run deploy
```

## Production vars example

```jsonc
"RP_ID": "xxx.com",
"ORIGIN": "https://auth.xxx.com",
"COOKIE_DOMAIN": ".xxx.com",
"AUTH_HOST": "auth.xxx.com"
```
