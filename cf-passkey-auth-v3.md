# Cloudflare Passkey 认证系统 v3

> **Workers + Assets + D1 + KV** · 中央认证 `auth.xxx.com` · **`.xxx.com` 共享 Cookie** · **Caddy Forward Auth** · **永远审批**

> **pauth 扩展**：OAuth L2（`/api/l2/*`）、社交登录（`/api/oauth/*`）、L1 网关权限、Passkey 代注册、加密备份、部署脚本等见 `README.md`、`md/pauth-l1-l2-upgrade-plan-and-spec.md`、`md/pauth-l1-l2-api-json-examples.md`、`md/pauth-l2-openapi-v1.yaml`。

---

## 1. 目标与范围

### 1.1 要解决的问题

| 需求 | 方案 |
|------|------|
| 首次部署时在 auth 注册管理员，完成后不再出现 setup | 两态状态机 `NEEDS_SETUP` → `ACTIVE` |
| 管理员控制是否开放注册 | `registration_enabled` 开关 |
| **永远必须审批** | 普通用户注册后恒为 `pending`，无关闭选项 |
| 全站 `*.xxx.com` 统一认证 | Passkey 只在 `auth.xxx.com`；子域用 Forward Auth |
| 一把 Passkey 管全站 | `RP_ID = xxx.com`（可注册域） |
| 子域不做注册/登录 | Caddy `forward_auth` → `/api/verify` |

### 1.2 不在范围内

- 跨 apex 域（如 `yyy.com`）
- 按用户分配「可访问哪个子域」（审批通过 + L1 授权即全站有效）
- OAuth **应用侧**集成细节（pauth 已实现 L2 IdP 与社交登录；应用如何接 callback、管角色见 `md/` 规范）

---

## 2. 总体架构

```
                         ┌──────────────────────────────────┐
                         │   auth.xxx.com (Cloudflare Worker) │
                         │   Hono /api/*  +  SPA (Assets)    │
                         │   Passkey 注册 · 登录 · 管理后台    │
                         └───────────────┬──────────────────┘
                                         │
                    ┌────────────────────┼────────────────────┐
                    │                    │                    │
               ┌────▼────┐          ┌────▼────┐         ┌─────▼─────┐
               │   D1    │          │   KV    │         │  Cookie   │
               │ users   │          │challenge│         │ Domain=   │
               │ passkeys│          │ TTL 60s │         │ .xxx.com  │
               │ sessions│          └─────────┘         └───────────┘
               │ config  │
               │ audit   │
               └─────────┘

  用户浏览器
       │
       ├─► app.xxx.com ──► Caddy forward_auth ──► GET auth.xxx.com/api/verify
       │                         │                        │
       │                    302 │                   200 + X-Auth-*
       │                         ▼                        ▼
       │              auth.xxx.com/login        反代业务内容
       │
       └─► auth.xxx.com/login ── Passkey ── Set-Cookie .xxx.com ── 302 回 app
```

**技术栈**

| 层 | 选型 |
|----|------|
| 运行时 | Cloudflare Workers（`nodejs_compat`） |
| HTTP | Hono |
| WebAuthn | `@simplewebauthn/server` + `@simplewebauthn/browser` |
| 数据库 | D1 + Drizzle（或 prepared statements） |
| Challenge | KV（TTL 60s，用后删除） |
| 子域网关 | Caddy `forward_auth` |
| 前端 | 任意 SPA → `dist/` |

---

## 3. 用户访问子域时发生什么

**未登录（无有效 `sid` Cookie）**

```text
1. 用户打开 https://app.xxx.com/dashboard
2. Caddy 将请求（含 Cookie）转发到 auth.xxx.com/api/verify
3. verify 返回 302 → https://auth.xxx.com/login?return_to=https://app.xxx.com/dashboard
4. Caddy 跟随重定向（浏览器进入 auth 登录页）
5. 用户在 auth 看到登录页，点击「Passkey 登录」→ 浏览器弹出 Passkey
6. 登录成功，Set-Cookie: sid=...; Domain=.xxx.com
7. 前端跳回 https://app.xxx.com/dashboard
8. forward_auth → verify 200 → 用户看到业务页面
```

**已登录（有效 Cookie）**

```text
app.xxx.com → verify 200 → 直接看到内容（无跳转、无 Passkey 弹窗）
```

要点：**Passkey 只在 `auth.xxx.com` 弹出**；子域不展示登录 UI、不调用 WebAuthn API。

---

## 4. 系统状态机

```text
NEEDS_SETUP  ── 首个管理员 Passkey 注册成功 ──►  ACTIVE
     ▲                                              │
     └──────────── 管理员执行系统重置 ───────────────┘
```

| 状态 | 含义 |
|------|------|
| `NEEDS_SETUP` | 仅允许 `/api/setup/*` 与 `/setup` 页面 |
| `ACTIVE` | 登录、注册（若开启）、管理后台、verify |

---

## 5. 环境变量

### Secrets（`wrangler secret put`）

| 名称 | 说明 |
|------|------|
| `SESSION_SECRET` | Cookie HMAC 密钥，≥32 字节随机 |

### Vars

| 名称 | 生产示例 | 说明 |
|------|----------|------|
| `RP_ID` | `xxx.com` | WebAuthn 可注册域；**不是** `auth.xxx.com` |
| `RP_NAME` | `XXX Auth` | 显示名 |
| `ORIGIN` | `https://auth.xxx.com` | WebAuthn origin |
| `COOKIE_DOMAIN` | `.xxx.com` | 共享 session，供 `*.xxx.com` 使用 |
| `AUTH_HOST` | `auth.xxx.com` | 登录跳转、return_to 校验 |
| `SESSION_TTL_SECONDS` | `604800` | 7 天 |
| `SETUP_TTL_SECONDS` | `600` | Bootstrap 中间 session |

本地开发：`RP_ID=localhost`，`ORIGIN=http://localhost:8787`，`COOKIE_DOMAIN` 留空（不设 Domain 属性）。

---

## 6. Wrangler 配置

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "passkey-auth",
  "main": "src/index.ts",
  "compatibility_date": "2025-06-05",
  "compatibility_flags": ["nodejs_compat"],

  "vars": {
    "RP_ID": "xxx.com",
    "RP_NAME": "XXX Auth",
    "ORIGIN": "https://auth.xxx.com",
    "COOKIE_DOMAIN": ".xxx.com",
    "AUTH_HOST": "auth.xxx.com",
    "SESSION_TTL_SECONDS": "604800",
    "SETUP_TTL_SECONDS": "600"
  },

  "assets": {
    "directory": "./dist",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": true
  },

  "d1_databases": [{
    "binding": "DB",
    "database_name": "passkey-auth-db",
    "database_id": "<YOUR_D1_ID>",
    "migrations_dir": "migrations"
  }],

  "kv_namespaces": [{
    "binding": "CHALLENGES",
    "id": "<YOUR_KV_ID>"
  }],

  "routes": [{
    "pattern": "auth.xxx.com",
    "zone_name": "xxx.com",
    "custom_domain": true
  }],

  "observability": { "enabled": true }
}
```

**DNS**：`auth.xxx.com` CNAME 到 Cloudflare Worker；业务子域指向跑 Caddy 的机器。

---

## 7. 数据库 Schema

```sql
-- migrations/0001_init.sql

CREATE TABLE system_config (
  id                   INTEGER PRIMARY KEY CHECK (id = 1),
  state                TEXT NOT NULL DEFAULT 'NEEDS_SETUP'
                         CHECK (state IN ('NEEDS_SETUP', 'ACTIVE')),
  registration_enabled INTEGER NOT NULL DEFAULT 0,
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO system_config (id) VALUES (1);

CREATE TABLE users (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'user'
               CHECK (role IN ('admin', 'user')),
  status     TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'active', 'disabled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_users_status ON users(status);
CREATE INDEX idx_users_role   ON users(role);

CREATE TABLE passkeys (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key    TEXT NOT NULL,
  counter       INTEGER NOT NULL DEFAULT 0,
  device_type   TEXT,
  backed_up     INTEGER NOT NULL DEFAULT 0,
  transports    TEXT,
  aaguid        TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at  TEXT
);
CREATE INDEX idx_passkeys_user_id ON passkeys(user_id);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL DEFAULT 'normal'
               CHECK (kind IN ('normal', 'setup', 'register')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE audit_logs (
  id         TEXT PRIMARY KEY,
  actor_id   TEXT,
  action     TEXT NOT NULL,
  target_id  TEXT,
  detail     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_audit_created ON audit_logs(created_at DESC);
```

**后续迁移**（L1/L2、社交登录、代注册等，见 `migrations/`）：

| 迁移 | 主要表 / 变更 |
|------|----------------|
| `0002_l1_l2_clients.sql` | `clients`, `user_l1_access`, `user_client_access`, `invites` |
| `0003_l2_oauth.sql` | `auth_codes`, `access_tokens` |
| `0004_client_secret_plain.sql` | `clients.client_secret` |
| `0005_social_oauth.sql` | `settings`, `oauth_identities`, `users.allowed_*_email` |
| `0006_passkey_delegate.sql` | `passkey_delegate_tokens` |
| `0007_root_admin_name.sql` | 将首个 admin 显示名统一为 `root` |

**审批策略（硬编码，无 DB 开关）**

- Bootstrap 管理员：`status = active`（否则系统无法启动）
- 普通用户注册：`status = pending`，**永远**需管理员批准
- `/api/verify`、登录、`/api/me`：仅 `status === 'active'` 通过

---

## 8. Cookie 规范

| Cookie | 场景 | 属性 |
|--------|------|------|
| `sid` | 正式会话 | `HttpOnly; Secure; SameSite=Lax; Path=/; Domain=.xxx.com; Max-Age=604800` |
| `setup_sid` | Bootstrap 中间态 | `Domain=.xxx.com; Path=/api/setup; Max-Age=600` |
| `reg_sid` | 自注册 / 邀请注册中间态 | `Domain=.xxx.com; Path=/api; Max-Age=600` |

Cookie 值 = `sessionId` + HMAC；权威数据在 D1 `sessions`。

**登出**：删 D1 session + `Set-Cookie sid=; Max-Age=0; Domain=.xxx.com`。

---

## 9. API 路由

```text
公开
├── GET  /api/system/state
├── GET  /api/verify                    ★ Caddy Forward Auth（见 §10）
├── GET  /api/l2/authorize
├── POST /api/l2/token
├── GET  /api/l2/userinfo
├── GET  /api/invite/:token
├── POST /api/invite/:token/begin
├── POST /api/invite/:token/passkey/options
├── POST /api/invite/:token/passkey/verify
├── GET  /api/passkey-delegate/:token
├── POST /api/passkey-delegate/:token/options
├── POST /api/passkey-delegate/:token/verify
├── GET  /api/oauth/google/public-status
├── GET  /api/oauth/microsoft/public-status
├── GET  /api/oauth/google/start
├── GET  /api/oauth/google/callback
├── GET  /api/oauth/microsoft/start
├── GET  /api/oauth/microsoft/callback
├── POST /api/setup/begin
├── POST /api/setup/passkey/options
├── POST /api/setup/passkey/verify
├── POST /api/register/begin            需 registration_enabled=1
├── POST /api/register/passkey/options
├── POST /api/register/passkey/verify
├── POST /api/login/options
├── POST /api/login/verify
└── POST /api/login/logout

用户（sid + active）
├── GET    /api/me
├── GET    /api/me/passkeys
├── POST   /api/me/passkeys/options
├── POST   /api/me/passkeys/verify
└── DELETE /api/me/passkeys/:id         至少保留 1 个

管理员（sid + role=admin）
├── GET    /api/admin/config
├── PATCH  /api/admin/config            registrationEnabled（UI 在 **用户管理**）
├── GET    /api/admin/users?status=
├── POST   /api/admin/users
├── PATCH  /api/admin/users/:id           name / status（root 受保护）
├── DELETE /api/admin/users/:id
├── PUT    /api/admin/users/:id/permissions   { l1Enabled }
├── GET/POST/DELETE /api/admin/users/:id/passkeys/*
├── POST   /api/admin/users/:id/passkeys/delegate
├── POST/DELETE /api/admin/users/:id/google-* / microsoft-*
├── GET/POST/PATCH/DELETE /api/admin/clients
├── POST   /api/admin/clients/:id/regenerate-secret
├── GET/POST /api/admin/integration/webauth|google|microsoft
├── POST   /api/admin/invites
├── POST   /api/admin/backup/export|preview|import   不含 root
├── GET    /api/admin/audit-logs
└── POST   /api/admin/system/reset

静态：/* → ASSETS（SPA）
页面：/setup · /login · /register · /invite/:token · /link-device · /admin/*
  用户管理 · 应用管理 · 集成与安全 · 系统设置 · 审计日志（/admin/logs）
```

### GET /api/system/state

```json
{
  "state": "ACTIVE",
  "registrationEnabled": false
}
```

---

## 10. Forward Auth：`GET /api/verify`

Caddy 将**原始请求的 Cookie** 转发到此端点。除有效会话外，还需 **L1 网关授权**（`user_l1_access.enabled`）。

**逻辑**

```typescript
async function verify(c: Context) {
  const session = await resolveSession(c);
  const l1Ok = session ? await userHasL1Access(c.env, session.user.id) : false;
  if (!session || session.user.status !== 'active' || !l1Ok) {
    const returnTo = buildReturnToFromForwardedHeaders(c);
    const loginUrl = `https://${c.env.AUTH_HOST}/login?return_to=...`;
    return c.redirect(loginUrl, 302);
  }

  return c.body(null, 200, {
    'X-Auth-User-Id': session.user.id,
    'X-Auth-User-Email': session.user.email,
    'X-Auth-User-Name': session.user.name,
    'X-Auth-User-Role': session.user.role,
    'Cache-Control': 'private, no-store, must-revalidate',
  });
}
```

| 响应 | 含义 |
|------|------|
| `200` | 已登录、已审批、有 L1 授权，Caddy 放行 |
| `302` | 未登录 / pending / disabled / 无 L1 / session 过期 → 跳转 auth 登录页 |

**注意**：未登录时返回 **302**（非 401），由 Caddy 跟随到 `auth.xxx.com/login?return_to=...`。

---

## 11. 登录与 return_to

### 登录页 `/login`

Query：`return_to`（可选），示例：

```text
https://auth.xxx.com/login?return_to=https://app.xxx.com/dashboard
```

**return_to 白名单**（防 open redirect）：

- 生产：`https://` 且 hostname 为 `RP_ID` 或其子域（如 `xxx.com`、`app.xxx.com`）
- 本地 dev：允许与 `ORIGIN` **同协议**（如 `http://localhost:8787`），见 `src/lib/return-to.ts`

```typescript
function isAllowedReturnTo(url: string, env: Env): boolean {
  try {
    const u = new URL(url);
    const origin = new URL(env.ORIGIN);
    if (u.protocol !== origin.protocol) return false;
    const base = env.RP_ID; // xxx.com 或 localhost
    if (base === 'localhost') {
      return u.hostname === 'localhost' && u.port === origin.port;
    }
    return u.hostname === base || u.hostname.endsWith('.' + base);
  } catch {
    return false;
  }
}
```

登录成功（`POST /api/login/verify`）：

1. 校验用户 `status === 'active'`
2. 写 D1 session，Set-Cookie `sid`（`Domain=.xxx.com`）
3. 返回 JSON `{ ok: true, redirect: "<url>" }`；前端 `window.location.href = redirect`（非 HTTP 302）

### 登录 UI（前端）

```typescript
// /login 页面
async function handleLogin(returnTo: string | null) {
  const { options, challengeId } = await fetch('/api/login/options', { method: 'POST' }).then(r => r.json());
  const authResp = await startAuthentication({ optionsJSON: options.options });
  const res = await fetch('/api/login/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challengeId, authenticationResponse: authResp, returnTo }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  window.location.href = data.redirect ?? '/admin';
}
```

可选：Conditional UI（`mediation: 'conditional'`）在登录页自动提示 Passkey。

---

## 12. 核心业务流程

### 12.1 Bootstrap（仅一次）

```text
NEEDS_SETUP → 访问任意页 → /setup

POST /api/setup/begin {}
  batch: 检查 state · 无既有 admin · INSERT admin(name=root, active) · INSERT setup session
  Set-Cookie setup_sid

POST /api/setup/passkey/options → KV challenge
浏览器 credentials.create()
POST /api/setup/passkey/verify
  batch: INSERT passkey · state=ACTIVE · 删 setup session · INSERT normal session
  Set-Cookie sid · Clear setup_sid
→ /admin
```

首个管理员固定为 **`root`**（不可改名）。此后 `/api/setup/*` 与 `/setup` 永久 403/redirect。

### 12.2 普通用户注册（永远审批）

```text
前置: ACTIVE 且 registration_enabled=1

POST /api/register/begin { "name", "email" }
  INSERT users(status=pending) · 注册用临时 session cookie

POST /api/register/passkey/options
POST /api/register/passkey/verify
  INSERT passkey · status 保持 pending · 清除临时 cookie
→ 提示「等待管理员审批」

管理员 PATCH /api/admin/users/:id { "status": "active" }
→ 用户方可登录并通过 verify
```

**注册完成后不签发正式 `sid`**，避免 pending 用户持有会话。

### 12.3 登录

```text
POST /api/login/options   → KV challenge（discoverable，无 allowCredentials）
POST /api/login/verify    → 验 Passkey · 更新 counter
  拒绝 pending/disabled
  INSERT session · Set-Cookie sid Domain=.xxx.com
  JSON { redirect }（若 return_to 合法则用其，否则 /admin 或 /login）
```

### 12.4 登出

```text
POST /api/login/logout → DELETE session · Clear sid cookie
```

---

## 13. Caddy 配置

> **推荐配置见 `README.md`「Caddy integration」**：使用 `route { forward_auth; reverse_proxy }`，并在 `forward_auth` 中去掉 `Sec-Fetch-*` 头。以下为备选/简化示例。

### 13.1 保护业务子域（备选：@anonymous 兜底）

```caddyfile
app.xxx.com {
  route {
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
    reverse_proxy 127.0.0.1:8080
  }
}
```

多子域复制 `app` → `admin` / `wiki` 等即可。

### 13.2 公开路径（不鉴权）

```caddyfile
app.xxx.com {
  handle /public/* {
    reverse_proxy 127.0.0.1:8080
  }

  route {
    forward_auth https://auth.xxx.com {
      uri /api/verify
      copy_headers X-Auth-User-Id X-Auth-User-Email X-Auth-User-Name X-Auth-User-Role
    }
    reverse_proxy 127.0.0.1:8080
  }
}
```

### 13.3 auth.xxx.com

```caddyfile
auth.xxx.com {
  reverse_proxy https://passkey-auth.<your-subdomain>.workers.dev
  # 或 Cloudflare 直连 Worker 自定义域，无需 Caddy
}
```

若 Worker 已绑自定义域 `auth.xxx.com`，业务 Caddy 只需能访问该 URL 做 forward_auth。

---

## 14. WebAuthn 配置

```typescript
const rpID = env.RP_ID;           // xxx.com
const expectedOrigin = env.ORIGIN; // https://auth.xxx.com

// 注册（setup / register / 追加 passkey）
generateRegistrationOptions({
  rpName: env.RP_NAME,
  rpID,
  userName: user.email,
  userDisplayName: user.name,
  userID: new TextEncoder().encode(user.id),
  attestationType: 'none',
  authenticatorSelection: {
    residentKey: 'required',
    userVerification: 'required',
  },
});

// 登录
generateAuthenticationOptions({
  rpID,
  userVerification: 'required',
  // 不传 allowCredentials → 可发现凭证，无需输入用户名
});
```

在 `auth.xxx.com` 注册一次 Passkey 后，凭证绑定 `rpId=xxx.com`，与「全站子域共用 auth」模型一致。

---

## 15. 管理员功能

### 配置

```typescript
// PATCH /api/admin/config
{ "registrationEnabled": true }
// 无 requireApproval 字段——永远审批
// UI：开放注册开关在 **用户管理**，不在系统设置
```

### 用户管理

| 操作 | API |
|------|-----|
| 审批 | `PATCH /api/admin/users/:id` `{ "status": "active" }` |
| 禁用 | `PATCH` `{ "status": "disabled" }`（不可禁自己；不可禁 root；不可禁最后一个 active admin） |
| 删除 | `DELETE /api/admin/users/:id`（不可删 root） |
| L1 网关 | `PUT /api/admin/users/:id/permissions` `{ "l1Enabled": true }` |
| 邀请 | `POST /api/admin/invites` |

**root 管理员**：setup 创建的首个 admin（`name: "root"`）；API 响应含计算字段 `isRoot: true`（最早创建的 admin，非 DB 列）。不可改名/禁用/删除；备份不含 root。

禁用用户时 **DELETE 该用户全部 sessions**，verify 立即 302。

### 加密备份（系统设置）

```typescript
POST /api/admin/backup/export   { password }
POST /api/admin/backup/preview  { password, bundle }
POST /api/admin/backup/import   { password, bundle }
```

- 信封 `pauth-backup-encrypted-v1`（PBKDF2 + AES-GCM）
- 导出：除 root 外的用户、Passkey、应用、OAuth、L1、邀请、注册开关
- 导入：清空非 root 数据并替换；**不覆盖** root 与 root Passkey

### 系统重置

```typescript
POST /api/admin/system/reset
{ "confirmation": "RESET_ALL_I_UNDERSTAND" }
```

D1 batch：审计 → 清 sessions/passkeys/users/audit → `state=NEEDS_SETUP` → Clear cookies。

---

## 16. 项目结构

```text
passkey-auth/
├── wrangler.jsonc
├── wrangler.local.jsonc          # 本地部署（gitignore）
├── wrangler.production.jsonc     # Git Builds 模板
├── scripts/full-deploy-cloudflare.sh   # npm run deploy:full / deploy:bootstrap
├── scripts/provision-cloudflare.sh     # npm run provision:cloudflare
├── scripts/deploy-cloudflare.sh        # badge/CI 薄封装（provision + deploy）
├── migrations/0001_init.sql … 0007_root_admin_name.sql
├── src/
│   ├── index.ts
│   ├── lib/
│   │   ├── session.ts
│   │   ├── challenge.ts
│   │   ├── webauthn.ts
│   │   ├── backup.ts / backup-crypto.ts
│   │   ├── root-user.ts
│   │   └── …
│   └── routes/
│       ├── system.ts        # state + verify
│       ├── setup.ts
│       ├── register.ts / login.ts / me.ts
│       ├── l2.ts / oauth.ts / passkey-delegate.ts
│       └── admin.ts + admin-backup.ts + admin-oauth.ts
└── app/                     # SPA → dist/
    └── pages/admin/         # 用户/应用/集成/设置/审计
```

---

## 17. 前端页面

| 路径 | 条件 | 说明 |
|------|------|------|
| `/setup` | `NEEDS_SETUP` | root 管理员 Passkey，完成后不再出现 |
| `/login` | `ACTIVE` | Passkey / 社交登录；支持 `?return_to=` |
| `/register` | `ACTIVE` + 注册开启 | 注册后提示待审批 |
| `/invite/:token` | 有效邀请 | 邀请用户注册 Passkey，完成后直接 `active` |
| `/link-device` | 有效代注册链接 | 管理员生成的 Passkey 代注册页 |
| `/admin/users` | admin + active | 用户、L1、邀请、开放注册 |
| `/admin/clients` | admin + active | OAuth 应用管理 |
| `/admin/integration` | admin + active | Google / Microsoft / WEBAUTH |
| `/admin/config` | admin + active | 加密备份、系统重置 |
| `/admin/logs` | admin + active | 审计日志 |

根路由 loader：

```typescript
const { state } = await fetch('/api/system/state').then(r => r.json());
if (state === 'NEEDS_SETUP') redirect('/setup');
if (state === 'ACTIVE' && path.startsWith('/setup')) redirect('/login');
```

---

## 18. 安全清单

| 项 | 做法 |
|----|------|
| 会话 | HttpOnly Cookie + D1；`Domain=.xxx.com` |
| 审批 | 硬编码；verify/登录仅 `active` |
| Challenge | KV 60s；verify 后 delete |
| Passkey 重放 | 更新 `counter` |
| Bootstrap 竞态 | D1 batch + 禁止重复 admin |
| Setup/Register 隔离 | 独立路由 |
| CSRF | SameSite=Lax + mutating 请求校验 Origin |
| return_to | 生产仅 `https://*.xxx.com`；本地 dev 允许与 `ORIGIN` 同协议 |
| 重置 | 确认字符串 + admin + Origin |
| 禁用 | 删 sessions |
| 最后 admin | disable 时拒绝 |
| root admin | 不可改名/禁用/删除；备份不含 root |
| 子域 XSS | 仅信任可控子域共享 Cookie |

---

## 19. 本地开发与部署

### 本地开发 vars

`wrangler.local.jsonc.example` 使用 `example.com` 占位符，便于对照生产配置。纯本地 API 冒烟可改为：

```jsonc
"RP_ID": "localhost",
"ORIGIN": "http://127.0.0.1:8787",
"COOKIE_DOMAIN": "",
"AUTH_HOST": "127.0.0.1:8787"
```

Passkey 完整流程需真实浏览器；`RP_ID=localhost` 时 `return_to` 也须为 `http://localhost:8787/...`。

### 快速部署（推荐）

```bash
npm run deploy:full -- --yes auth.example.com
# 等价
npm run deploy:bootstrap -- --yes auth.example.com
# 或直接
./scripts/full-deploy-cloudflare.sh --yes auth.example.com
```

**脚本分工**（与 README 一致）：

| 命令 / 脚本 | 用途 |
|-------------|------|
| `npm run deploy:full` / `deploy:bootstrap` → `full-deploy-cloudflare.sh` | 全量：D1/KV + 配置 + 构建 + 迁移 + 部署 + 绑域 |
| `npm run provision:cloudflare` → `provision-cloudflare.sh` | 仅资源与 wrangler 配置（badge 上半步） |
| `scripts/deploy-cloudflare.sh` | 薄封装：provision + deploy（badge/CI 第二步） |

脚本会：创建 D1 + KV → 写入 `wrangler.local.jsonc` → 上传 `SESSION_SECRET` → 远程迁移 → 部署 → 自动绑定 Custom Domain。

升级已有实例时可指定 `--config-policy keep|merge-bindings|overwrite`；Git Builds 用 `--deploy-mode git`。

### 手动步骤

```bash
npm install
cp wrangler.local.jsonc.example wrangler.local.jsonc   # 填入 D1/KV ID 与域名
cp .dev.vars.example .dev.vars
wrangler d1 create passkey-auth-db
wrangler kv namespace create CHALLENGES
npm run db:migrate:remote
npx wrangler secret put SESSION_SECRET -c wrangler.local.jsonc
npm run build && npm run deploy
```

**端到端验证顺序**

1. Bootstrap（root）→ admin 登录
2. `curl -b cookies auth.xxx.com/api/verify` → 200（需 L1 授权）
3. Caddy 保护测试子域 → 未登录 302 login → 登录后访问成功
4. 开注册 → 用户 pending → verify 302 → 批准 + L1 → verify 200
5. 系统设置 → 导出/导入加密备份（不含 root）

---

## 20. 实现顺序（历史记录）

> 以下为实现阶段计划，**核心功能已完成**。可选后续：Turnstile、Rate Limiting、审计日志按 layer/client 筛选 UI。

| 步骤 | 内容 | 状态 |
|------|------|------|
| 1 | wrangler + migration + Hono + ASSETS | 已完成 |
| 2 | session（含 `COOKIE_DOMAIN`）+ challenge + webauthn | 已完成 |
| 3 | Bootstrap 全流程 | 已完成 |
| 4 | **`GET /api/verify`** + 登录/登出 + return_to | 已完成 |
| 5 | 注册 + 永远 pending + 管理员审批 | 已完成 |
| 6 | 管理后台 + 审计 | 已完成 |
| 7 | Caddy 联调 `*.xxx.com` | 已完成 |
| 8 | L2 OAuth + 社交登录 + 加密备份 + 部署脚本 | 已完成 |
| 9 | （可选）Turnstile、Rate Limiting | 待定 |

---

## 21. 与 v2 / 旧版 v3 差异摘要

| 项目 | 旧方案 | 本版 v3 |
|------|--------|---------|
| 子域接入 | OAuth / 未定义 | **Forward Auth + `.xxx.com` Cookie** |
| RP_ID | `auth.xxx.com` | **`xxx.com`** |
| 审批 | 可配置关闭 | **永远审批** |
| verify API | 无 | **`GET /api/verify`** |
| 登录跳转 | 无 | **`/login?return_to=`** |
| 跨 apex | 讨论过 | **明确不做** |

---

## 22. 常见问题

**Q：用户在 `app.xxx.com` 会直接弹 Passkey 吗？**  
A：不会。先 302 到 `auth.xxx.com/login`，在 auth 页弹 Passkey。

**Q：审批前用户能访问子域吗？**  
A：不能。pending 用户无正式 sid；即使有会话且无 L1，verify 也返回 **302** 到登录页。

**Q：还要 OAuth 吗？**  
A：`*.xxx.com` 场景不需要。共享 Cookie + forward_auth 即可。

**Q：每个子域要单独注册 Passkey 吗？**  
A：不要。只在 auth 注册一次，全站有效。
