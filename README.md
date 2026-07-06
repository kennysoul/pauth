# Passkey Auth

Central Passkey authentication for `*.xxx.com` (v3).

**API route index:** [`docs/API.md`](docs/API.md)

## Requirements

- Node.js 20+ (`package.json` `engines.node`: `>=20.9.0`)
- **Current lockfile**: Wrangler 3 (`wrangler@^3`) — used by `npm run dev` / `npm run deploy`
- **Production optional upgrade**: Node 22+ and `wrangler@4` (update `package.json` when you adopt it)

## Local development

1. Copy the local Wrangler config template and fill in your domain and Cloudflare resource IDs:

```bash
cp wrangler.local.jsonc.example wrangler.local.jsonc
cp .dev.vars.example .dev.vars
```

Edit `wrangler.local.jsonc` (gitignored) with your values. Do **not** put real domains or resource IDs in `wrangler.jsonc`.

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
3. Enable self-registration in **用户管理** (toggle at top of user list)
4. Register a test user at `/register` — approve in **用户管理**

### Admin console

| Page | Purpose |
|------|---------|
| 用户管理 | Users, open registration toggle, L1 grants, Passkey/OAuth per user, Passkey delegate links |
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

### Session API

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/login/logout` | End session; clear `sid` cookie (admin UI uses this) |

### Passkey delegate (admin-assisted registration)

Admins generate a one-time link from **用户管理 → Passkey → 代注册**. User opens `/link-device?t=<token>` and registers a Passkey via `/api/passkey-delegate/:token/*`.

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

### Quick start（推荐：只传认证域名）

大多数场景只需 **一个参数** — 你的 Passkey 认证域名。脚本会从它推导 zone、Worker、D1、KV、安装目录等；**没有对应 Worker 则新建，已有则升级**。

```bash
npx wrangler login   # 首次需要

# 单文件一键部署（从 GitHub 拉源码 + 部署）
# 若 fork 到自有仓库，请设置 PAUTH_REPO_URL 或 deploy 时加 --repo
export PAUTH_REPO_URL=https://github.com/your-org/pauth.git   # 可选
curl -fsSL https://raw.githubusercontent.com/your-org/pauth/main/scripts/full-deploy-cloudflare.sh -o full-deploy.sh
chmod +x full-deploy.sh
./full-deploy.sh --yes auth.example.com

# 仓库内
./scripts/full-deploy-cloudflare.sh --yes auth.example.com
npm run deploy:full -- --yes auth.example.com
```

等价写法：

```bash
./full-deploy.sh --yes --auth-host auth.example.com
```

完成后访问 `https://auth.example.com/setup` 注册 **root** 管理员 Passkey。

#### 从 `auth.example.com` 自动推导

| 项目 | 规则 | 示例 |
|------|------|------|
| 根域名 (zone) | 去掉最左侧子域 | `example.com` |
| Worker | `pauth-<auth-host-slug>` | `pauth-auth-example-com` |
| D1 | `pauth-<auth-host-slug>-db` | `pauth-auth-example-com-db` |
| KV | `CHALLENGES-pauth-<auth-host-slug>` | `CHALLENGES-pauth-auth-example-com` |
| 安装目录 | `~/pauth-<auth-host-slug>` | `~/pauth-auth-example-com` |
| `RP_ID` / Cookie | 来自 zone | `.example.com` |
| `ORIGIN` | `https://<auth-host>` | `https://auth.example.com` |

每个 auth 域名 **独立一套** Worker + D1 + KV，部署多个域名互不冲突。

#### 新建 vs 升级

| 情况 | 行为 |
|------|------|
| 该域名尚无 Worker / 本地无配置 | **新建** D1、KV、Worker |
| `~/pauth-<slug>/wrangler.local.jsonc` 已存在且 `AUTH_HOST` 匹配 | **升级**，保留 vars 与资源 ID |
| Cloudflare 上该域名已绑定 Worker（需 API Token） | **升级**，自动沿用该 Worker |

再次执行同一命令 = 升级部署（默认 `merge-bindings`）。

#### 多个域名

```bash
./scripts/full-deploy-cloudflare.sh --yes auth.example.com
./scripts/full-deploy-cloudflare.sh --yes auth.cdnc.us
```

#### 高级选项（可选）

默认行为已覆盖常见需求；以下参数供高级用户覆盖：

| 参数 | 用途 |
|------|------|
| `--zone` | 手动指定根域名（复杂后缀如 `co.uk` 时） |
| `--dir` | 自定义安装目录（默认 `~/pauth-<slug>`） |
| `--worker-name` | 固定 Worker 名（如沿用旧名 `passkey-auth`） |
| `--d1-name` / `--kv-title` | 自定义 D1 / KV 名称 |
| `--deploy-mode git` | 生成 `wrangler.production.jsonc` 供 Workers Builds |
| `--config-policy keep\|merge-bindings\|overwrite` | 已有 wrangler 配置时的合并策略 |
| `--skip-domain-bind` | 跳过域名绑定（自行在 wrangler routes 配置） |
| `--rotate-secret` | 强制更新 `SESSION_SECRET` |
| `--allow-worker-overwrite` | 允许覆盖已绑定其他域名的 Worker |

---

Three ways to deploy — pick one:

| Method | Best for |
|--------|----------|
| **[Deploy to Cloudflare](#deploy-to-cloudflare-badge)** badge + provision script | Fork on GitHub, CI deploy via Workers Builds |
| **Bootstrap script** (`full-deploy-cloudflare.sh`) | One-shot local deploy — **只传 auth 域名** |
| **Manual** | Existing checkout, full control |

### Deploy to Cloudflare badge

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/your-org/pauth)

**Flow:** badge creates your GitHub fork + Workers Builds project → **provision script** creates D1/KV and writes real IDs into `wrangler.jsonc` → push → Builds runs `npm run deploy:workers`.

#### Step 1 — Click the badge

Connect your GitHub account. Cloudflare forks the repo and sets up Workers Builds. Use these build settings:

| Field | Value |
|-------|--------|
| Build command | `npm run build` |
| Deploy command | `npm run deploy:workers` |

Do **not** rely on the badge alone for D1/KV with your domain vars — run Step 2.

#### Step 2 — Provision resources (upper half of bootstrap)

On your machine (Node 20+, `npx wrangler login`):

```bash
git clone https://github.com/YOUR_USER/pauth.git
cd pauth

# Resources only — no build/deploy
curl -fsSL https://raw.githubusercontent.com/your-org/pauth/main/scripts/provision-cloudflare.sh -o provision.sh
chmod +x provision.sh
./provision.sh --dir . --skip-clone --yes auth.example.com
```

This creates D1 + KV, writes `wrangler.jsonc`, `wrangler.production.jsonc`, `wrangler.local.jsonc`, and `.dev.vars`.

#### Step 3 — Push config + set secret

```bash
git add wrangler.jsonc wrangler.production.jsonc
git commit -m "Configure Cloudflare D1/KV and domain vars"
git push
```

In Cloudflare Dashboard → Worker → **Settings → Variables and Secrets** → add `SESSION_SECRET` (copy from `.dev.vars`; do not commit `.dev.vars`).

Workers Builds will run migrate + deploy on push.

#### Step 4 — Bind domain + setup

After the first successful Build, bind the auth hostname and upload the secret if not done in Dashboard:

```bash
./scripts/deploy-cloudflare.sh --dir . --skip-clone --yes auth.example.com --config-policy keep
```

(`--config-policy keep` skips rewriting wrangler files; script uploads `SESSION_SECRET`, runs migrate, deploy, and binds `AUTH_HOST`.)

Visit `https://auth.example.com/setup` and register the **root** admin Passkey.

---

### Bootstrap script (full local deploy)

One-shot local deploy (D1/KV, config, build, migrate, deploy, domain bind). **Self-contained single file** — helpers embedded; clones repo automatically.

**推荐：只传认证域名**

```bash
curl -fsSL https://raw.githubusercontent.com/your-org/pauth/main/scripts/full-deploy-cloudflare.sh -o full-deploy.sh
chmod +x full-deploy.sh
npx wrangler login
./full-deploy.sh --yes auth.example.com

# From repo checkout:
npm run deploy:full -- --yes auth.example.com
./scripts/full-deploy-cloudflare.sh --yes auth.example.com
```

Split scripts (badge / CI): `provision-cloudflare.sh` + `deploy-cloudflare.sh` — see [Deploy to Cloudflare badge](#deploy-to-cloudflare-badge).

**Single-file download** (`deploy-cloudflare.sh`; fetches `deploy-common.sh` if needed):

```bash
curl -fsSL https://raw.githubusercontent.com/your-org/pauth/main/scripts/deploy-cloudflare.sh -o bootstrap-pauth.sh
chmod +x bootstrap-pauth.sh
npx wrangler login
./bootstrap-pauth.sh --yes auth.example.com
```

**高级用法（可选参数）**

```bash
# Git mode — also generate wrangler.production.jsonc for Builds
./scripts/full-deploy-cloudflare.sh --yes auth.example.com --deploy-mode git

# 自定义 zone / Worker 名 / 安装目录
./scripts/full-deploy-cloudflare.sh --yes auth.example.com \
  --zone example.com --worker-name passkey-auth --dir ~/pauth-example

# 升级已有 checkout（保留 wrangler 配置）
./scripts/full-deploy-cloudflare.sh --yes auth.example.com \
  --dir ~/pauth-auth-example-com --skip-clone --config-policy keep
```

Still required: Node.js 20+, git, python3, curl, and Cloudflare auth (`npx wrangler login` or `CLOUDFLARE_API_TOKEN`).

**Wrangler config files**

| File | Purpose | Git |
|------|---------|-----|
| `wrangler.jsonc` | Deploy badge / Workers Builds (`npm run deploy:workers`) | commit after provision |
| `wrangler.local.jsonc` | Local `wrangler deploy` / dev | gitignored |
| `wrangler.production.jsonc` | Cloudflare Git Builds (private fork) | commit after provision |

When a config file already exists, the script prompts: **保留** / **仅同步 D1/KV** / **完全覆盖**.

The script verifies the zone is on your Cloudflare account and force-binds `AUTH_HOST` to the Worker (overrides conflicting Worker/DNS). Use `--skip-domain-bind` to skip.

### GitHub Builds (optional)

After `--deploy-mode git`:

1. Install [Cloudflare Workers & Pages GitHub App](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/) on your private repo
2. Dashboard → Worker → Settings → Builds → Connect to Git
3. **Build:** `npm run build` · **Deploy:** `npm run deploy:workers`
4. Commit `wrangler.jsonc` + `wrangler.production.jsonc` after running `provision-cloudflare.sh`
5. Keep `SESSION_SECRET` in Cloudflare Secrets only (from `.dev.vars` after provision)
6. `deploy:workers` includes remote D1 migrations

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
