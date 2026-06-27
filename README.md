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

```bash
curl -b cookies.txt http://localhost:8787/api/verify -i
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
