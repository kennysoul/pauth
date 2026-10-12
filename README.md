# Passkey Auth

面向同一根域（`*.xxx.com`）的 Cloudflare Workers 认证服务：**L1**（Caddy `forward_auth`）+ **L2**（应用 OIDC）。

登录方式仅为 **Passkey / Google / Microsoft** — 无密码、无开放自助注册。由管理员创建账号，用户通过激活链接完成激活。技术栈：Hono + D1 + KV + Vite SPA。

English: [README_EN.md](README_EN.md) · API 索引：[`docs/API.md`](docs/API.md)

## 环境要求

- Node.js 20+（`package.json` 中 `engines.node`：`>=20.9.0`）
- Wrangler 4（`package.json` 中 `wrangler@^4`）— 用于 `npm run dev` / `npm run deploy`

## 本地开发

1. 复制本地 Wrangler 配置模板，填入域名与 Cloudflare 资源 ID：

```bash
cp wrangler.local.jsonc.example wrangler.local.jsonc
cp .dev.vars.example .dev.vars
```

编辑 `wrangler.local.jsonc`（已 gitignore）。上游仓库中的 `wrangler.jsonc`（Workers Builds 配置）是**占位模板** — 首次部署时 `npm run provision:cloudflare` 会用你的真实值覆盖；**不要**把真实域名或资源 ID 提交回该模板。

若仅在 `http://127.0.0.1:8787` 做 **API 冒烟测试**，可设 `RP_ID=localhost`、`ORIGIN=http://127.0.0.1:8787`，并留空 `COOKIE_DOMAIN`。模板 `wrangler.local.jsonc.example` 使用 `example.com` 占位以贴近生产布局。浏览器内真实 Passkey 流程通常需要稳定主机名（反代或开发域名），而不是裸 `127.0.0.1`。

2. 安装、迁移、构建并运行：

```bash
npm install
npm run db:migrate:local
npm run build
npm run dev
```

通过反代打开 `https://auth.<你的域名>/setup`，或访问 http://127.0.0.1:8787 做 API 冒烟测试。

**Passkey 流程必须用真实浏览器**（Safari/Chrome 平台认证器或安全密钥）。

### 首次初始化

1. 访问 `/setup` — 为固定的 **root** 引导管理员注册 Passkey（名称始终为 `root`）
2. 管理后台 `/admin`
3. （可选）**集成与安全** — 配置 Google / Microsoft OAuth；未配置前登录页只显示 Passkey
4. 在 **用户管理** 创建用户（名称 + 可选邮箱）
5. 为该用户生成 **激活链接** — 用户打开后可通过 Passkey、Google 或 Microsoft 任一方式完成激活

### 管理后台

| 页面 | 用途 |
|------|------|
| 用户管理 | 用户、激活链接、L1 授权、每用户 Passkey（他人的 Google/Microsoft 状态只读；绑定仅本人可操作） |
| 应用管理 | OAuth 客户端（L2 / L1+L2） |
| 集成与安全 | Google / Microsoft 的 client ID 与密钥（配置后 `/login` 才会出现对应按钮） |
| 系统设置 | 加密备份导出/导入、恢复出厂 |
| 审计日志 | 审计记录 |

### 自助账户页

普通用户（以及管理员管理自己的账号）进入 `/me/profile` — 侧栏布局与管理后台类似，**用户信息**可改姓名/邮箱、管理自己的 Passkey、绑定/解绑自己的 Google/Microsoft。任何人（含管理员）都不能替他人绑定或解绑 OAuth 身份，只能账号本人操作。

### root 引导管理员

- 首次 setup 创建的管理员名称始终为 **`root`**（按 `createdAt` 最早的管理员）
- **不能**重命名、禁用或删除 `root`
- 其他用户不能使用显示名 `root`
- 加密备份**排除** `root` 及其 Passkey/OAuth 数据；导入永不覆盖 `root`

### 灾难恢复（加密备份）

管理后台 **系统设置 → 加密备份**：

- **导出：** 密码（≥8 字符）→ AES-256-GCM + PBKDF2（10 万次迭代）加密 JSON 下载
- **导入：** 文件 + 密码 → 预览 → 确认；替换所有非 root 用户、客户端与设置

API：`POST /api/admin/backup/export|preview|import`（需管理员会话）。

### 会话 API

| 方法 | 路径 | 用途 |
|------|------|------|
| POST | `/api/login/logout` | 结束会话；清除 `sid` cookie（管理 UI 使用） |

### 账户激活（新用户 / 身份重置）

管理员在 **用户管理** 为待激活用户（或已激活用户做身份重置）生成 **激活链接**。链接有效 15 分钟，最多打开 3 次；同一用户同时仅一条有效链接。打开后可通过 **任一**：Passkey 注册、Google OAuth、Microsoft OAuth 完成激活。`POST /api/admin/users/:id/complete-link`，消费路径 `/api/complete/:token/*`。

### Passkey 委托（管理员协助，额外设备）

与上方账户激活不同：管理员在 **用户管理 → Passkey** 生成一次性链接，让已有用户在另一台设备上注册**额外** Passkey。用户打开 `/link-device?t=<token>`，经 `/api/passkey-delegate/:token/*` 注册。

### 冒烟测试（仅 API）

```bash
curl -s http://localhost:8787/api/system/state
# → {"state":"NEEDS_SETUP",...}

curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8787/api/verify
# → 302
```

### Verify API（Forward Auth）

未认证请求返回 **302** 到登录页（带 `return_to`）。已认证返回 **200** 与身份头。

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8787/api/verify
# → 302
```

## Caddy 集成（Forward Auth）

用本 Worker 保护后端站点（如 `site.xxx.com`、OpenWrt LuCI、内网应用）。Caddy 对每个请求调用 `GET /api/verify`；未登录返回 **302**（浏览器跳转登录），会话有效返回 **200**。

### 前置条件

- Worker 部署在 `auth.xxx.com`，vars 对齐（`RP_ID`、`ORIGIN`、`COOKIE_DOMAIN`、`AUTH_HOST`）
- 会话 cookie 域为 `.xxx.com`，一次登录覆盖所有子域
- Caddy 在源站终止 TLS；受保护主机名的 DNS 指向该服务器

### Caddyfile 模板

替换占位符：

| 占位符 | 示例 |
|--------|------|
| `auth.xxx.com` | 认证 Worker 主机名 |
| `site.xxx.com` | 受保护站点主机名 |
| `192.168.1.100` | 后端 IP（路由、NAS 等） |
| `80` / `2023` | 后端端口 |

```caddy
{
	ocsp_stapling off
}

# 通过 Cloudflare DNS 申请证书（可选 — 也可用自有 ACME / 证书方式）
(tls_xxx) {
	tls {
		dns cloudflare {env.CF_API_TOKEN}
	}
}

# ── 统一鉴权片段 ──
# 转发给 auth 前剥掉 Sec-Fetch-*，避免导航类请求头导致校验子请求异常
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

# ── 受保护站点（route 保证：先鉴权，再反代）──
site.xxx.com {
	import tls_xxx
	route {
		import auth_verify
		reverse_proxy 192.168.1.100:80
	}
}

# 非标准 HTTPS 端口（例如后端 :2023，对外 :9023）
site.xxx.com:9023 {
	import tls_xxx
	route {
		import auth_verify
		reverse_proxy 192.168.1.100:2023
	}
}
```

应用并重载：

```bash
caddy fmt --overwrite /etc/caddy/Caddyfile
caddy reload --config /etc/caddy/Caddyfile
```

### 工作原理

1. 用户访问 `https://site.xxx.com/...`
2. Caddy `forward_auth` 向 `https://auth.xxx.com/api/verify` 发子请求，带上浏览器 Cookie 与 `X-Forwarded-*`
3. Worker 校验 `.xxx.com` 会话 cookie：
   - **无有效会话** → **302** 到 `https://auth.xxx.com/login?return_to=...`
   - **有效会话** → **200** + `X-Auth-User-*`；Caddy 再反代到后端
4. 登录成功后（Passkey / Google / Microsoft），Worker 在 `.xxx.com` 写入 cookie，并跳转到 `return_to`（必须属于同一 `RP_ID` 根域）

### 注意

- 受保护主机与 `auth.xxx.com` 必须同一根域（`RP_ID` / `COOKIE_DOMAIN`）— 否则 `return_to` 会被拒绝，用户可能落到 `/admin` 而不是原站
- 务必把 `import auth_verify` 与 `reverse_proxy` 包在 **`route { }`** 里，保证先鉴权再进后端
- **不要**再包一层把 401 转跳转的 `handle_errors`；Worker 已返回 302
- 后端应用可能自带登录（如 LuCI 的 `root` 密码）— pauth 只是**外层**门禁
- 可选：把 `X-Auth-User-*` 传给后端供应用读取

### 快速测试

在**没有**会话 cookie 的机器上：

```bash
curl -sk -o /dev/null -w "%{http_code} -> %{redirect_url}\n" \
  -H "sec-fetch-mode: navigate" \
  https://site.xxx.com/
# → 302 -> https://auth.xxx.com/login?return_to=...
```

## OpenID Connect（OIDC）/ L2 OAuth

pauth 实现标准 OpenID Connect Provider，可作 PVE、Grafana、GitLab、Immich 等依赖方的身份源。

### OIDC 端点

| 端点 | 说明 |
|------|------|
| `GET /.well-known/openid-configuration` | OIDC Discovery，自动列出各端点 |
| `GET /.well-known/jwks.json` | 校验 `id_token` 签名的 RS256 公钥 |
| `/api/l2/authorize` | 授权端点（浏览器跳转） |
| `/api/l2/token` | Token 端点（返回 JWT `id_token`） |
| `/api/l2/userinfo` | UserInfo（`sub`、`email`、`name`） |

### 依赖方配置

| 字段 | 示例 |
|------|------|
| **Issuer URL** | `https://auth.xxx.com` |
| **Client ID** | 在管理后台 **应用管理** 创建 |
| **Client Secret** | 创建客户端时给出 |

无需手填各端点 — Issuer URL 通过 discovery 自动发现 `authorization_endpoint`、`token_endpoint`、`userinfo_endpoint`、`jwks_uri`。

### Token 细节

- `id_token` 为签名 JWT（`RS256`），含 `iss`、`sub`、`aud`、`exp`、`iat`，可选 `nonce`、`email`、`name`
- `access_token` 为不透明令牌（D1 存 SHA-256 哈希），TTL 600 秒
- 授权码一次性使用，TTL 600 秒
- `redirect_uri` 接受任意合法 URL（HTTPS、本机 HTTP，或如 `app.immich://` 的自定义 scheme）

### 邮箱与第三方对接

每位用户有唯一 `email` 字段。OIDC 的 `id_token` 与 `userinfo` 会返回 email claim，供依赖方按邮箱匹配用户。

- **管理员创建用户**时可在用户管理填可选邮箱；留空则自动生成 `username@domain`（由 `ORIGIN` 推导）
- **用户可在网页改自己的邮箱**
- **管理员可改任意用户邮箱**（用户管理 → 编辑）
- **Immich OIDC**：请使用真实邮箱，勿用自动占位邮箱；Immich 按 `email` claim 匹配

API：`PUT /me/email`（用户自改）、`PATCH /admin/users/:id`（管理员修改）。

API 索引：[`docs/API.md`](docs/API.md)

## 部署到 Cloudflare

| 方式 | 适用场景 |
|------|----------|
| **[一键引导](#1-一键引导推荐)**（`full-deploy-cloudflare.sh`） | 首次 / 从零部署 — 只需认证域名 |
| **[仅更新代码](#2-仅更新代码保留数据)** | Worker 已存在；只更新代码，**不动** D1/KV/密钥 |
| **[Workers Builds](#3-workers-builds可选)** | 从 GitHub 自动部署（每个仓库一个主 Worker） |
| **[手动部署](#4-从已有仓库手动部署)** | 已有资源 ID，需要完全自行控制 |

### 前置条件

- Node.js 20+、git、python3、curl
- Cloudflare 认证：`npx wrangler login` 或 `CLOUDFLARE_API_TOKEN`
- 认证域名所属 **zone 必须已在本 Cloudflare 账号**
- `SESSION_SECRET` ≥32 字符 — 放在 Cloudflare Secrets（切勿提交进仓库）
- **一个认证域名 = 一套独立栈**（Worker + D1 + KV + 用户）。`auth.a.com` 与 `auth.b.com` **不共享**账号
- **L1 forward_auth 站点必须与该认证主机同一根域**（`RP_ID` / `COOKIE_DOMAIN`）。例如用 `auth.example.com` 保护 `*.example.com`，不能用 `auth.other.com` 去保护

### 1. 一键引导（推荐）

一站式：按需创建 D1/KV、写配置、构建、迁移、部署、绑定自定义域名。脚本自包含（内嵌辅助逻辑；可自动 clone 仓库）。

**只需一个参数：** Passkey 认证主机名。

```bash
npx wrangler login   # 首次

# 下载脚本后执行（若用 fork，请设置 PAUTH_REPO_URL）
export PAUTH_REPO_URL=https://github.com/your-org/pauth.git   # 可选
curl -fsSL https://raw.githubusercontent.com/your-org/pauth/main/scripts/full-deploy-cloudflare.sh -o full-deploy.sh
chmod +x full-deploy.sh
./full-deploy.sh --yes auth.example.com
# 等价：./full-deploy.sh --yes --auth-host auth.example.com

# 在已有仓库内
./scripts/full-deploy-cloudflare.sh --yes auth.example.com
# 或：npm run deploy:full -- --yes auth.example.com
```

完成后打开 `https://auth.example.com/setup` 注册 **root** 管理员 Passkey。

#### 主机名如何推导资源

| 项目 | 规则 | 示例（`auth.example.com`） |
|------|------|---------------------------|
| Zone | 去掉最左侧标签 | `example.com` |
| Worker | `pauth-<auth-host-slug>` | `pauth-auth-example-com` |
| D1 | `pauth-<auth-host-slug>-db` | `pauth-auth-example-com-db` |
| KV | `CHALLENGES-pauth-<auth-host-slug>` | `CHALLENGES-pauth-auth-example-com` |
| 安装目录 | `~/pauth-<auth-host-slug>` | `~/pauth-auth-example-com` |
| `RP_ID` / cookie | 来自 zone | `example.com` / `.example.com` |
| `ORIGIN` / `AUTH_HOST` | 认证 URL / 主机 | `https://auth.example.com` / `auth.example.com` |

#### 新建 vs 升级（同一条命令）

| 情况 | 行为 |
|------|------|
| 该主机尚无 Worker / 本地无配置 | **新建** D1、KV、Worker |
| 已有 `~/pauth-<slug>/wrangler.local.jsonc` 且 `AUTH_HOST` 匹配 | **升级** — 保留 vars 与资源 ID |
| Cloudflare 上该主机名已绑定 Worker（需 API Token） | **升级** — 复用该 Worker |

再次执行同一命令默认升级（`merge-bindings`）。脚本会校验 zone，并强制把 `AUTH_HOST` 绑到 Worker（覆盖冲突的 Worker/DNS）。可用 `--skip-domain-bind` 跳过绑定。

若已有 wrangler 配置，脚本会提示：**保留** / **仅同步 D1/KV** / **完全覆盖**。

#### 多个认证域名

每个主机独立一套栈（用户**不互通**）：

```bash
./scripts/full-deploy-cloudflare.sh --yes auth.example.com
./scripts/full-deploy-cloudflare.sh --yes auth.example2.com
```

#### Wrangler 配置文件

| 文件 | 用途 | Git |
|------|------|-----|
| `wrangler.jsonc` | Workers Builds 主配置（`npm run deploy:workers`）— 上游为**占位**；provision 后提交**你的**真实值 | provision 后提交 |
| `wrangler.production.jsonc` | 可选 Builds 配置（`--deploy-mode git`） | provision 后提交 |
| `wrangler.local.jsonc` | 本地 `wrangler deploy` / `dev` | gitignore |
| `wrangler.<slug>.jsonc` | 额外认证域名（手动部署） | gitignore（含真实 D1/KV ID） |

仅开通资源、不构建部署：`scripts/provision-cloudflare.sh` / `npm run provision:cloudflare` — 见该文件顶部注释。

#### 高级选项

| 参数 | 用途 |
|------|------|
| `--zone` | 手动指定根域（如 `co.uk`） |
| `--dir` | 安装目录（默认 `~/pauth-<slug>`） |
| `--worker-name` | 固定 Worker 名（如沿用旧名 `passkey-auth`） |
| `--d1-name` / `--kv-title` | 自定义 D1 / KV 名称 |
| `--deploy-mode git` | 同时写出 `wrangler.production.jsonc` 供 Builds |
| `--config-policy keep\|merge-bindings\|overwrite` | 已有 wrangler 配置时的策略 |
| `--skip-clone` | 使用已有 checkout（配合 `--dir`） |
| `--skip-domain-bind` | 不绑定自定义域名 |
| `--rotate-secret` | 强制更换 `SESSION_SECRET` |
| `--allow-worker-overwrite` | 允许覆盖已绑定其他主机名的 Worker |

```bash
# 准备 Builds 配置
./scripts/full-deploy-cloudflare.sh --yes auth.example.com --deploy-mode git

# 自定义名称 / 目录
./scripts/full-deploy-cloudflare.sh --yes auth.example.com \
  --zone example.com --worker-name passkey-auth --dir ~/pauth-example

# 升级已有 checkout；保留 wrangler 文件不动
./scripts/full-deploy-cloudflare.sh --yes auth.example.com \
  --dir ~/pauth-auth-example-com --skip-clone --config-policy keep
```

### 2. 仅更新代码（保留数据）

当 Worker、D1、KV、路由、vars、密钥都已正确 — 只发布 **代码 + 静态资源**：

```bash
npm run build
npx wrangler deploy --config wrangler.<slug>.jsonc   # 或 wrangler.local.jsonc / wrangler.jsonc
```

仅当 `migrations/` 有新文件时才做远程迁移（例如用对应 `--config` 执行 `npm run db:migrate:remote`）。除非打算替换配置/密钥，否则**不要**用 `--config-policy overwrite` 或 `--rotate-secret` 重跑一键引导。

### 3. Workers Builds（可选）

1. 安装 [Cloudflare Workers GitHub App](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/)
2. Dashboard → Worker → Settings → Builds → Connect to Git
3. **Build：** `npm run build` · **Deploy：** `npm run deploy:workers`（会跑 `lint:wrangler`、远程 D1 迁移，再部署）
4. provision 后提交你的真实 `wrangler.jsonc`（不要提交上游占位）
5. `SESSION_SECRET` 只放在 Cloudflare Secrets

每个仓库只有**一个** Worker 能用 Builds（读取根目录 `wrangler.jsonc`）。额外认证域名用上面的「仅更新代码」+ `wrangler.<slug>.jsonc`。

### 4. 从已有仓库手动部署

```bash
cp wrangler.local.jsonc.example wrangler.local.jsonc   # 填入 D1/KV ID 与域名 vars
cp .dev.vars.example .dev.vars                           # SESSION_SECRET ≥32
npm install
npm run db:migrate:remote
npm run deploy                                           # 经 wrangler.local.jsonc 构建并部署
npx wrangler secret put SESSION_SECRET -c wrangler.local.jsonc
```

### 生产环境变量

| 变量 | 示例 | 作用 |
|------|------|------|
| `RP_ID` | `xxx.com` | WebAuthn RP ID；L1 `return_to` 白名单根域 |
| `ORIGIN` | `https://auth.xxx.com` | 对外源站 / OIDC issuer |
| `COOKIE_DOMAIN` | `.xxx.com` | 会话 cookie 域（子域一次登录） |
| `AUTH_HOST` | `auth.xxx.com` | 登录跳转所用主机名 |

```jsonc
"RP_ID": "xxx.com",
"ORIGIN": "https://auth.xxx.com",
"COOKIE_DOMAIN": ".xxx.com",
"AUTH_HOST": "auth.xxx.com"
```
