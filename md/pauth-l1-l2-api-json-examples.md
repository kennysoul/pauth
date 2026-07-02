# pauth L1/L2 API JSON Examples

Request/response examples for the implemented pauth authentication model.

Base URL (replace with your deployment `ORIGIN`):

```text
https://auth.example.com
```

---

## 1) System: `GET /api/system/state`

```json
{
  "state": "ACTIVE",
  "registrationEnabled": false,
  "origin": "https://auth.example.com"
}
```

`origin` is the canonical auth server URL (from Worker `ORIGIN` var). Admin UI uses this for integration docs.

---

## 2) L1 API: `GET /api/verify`

Gateway forward-auth. Requires valid session **and** L1 grant (`user_l1_access.enabled`).

### 2.1 Success (`200`)

```http
GET /api/verify HTTP/1.1
Host: auth.example.com
Cookie: sid=...
X-Forwarded-Proto: https
X-Forwarded-Host: app.example.com
X-Forwarded-Uri: /home
```

Response headers:

```http
HTTP/1.1 200 OK
X-Auth-User-Id: 4cf0ab13-c09b-44f8-aaa0-cb8a67c788be
X-Auth-User-Email: admin@system.internal
X-Auth-User-Name: Kenny
X-Auth-User-Role: admin
Cache-Control: private, no-store, must-revalidate
```

Body: empty (`null`).

### 2.2 Not logged in or no L1 grant (`302`)

```http
HTTP/1.1 302 Found
Location: https://auth.example.com/login?return_to=...
```

---

## 3) OAuth Authorization: `GET /api/l2/authorize`

Any **active** pauth user may authorize. No per-app user grant is required.

### 3.1 Request

```http
GET /api/l2/authorize?client_id=sumusic&redirect_uri=https%3A%2F%2Fapp.example.com%2Fauth%2Fcallback&response_type=code&scope=openid%20profile&state=st_8d2f4b HTTP/1.1
Host: auth.example.com
Cookie: sid=...
```

### 3.2 Success (`302` with code)

```http
HTTP/1.1 302 Found
Location: https://app.example.com/auth/callback?code=ac_a1b2c3d4...&state=st_8d2f4b
```

### 3.3 Not logged in (`302` to login)

```http
HTTP/1.1 302 Found
Location: https://auth.example.com/login?return_to=https%3A%2F%2Fauth.example.com%2Fapi%2Fl2%2Fauthorize%3F...
```

### 3.4 Invalid client (`400`)

```json
{
  "error": "invalid_client",
  "message": "Unknown or disabled client_id"
}
```

### 3.5 Invalid redirect URI (`400`)

Any HTTPS URL is allowed; localhost HTTP allowed for dev. Non-HTTPS external URLs are rejected.

```json
{
  "error": "invalid_redirect_uri",
  "message": "redirect_uri must be a valid HTTPS URL"
}
```

### 3.6 Missing state (`400`)

```json
{
  "error": "invalid_request",
  "message": "state is required"
}
```

### 3.7 User inactive or disabled (`302`)

```http
HTTP/1.1 302 Found
Location: https://app.example.com/auth/callback?error=access_denied&error_description=user_inactive&state=st_8d2f4b
```

### 3.8 Client requires L1, user lacks L1 (`302`)

```http
HTTP/1.1 302 Found
Location: https://app.example.com/auth/callback?error=access_denied&error_description=l1_required&state=st_8d2f4b
```

---

## 4) OAuth Token: `POST /api/l2/token`

Content-Type: `application/x-www-form-urlencoded`

### 4.1 Request

```text
grant_type=authorization_code&
code=ac_a1b2c3d4...&
client_id=sumusic&
client_secret=sec_...&
redirect_uri=https%3A%2F%2Fapp.example.com%2Fauth%2Fcallback
```

### 4.2 Success (`200`)

```json
{
  "access_token": "at_30904a27db854524aaad4c9a2b71e1ae",
  "token_type": "Bearer",
  "expires_in": 600,
  "scope": "openid profile",
  "id_token": "id_5c19293dea42430987e6626f11c7a0f3",
  "user": {
    "sub": "4cf0ab13-c09b-44f8-aaa0-cb8a67c788be",
    "email": "admin@system.internal",
    "name": "Kenny"
  }
}
```

`user.sub` is the stable pauth user ID — use this as the IdP subject in your app.

### 4.3 Invalid client secret (`401`)

```json
{
  "error": "invalid_client",
  "message": "Client authentication failed"
}
```

### 4.4 Invalid / expired / reused code (`400`)

```json
{
  "error": "invalid_grant",
  "message": "Authorization code is invalid"
}
```

### 4.5 redirect_uri mismatch (`400`)

```json
{
  "error": "invalid_grant",
  "message": "redirect_uri mismatch"
}
```

### 4.6 User disabled or lost L1 after code issued (`403`)

```json
{
  "error": "access_denied",
  "message": "User no longer has required client or L1 access"
}
```

---

## 5) OAuth UserInfo: `GET /api/l2/userinfo`

```http
GET /api/l2/userinfo HTTP/1.1
Authorization: Bearer at_30904a27db854524aaad4c9a2b71e1ae
```

```json
{
  "sub": "4cf0ab13-c09b-44f8-aaa0-cb8a67c788be",
  "email": "admin@system.internal",
  "name": "Kenny"
}
```

---

## 6) Admin: Clients

All admin routes require an admin session cookie (`sid`).

### 6.1 Create client: `POST /api/admin/clients`

Request:

```json
{
  "clientId": "sumusic",
  "name": "SuMusic",
  "accessMode": "L2_ONLY",
  "enabled": true
}
```

Success (`201`):

```json
{
  "ok": true,
  "id": "uuid",
  "clientId": "sumusic",
  "clientSecret": "sec_d8a9f0e1..."
}
```

`clientSecret` is returned once on create; it is also stored for admin retrieval. No `redirectUris` field.

### 6.2 List clients: `GET /api/admin/clients`

```json
[
  {
    "id": "uuid",
    "clientId": "sumusic",
    "name": "SuMusic",
    "accessMode": "L2_ONLY",
    "redirectUris": [],
    "clientSecret": "sec_d8a9f0e1...",
    "enabled": true,
    "createdAt": "2026-07-01T12:00:00.000Z",
    "updatedAt": "2026-07-01T12:00:00.000Z"
  }
]
```

### 6.3 Update client: `PATCH /api/admin/clients/:clientId`

```json
{
  "name": "SuMusic",
  "accessMode": "L1_AND_L2",
  "enabled": true
}
```

### 6.4 Regenerate secret: `POST /api/admin/clients/:clientId/regenerate-secret`

```json
{
  "ok": true,
  "clientId": "sumusic",
  "clientSecret": "sec_new..."
}
```

### 6.5 Delete client: `DELETE /api/admin/clients/:clientId`

```json
{
  "ok": true
}
```

---

## 7) Admin: Users and permissions

### 7.1 List users: `GET /api/admin/users`

Optional query: `?status=pending|active|disabled` (omit or `all` for every user).

```json
[
  {
    "id": "4cf0ab13-c09b-44f8-aaa0-cb8a67c788be",
    "email": "admin@system.internal",
    "name": "Kenny",
    "role": "admin",
    "status": "active",
    "createdAt": "...",
    "passkeyCount": 1,
    "hasPendingInvite": false,
    "l1Enabled": true
  }
]
```

### 7.2 Update user: `PATCH /api/admin/users/:id`

Rename:

```json
{ "name": "Kenny" }
```

Disable:

```json
{ "status": "disabled" }
```

### 7.3 Set permissions: `PUT /api/admin/users/:id/permissions`

Only L1 gateway access is managed by pauth.

```json
{
  "l1Enabled": true
}
```

Response:

```json
{
  "ok": true,
  "permissions": {
    "l1Enabled": true
  }
}
```

### 7.4 Delete user: `DELETE /api/admin/users/:id`

Cannot delete yourself or the last active admin.

```json
{
  "ok": true
}
```

---

## 8) Admin: Invites (pre-provisioned users)

### 8.1 Create invite: `POST /api/admin/invites`

No email required. Name and optional L1 only. User becomes `active` after Passkey registration (no second approval).

```json
{
  "name": "Eason",
  "role": "user",
  "l1Enabled": false
}
```

Success:

```json
{
  "ok": true,
  "url": "https://auth.example.com/invite/abc123...",
  "token": "abc123...",
  "expiresAt": "2026-07-08T12:00:00.000Z",
  "userId": "uuid"
}
```

User visits `/invite/:token`, registers Passkey, status becomes `active`.

### 8.2 Invite info: `GET /api/invite/:token`

```json
{
  "name": "Eason",
  "role": "user"
}
```

---

## 9) Standard app env config

Copy from admin **应用管理 → 复制配置**:

```text
PAUTH_CLIENT_ID=sumusic
PAUTH_CLIENT_SECRET=sec_...
PAUTH_AUTHORIZE_URL=https://auth.example.com/api/l2/authorize
PAUTH_TOKEN_URL=https://auth.example.com/api/l2/token
```

---

## 10) Integrator notes

- **`state`** is required; verify it in your callback handler.
- **`redirect_uri`** must match exactly between authorize and token requests. Any HTTPS URL is accepted (no per-client registration).
- Authorization codes and access tokens expire in **600 seconds**; codes are single-use.
- After token exchange, create your **app-local session** (same pattern as Google OAuth).
- **`user.sub`** is the stable cross-app user identifier from pauth.
- All **active** pauth users may OAuth into any registered client. Use `accessMode: L1_AND_L2` only if the app also requires L1 gateway access.
- App-specific roles and feature access are managed inside each application, not in pauth.
- Passkey login happens on the auth host; apps integrate via HTTP redirects only.

---

## 11) Error code reference

| HTTP | error | Typical cause |
|------|-------|----------------|
| 400 | `invalid_request` | Missing/invalid parameters |
| 400 | `invalid_client` | Unknown client_id (authorize) |
| 400 | `invalid_redirect_uri` | Non-HTTPS redirect (except localhost) |
| 400 | `invalid_grant` | Bad/expired/reused code or redirect mismatch |
| 400 | `unsupported_grant_type` | Not `authorization_code` |
| 401 | `invalid_client` | Wrong client_secret |
| 401 | `invalid_token` | Missing/expired Bearer token |
| 403 | `access_denied` | User disabled or lost L1 between authorize and token |
