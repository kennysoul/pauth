# Cloudflare Workers + Pages + D1 Passkey 认证系统 v2

> **已过时**：当前实现见 `cf-passkey-auth-v3.md`、`README.md` 与 `md/pauth-l1-l2-upgrade-plan-and-spec.md`。本文档保留作历史参考。

> 新增功能：管理员引导注册（Bootstrap）、注册开关+审批、管理员后台（用户管理/系统重置）

---

## 系统状态机

系统有四种全局状态，存储在 D1 `system_config` 表中：[cite:174]

```
UNINITIALIZED  →  BOOTSTRAP（首次初始化，注册第一个管理员）
                      ↓
                  ACTIVE（正常运行，管理员可开/关注册）
                      ↓（重置）
               UNINITIALIZED（回到初始状态）
```

---

## 新增数据库 Schema

在原有基础上增加以下三张表：

```sql
-- migrations/0002_admin_features.sql

-- 系统配置表（单行）
CREATE TABLE IF NOT EXISTS system_config (
  id                   INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),  -- 始终只有一行
  state                TEXT NOT NULL DEFAULT 'UNINITIALIZED'
                         CHECK (state IN ('UNINITIALIZED', 'BOOTSTRAP', 'ACTIVE')),
  registration_enabled INTEGER NOT NULL DEFAULT 0,   -- 管理员是否开启注册
  require_approval     INTEGER NOT NULL DEFAULT 1,   -- 是否需要管理员审批
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 插入唯一的系统配置行
INSERT OR IGNORE INTO system_config (id, state) VALUES (1, 'UNINITIALIZED');

-- 用户角色和状态扩展（在 users 表增加列）
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'
  CHECK (role IN ('admin', 'user'));
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'
  CHECK (status IN ('pending', 'active', 'disabled'));

-- 审计日志
CREATE TABLE IF NOT EXISTS audit_logs (
  id         TEXT PRIMARY KEY,
  actor_id   TEXT,                         -- 操作人 user_id（NULL 表示系统）
  action     TEXT NOT NULL,                -- 操作类型（见下方枚举）
  target_id  TEXT,                         -- 操作对象（user_id 等）
  detail     TEXT,                         -- JSON 附加信息
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- action 枚举说明：
-- SYSTEM_INIT          系统初始化
-- SYSTEM_RESET         系统重置
-- USER_REGISTER        用户申请注册
-- USER_APPROVE         管理员审批通过
-- USER_REJECT          管理员拒绝
-- USER_DISABLE         管理员禁用用户
-- PASSKEY_DELETE       删除 Passkey
-- PASSKEY_REGISTER     注册 Passkey
-- REGISTRATION_TOGGLE  开关注册功能
```

---

## 路由总览

```
公开路由（无需认证）
├── GET  /                          → 系统状态检查（前端路由判断入口）
├── POST /api/setup/init            → 初始化系统（仅 UNINITIALIZED 状态可调用）
├── POST /api/register/options      → 生成注册 challenge（需系统开启注册）
├── POST /api/register/result       → 提交注册（进入待审批队列）
├── POST /api/login/options         → 生成登录 challenge
└── POST /api/login/result          → 验证登录，签发 JWT

用户路由（需 JWT，状态 active）
├── GET  /api/me                    → 获取当前用户信息
└── GET  /api/me/passkeys           → 获取我的 Passkey 列表

管理员路由（需 JWT + role=admin）
├── GET  /api/admin/config          → 查看系统配置
├── PATCH /api/admin/config         → 修改系统配置（开关注册、审批要求）
├── GET  /api/admin/users           → 用户列表（含待审批）
├── POST /api/admin/users/:id/approve   → 审批通过用户
├── POST /api/admin/users/:id/reject    → 拒绝用户
├── POST /api/admin/users/:id/disable   → 禁用用户
├── DELETE /api/admin/users/:id/passkeys/:pkId  → 删除指定用户的 Passkey
└── POST /api/admin/system/reset    → 重置整个系统（危险操作）
```

---

## 初始化流程（Bootstrap）

### 前端入口逻辑

```typescript
// app/routes/_index.tsx
// 页面加载时调用 /api/system/state，根据状态跳转

export async function loader() {
  const res = await fetch('/api/system/state');
  const { state } = await res.json();

  // UNINITIALIZED → 跳转初始化向导
  // BOOTSTRAP     → 跳转管理员注册页
  // ACTIVE        → 跳转正常登录页
  return redirect({
    UNINITIALIZED: '/setup',
    BOOTSTRAP: '/setup/register-admin',
    ACTIVE: '/login',
  }[state]);
}
```

### Step 1：`/setup` — 初始化向导

```typescript
// app/routes/setup.tsx
// 仅在 UNINITIALIZED 状态显示
// 用户看到"初始化系统"按钮，点击后调用 POST /api/setup/init

async function initSystem() {
  const res = await fetch('/api/setup/init', { method: 'POST' });
  // 系统切换到 BOOTSTRAP 状态 → 跳转到 /setup/register-admin
  navigate('/setup/register-admin');
}
```

### Step 2：`/setup/register-admin` — 注册第一个管理员

```typescript
// app/routes/setup.register-admin.tsx
// 只有在 BOOTSTRAP 状态下才允许访问此页面

export default function RegisterAdminPage() {
  const [displayName, setDisplayName] = useState('');

  async function handleRegister() {
    // 1. 先用显示名创建临时账号（不需要邮箱，这是管理员专属流程）
    const { userId, tempToken } = await fetch('/api/setup/create-admin', {
      method: 'POST',
      body: JSON.stringify({ displayName }),
    }).then(r => r.json());

    // 2. 注册 Passkey
    const opts = await fetch('/api/register/options', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tempToken}` },
    }).then(r => r.json());

    const result = await startRegistration({ optionsJSON: opts });

    await fetch('/api/register/result', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tempToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(result),
    });

    // 3. 注册完成 → 系统切换到 ACTIVE，跳转登录
    navigate('/login');
  }

  return (
    <div className="setup-page">
      <h1>欢迎！创建管理员账号</h1>
      <p>输入你的名字，然后用设备注册 Passkey</p>
      <input
        value={displayName}
        onChange={e => setDisplayName(e.target.value)}
        placeholder="你的名字（如：Alice）"
        maxLength={50}
      />
      <button onClick={handleRegister} disabled={!displayName.trim()}>
        注册 Passkey 并初始化系统
      </button>
    </div>
  );
}
```

### 后端：初始化相关路由

```typescript
// src/routes/setup.ts

// POST /api/setup/init — 触发初始化
setupRouter.post('/init', async (c) => {
  const db = drizzle(c.env.DB);
  const config = await db.select().from(systemConfig).get();

  if (config?.state !== 'UNINITIALIZED') {
    return c.json({ error: '系统已初始化' }, 409);
  }

  await db.update(systemConfig)
    .set({ state: 'BOOTSTRAP', updatedAt: new Date().toISOString() })
    .where(eq(systemConfig.id, 1));

  await writeAuditLog(db, null, 'SYSTEM_INIT', null, null);

  return c.json({ ok: true });
});

// POST /api/setup/create-admin — 创建管理员用户（BOOTSTRAP 专用）
setupRouter.post('/create-admin', async (c) => {
  const db = drizzle(c.env.DB);
  const config = await db.select().from(systemConfig).get();

  if (config?.state !== 'BOOTSTRAP') {
    return c.json({ error: '系统不在初始化状态' }, 403);
  }

  const { displayName } = await c.req.json();
  if (!displayName?.trim()) {
    return c.json({ error: '名字不能为空' }, 400);
  }

  const userId = uuid();
  await db.insert(users).values({
    id:        userId,
    email:     `admin@system.internal`,   // 管理员内部标识
    name:      displayName.trim(),
    role:      'admin',
    status:    'active',                  // 管理员直接激活，无需审批
    hasPasskey: 0,
  });

  // 签发临时 token（仅用于完成本次 Passkey 注册，有效期 10 分钟）
  const tempToken = await signJwt(
    { sub: userId, role: 'admin', scope: 'bootstrap' },
    c.env.JWT_SECRET,
    600
  );

  return c.json({ userId, tempToken });
});

// 在 /register/result 路由里，完成注册后额外检查：
// 如果当前系统是 BOOTSTRAP 状态，且注册成功，则切换到 ACTIVE
if (config?.state === 'BOOTSTRAP') {
  await db.update(systemConfig)
    .set({ state: 'ACTIVE', updatedAt: new Date().toISOString() })
    .where(eq(systemConfig.id, 1));
}
```

---

## 注册开关 + 审批流程

### 普通用户注册流程

```typescript
// src/routes/register.ts（新增前置检查）

// 检查注册是否开启
registerRouter.use('*', async (c, next) => {
  const db = drizzle(c.env.DB);
  const config = await db.select().from(systemConfig).get();

  if (config?.state !== 'ACTIVE') {
    return c.json({ error: '系统未就绪' }, 503);
  }
  if (!config.registrationEnabled) {
    return c.json({ error: '注册暂未开放' }, 403);
  }
  await next();
});

// POST /api/register/result — 注册完成后的状态判断
// 如果 require_approval = 1，用户状态设为 pending，等待管理员审批
// 如果 require_approval = 0，用户状态直接设为 active

const newStatus = config.requireApproval ? 'pending' : 'active';
await db.update(users)
  .set({ hasPasskey: 1, status: newStatus })
  .where(eq(users.id, user.id));

await writeAuditLog(db, user.id, 'USER_REGISTER', user.id, { email: user.email });

// 如果是 pending，通知管理员（可选：发邮件）
if (newStatus === 'pending') {
  await notifyAdmin(c.env, user.email);
}

return c.json({
  ok: true,
  status: newStatus,
  message: newStatus === 'pending'
    ? '注册成功，等待管理员审批后即可登录'
    : '注册成功，现在可以登录了',
});
```

### 登录时检查用户状态

```typescript
// /api/login/result — 验证通过后，额外检查用户状态
const user = await db.select().from(users)
  .where(eq(users.id, passkeyRow.userId)).get();

if (user?.status === 'pending') {
  return c.json({ error: '账号待审批，请等待管理员确认' }, 403);
}
if (user?.status === 'disabled') {
  return c.json({ error: '账号已被禁用' }, 403);
}
```

---

## 管理员后台路由

### 系统配置

```typescript
// src/routes/admin.ts

// GET /api/admin/config
adminRouter.get('/config', adminMiddleware, async (c) => {
  const db = drizzle(c.env.DB);
  const config = await db.select().from(systemConfig).get();
  return c.json(config);
});

// PATCH /api/admin/config
adminRouter.patch('/config', adminMiddleware, async (c) => {
  const { registrationEnabled, requireApproval } = await c.req.json();
  const db = drizzle(c.env.DB);
  const actor = c.get('user');

  await db.update(systemConfig).set({
    registrationEnabled: registrationEnabled ? 1 : 0,
    requireApproval:     requireApproval ? 1 : 0,
    updatedAt:           new Date().toISOString(),
  }).where(eq(systemConfig.id, 1));

  await writeAuditLog(db, actor.id, 'REGISTRATION_TOGGLE', null, {
    registrationEnabled,
    requireApproval,
  });

  return c.json({ ok: true });
});
```

### 用户管理

```typescript
// GET /api/admin/users — 用户列表（按状态筛选）
adminRouter.get('/users', adminMiddleware, async (c) => {
  const status = c.req.query('status');  // pending | active | disabled | all
  const db = drizzle(c.env.DB);

  const query = db.select({
    id:        users.id,
    name:      users.name,
    email:     users.email,
    role:      users.role,
    status:    users.status,
    hasPasskey: users.hasPasskey,
    createdAt: users.createdAt,
    passkeyCount: sql<number>`(
      SELECT COUNT(*) FROM passkeys WHERE user_id = users.id
    )`,
  }).from(users);

  if (status && status !== 'all') {
    query.where(eq(users.status, status));
  }

  return c.json(await query.all());
});

// POST /api/admin/users/:id/approve — 审批通过
adminRouter.post('/users/:id/approve', adminMiddleware, async (c) => {
  const { id } = c.req.param();
  const actor = c.get('user');
  const db = drizzle(c.env.DB);

  const target = await db.select().from(users).where(eq(users.id, id)).get();
  if (!target || target.status !== 'pending') {
    return c.json({ error: '用户不存在或状态不正确' }, 404);
  }

  await db.update(users)
    .set({ status: 'active', updatedAt: new Date().toISOString() })
    .where(eq(users.id, id));

  await writeAuditLog(db, actor.id, 'USER_APPROVE', id, { email: target.email });

  return c.json({ ok: true });
});

// POST /api/admin/users/:id/reject — 拒绝（删除用户和 Passkey）
adminRouter.post('/users/:id/reject', adminMiddleware, async (c) => {
  const { id } = c.req.param();
  const actor = c.get('user');
  const db = drizzle(c.env.DB);

  const target = await db.select().from(users).where(eq(users.id, id)).get();
  if (!target) {
    return c.json({ error: '用户不存在' }, 404);
  }

  // 级联删除（passkeys 表有 ON DELETE CASCADE）
  await db.delete(users).where(eq(users.id, id));
  await writeAuditLog(db, actor.id, 'USER_REJECT', id, { email: target.email });

  return c.json({ ok: true });
});

// POST /api/admin/users/:id/disable — 禁用用户（不删数据）
adminRouter.post('/users/:id/disable', adminMiddleware, async (c) => {
  const { id } = c.req.param();
  const actor = c.get('user');
  const db = drizzle(c.env.DB);

  // 不能禁用自己
  if (id === actor.id) {
    return c.json({ error: '不能禁用自己' }, 400);
  }

  await db.update(users)
    .set({ status: 'disabled', updatedAt: new Date().toISOString() })
    .where(eq(users.id, id));

  await writeAuditLog(db, actor.id, 'USER_DISABLE', id, {});

  return c.json({ ok: true });
});
```

### 删除指定用户的 Passkey

```typescript
// DELETE /api/admin/users/:id/passkeys/:pkId
adminRouter.delete('/users/:id/passkeys/:pkId', adminMiddleware, async (c) => {
  const { id, pkId } = c.req.param();
  const actor = c.get('user');
  const db = drizzle(c.env.DB);

  const pk = await db.select().from(passkeys)
    .where(and(eq(passkeys.id, pkId), eq(passkeys.userId, id))).get();

  if (!pk) {
    return c.json({ error: 'Passkey 不存在' }, 404);
  }

  await db.delete(passkeys).where(eq(passkeys.id, pkId));

  // 如果该用户已没有任何 Passkey，更新 has_passkey = 0
  const remaining = await db.select().from(passkeys)
    .where(eq(passkeys.userId, id)).all();
  if (remaining.length === 0) {
    await db.update(users)
      .set({ hasPasskey: 0 })
      .where(eq(users.id, id));
  }

  await writeAuditLog(db, actor.id, 'PASSKEY_DELETE', id, { passkeyId: pkId });

  return c.json({ ok: true });
});
```

### 重置整个系统

```typescript
// POST /api/admin/system/reset
// 危险操作：清空所有用户、Passkey、Challenge、Session，系统回到 UNINITIALIZED

adminRouter.post('/system/reset', adminMiddleware, async (c) => {
  const { confirmation } = await c.req.json();

  // 必须传入确认字符串，防止误操作
  if (confirmation !== 'RESET_ALL_I_UNDERSTAND') {
    return c.json({ error: '请传入确认字符串' }, 400);
  }

  const actor = c.get('user');
  const db = drizzle(c.env.DB);

  // 写审计日志（在清空之前）
  await writeAuditLog(db, actor.id, 'SYSTEM_RESET', null, {
    resetBy: actor.email,
    resetAt: new Date().toISOString(),
  });

  // 清空所有数据（按外键依赖顺序）
  await db.delete(passkeyChallenges);
  await db.delete(sessions);
  await db.delete(passkeys);
  await db.delete(users);

  // 系统回到 UNINITIALIZED
  await db.update(systemConfig).set({
    state:               'UNINITIALIZED',
    registrationEnabled: 0,
    requireApproval:     1,
    updatedAt:           new Date().toISOString(),
  }).where(eq(systemConfig.id, 1));

  return c.json({ ok: true, message: '系统已重置，请重新初始化' });
});
```

---

## 管理员后台前端

```typescript
// app/routes/admin._index.tsx
// 需要 adminMiddleware 保护（检查 JWT role=admin）

export default function AdminDashboard() {
  return (
    <div className="admin-layout">
      <aside>
        <nav>
          <a href="/admin">系统概览</a>
          <a href="/admin/users">用户管理</a>
          <a href="/admin/pending">待审批</a>
          <a href="/admin/config">系统设置</a>
          <a href="/admin/logs">审计日志</a>
        </nav>
      </aside>
      <main>
        <Outlet />
      </main>
    </div>
  );
}

// app/routes/admin.config.tsx
export default function AdminConfig() {
  const { config } = useLoaderData();

  return (
    <div>
      <h2>系统设置</h2>

      <section>
        <h3>注册控制</h3>
        <Toggle
          label="允许用户注册"
          checked={config.registrationEnabled}
          onChange={v => updateConfig({ registrationEnabled: v })}
        />
        <Toggle
          label="新用户需要管理员审批"
          checked={config.requireApproval}
          onChange={v => updateConfig({ requireApproval: v })}
        />
      </section>

      <section className="danger-zone">
        <h3>危险操作</h3>
        <button
          className="btn-danger"
          onClick={() => setShowResetModal(true)}
        >
          重置整个认证系统
        </button>
      </section>

      {/* 重置确认弹窗 */}
      <ResetConfirmModal
        open={showResetModal}
        onConfirm={async () => {
          await fetch('/api/admin/system/reset', {
            method: 'POST',
            body: JSON.stringify({ confirmation: 'RESET_ALL_I_UNDERSTAND' }),
          });
          navigate('/setup');
        }}
        onCancel={() => setShowResetModal(false)}
      />
    </div>
  );
}

// app/routes/admin.users.tsx
export default function AdminUsers() {
  const { users } = useLoaderData();

  return (
    <table>
      <thead>
        <tr>
          <th>名字</th>
          <th>邮箱</th>
          <th>状态</th>
          <th>Passkey 数量</th>
          <th>注册时间</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        {users.map(user => (
          <tr key={user.id}>
            <td>{user.name}</td>
            <td>{user.email}</td>
            <td><StatusBadge status={user.status} /></td>
            <td>{user.passkeyCount}</td>
            <td>{formatDate(user.createdAt)}</td>
            <td>
              {user.status === 'pending' && (
                <>
                  <button onClick={() => approve(user.id)}>批准</button>
                  <button onClick={() => reject(user.id)}>拒绝</button>
                </>
              )}
              {user.status === 'active' && user.role !== 'admin' && (
                <button onClick={() => disable(user.id)}>禁用</button>
              )}
              <button onClick={() => viewPasskeys(user.id)}>
                查看 Passkey ({user.passkeyCount})
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

---

## 完整流程总览

```
系统首次启动
    │
    ▼
[UNINITIALIZED] ──→ 访问任意页面 ──→ 跳转 /setup
    │                                    │
    │                           点击"初始化系统"
    │                                    │
    ▼                                    ▼
[BOOTSTRAP] ──────────────── 跳转 /setup/register-admin
                                         │
                              输入管理员名字（无需邮箱）
                              点击"注册 Passkey"
                              设备弹出生物识别 / PIN
                                         │
                              注册成功 → 系统切换到 ACTIVE
                                         │
    ┌────────────────────────────────────┘
    ▼
[ACTIVE] 正常运行
    │
    ├── 登录流程：/login → Passkey 验证 → 签发 JWT
    │
    ├── 注册流程（管理员开启后）：
    │   /register → 输入名字/邮箱 → 注册 Passkey → 进入待审批
    │                                                    │
    │                              管理员在 /admin/pending 审批
    │                                                    │
    │                                        ├── 批准 → status=active，可以登录
    │                                        └── 拒绝 → 删除用户数据
    │
    └── 管理员操作：
        ├── 删除用户 Passkey → 该用户下次需要重新注册 Passkey
        └── 重置系统 → 清空所有数据 → 回到 UNINITIALIZED
```

---

## D1 迁移执行顺序

```bash
npx wrangler d1 execute passkey-auth-db --file=./migrations/0001_init.sql
npx wrangler d1 execute passkey-auth-db --file=./migrations/0002_admin_features.sql
```

---

## 安全补充

- **管理员路由保护**：`adminMiddleware` 检查 JWT 中 `role === 'admin'`，任何非管理员请求返回 403 [cite:138]
- **Bootstrap 状态保护**：`/setup/create-admin` 和 `/setup/register-admin` 路由在系统进入 `ACTIVE` 状态后自动返回 404，无法再被调用
- **重置确认字符串**：`RESET_ALL_I_UNDERSTAND` 防止 API 被误操作或 CSRF 攻击触发
- **审计日志**：所有敏感操作写入 `audit_logs`，不可删除（仅系统重置时随其他数据一起清空）
- **管理员不能删自己**：`/disable` 接口检查 `id !== actor.id`，防止管理员误操作锁死自己 [cite:163]
