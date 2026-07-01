# pauth L1/L2 API JSON Examples (Draft v1)

This document provides a complete request/response JSON example set for the L1 + L2 model:

- L1: gateway/browser access check
- L2: application identity and authorization for clients (S1/S2/S3, e.g. SuMusic)

Base URL:

```text
https://auth.example.com
```

---

## 1) L1 API: `GET /api/verify`

Purpose:

- For Caddy/Nginx forward auth
- Checks whether user can pass L1 gate

### 1.1 Success (`200`)

Request (gateway subrequest):

```http
GET /api/verify HTTP/1.1
Host: auth.example.com
Cookie: sid=sid_abc.sig_xyz
X-Forwarded-Proto: https
X-Forwarded-Host: app.example.com
X-Forwarded-Uri: /app/home
```

Response:

```http
HTTP/1.1 200 OK
X-Auth-User-Id: usr_01JABCDEF
X-Auth-User-Email: user@example.com
X-Auth-User-Name: Kenny
Cache-Control: private, no-store, must-revalidate
```

Response body:

```json
null
```

### 1.2 Not logged in (`302`)

Response:

```http
HTTP/1.1 302 Found
Location: https://auth.example.com/login?return_to=https%3A%2F%2Fapp.example.com%2Fapp%2Fhome
```

### 1.3 Logged in but no L1 grant (`302`)

Response:

```http
HTTP/1.1 302 Found
Location: https://auth.example.com/login?return_to=https%3A%2F%2Fapp.example.com%2Fapp%2Fhome
```

Notes:

- For L1 gateway compatibility, failed checks use redirect instead of JSON errors.

---

## 2) L2 Authorization API: `GET /api/l2/authorize`

Purpose:

- App redirects user here to start/complete L2 login
- On success, returns one-time code to app callback

### 2.1 Request example

```http
GET /api/l2/authorize?client_id=sumusic&redirect_uri=https%3A%2F%2Fapp.example.com%2Fauth%2Fcallback&response_type=code&scope=openid%20profile&state=st_8d2f4b&nonce=n_01xy HTTP/1.1
Host: auth.example.com
Cookie: sid=sid_abc.sig_xyz
```

### 2.2 Success (`302` with code)

```http
HTTP/1.1 302 Found
Location: https://app.example.com/auth/callback?code=ac_01JCODEABC&state=st_8d2f4b
```

### 2.3 Not logged in (`302` to login)

```http
HTTP/1.1 302 Found
Location: https://auth.example.com/login?return_to=https%3A%2F%2Fauth.example.com%2Fapi%2Fl2%2Fauthorize%3Fclient_id%3Dsumusic%26redirect_uri%3Dhttps%253A%252F%252Fapp.example.com%252Fauth%252Fcallback%26response_type%3Dcode%26scope%3Dopenid%2520profile%26state%3Dst_8d2f4b%26nonce%3Dn_01xy
```

### 2.4 Invalid client (`400`)

```json
{
  "error": "invalid_client",
  "message": "Unknown or disabled client_id"
}
```

### 2.5 Invalid redirect URI (`400`)

```json
{
  "error": "invalid_redirect_uri",
  "message": "redirect_uri is not allowed for this client"
}
```

### 2.6 Missing/invalid state (`400`)

```json
{
  "error": "invalid_request",
  "message": "state is required"
}
```

### 2.7 Logged in but no client grant (`302`)

```http
HTTP/1.1 302 Found
Location: https://app.example.com/auth/callback?error=access_denied&error_description=user_not_granted_for_client&state=st_8d2f4b
```

### 2.8 Client mode is `L1_AND_L2`, user has no L1 (`302`)

```http
HTTP/1.1 302 Found
Location: https://app.example.com/auth/callback?error=access_denied&error_description=l1_required&state=st_8d2f4b
```

---

## 3) L2 Token API: `POST /api/l2/token`

Purpose:

- Application backend exchanges one-time code for user identity token payload

Content-Type:

```text
application/x-www-form-urlencoded
```

### 3.1 Request example

```text
grant_type=authorization_code&
code=ac_01JCODEABC&
client_id=sumusic&
client_secret=sec_01JSECRET&
redirect_uri=https%3A%2F%2Fapp.example.com%2Fauth%2Fcallback
```

### 3.2 Success (`200`)

```json
{
  "access_token": "at_01JATOKEN",
  "token_type": "Bearer",
  "expires_in": 600,
  "scope": "openid profile",
  "id_token": "id_opaque_or_jwt",
  "user": {
    "sub": "usr_01JABCDEF",
    "email": "user@example.com",
    "name": "Kenny"
  }
}
```

### 3.3 Unsupported grant (`400`)

```json
{
  "error": "unsupported_grant_type",
  "message": "Only authorization_code is supported"
}
```

### 3.4 Invalid client secret (`401`)

```json
{
  "error": "invalid_client",
  "message": "Client authentication failed"
}
```

### 3.5 Invalid or unknown code (`400`)

```json
{
  "error": "invalid_grant",
  "message": "Authorization code is invalid"
}
```

### 3.6 Expired code (`400`)

```json
{
  "error": "invalid_grant",
  "message": "Authorization code has expired"
}
```

### 3.7 Reused code (`400`)

```json
{
  "error": "invalid_grant",
  "message": "Authorization code has already been used"
}
```

### 3.8 redirect URI mismatch (`400`)

```json
{
  "error": "invalid_grant",
  "message": "redirect_uri mismatch"
}
```

### 3.9 User access revoked after code issued (`403`)

```json
{
  "error": "access_denied",
  "message": "User no longer has required client or L1 access"
}
```

---

## 4) L2 UserInfo API (optional): `GET /api/l2/userinfo`

Purpose:

- App reads user profile from access token

### 4.1 Success (`200`)

Request:

```http
GET /api/l2/userinfo HTTP/1.1
Host: auth.example.com
Authorization: Bearer at_01JATOKEN
```

Response:

```json
{
  "sub": "usr_01JABCDEF",
  "email": "user@example.com",
  "name": "Kenny"
}
```

### 4.2 Missing token (`401`)

```json
{
  "error": "invalid_token",
  "message": "Bearer token is required"
}
```

### 4.3 Expired/revoked token (`401`)

```json
{
  "error": "invalid_token",
  "message": "Token is expired or revoked"
}
```

---

## 5) Admin APIs: Client and Grants

All admin APIs require:

- Logged in admin user
- `Content-Type: application/json` where body exists

### 5.1 Create client: `POST /api/admin/clients`

Request:

```json
{
  "clientId": "sumusic",
  "name": "SuMusic",
  "accessMode": "L2_ONLY",
  "redirectUris": [
    "https://app.example.com/auth/callback",
    "https://app1.example.com/auth/callback",
    "https://app2.example.com/auth/callback"
  ],
  "enabled": true
}
```

Success (`201`):

```json
{
  "ok": true,
  "client": {
    "clientId": "sumusic",
    "name": "SuMusic",
    "accessMode": "L2_ONLY",
    "enabled": true,
    "redirectUris": [
      "https://app.example.com/auth/callback",
      "https://app1.example.com/auth/callback",
      "https://app2.example.com/auth/callback"
    ]
  }
}
```

Failure (`409`, already exists):

```json
{
  "error": "conflict",
  "message": "clientId already exists"
}
```

Failure (`400`, bad redirect URI):

```json
{
  "error": "invalid_request",
  "message": "redirectUris must be absolute HTTPS URLs"
}
```

### 5.2 Update client: `PATCH /api/admin/clients/:clientId`

Request:

```json
{
  "accessMode": "L1_AND_L2",
  "enabled": true
}
```

Success (`200`):

```json
{
  "ok": true
}
```

Failure (`404`):

```json
{
  "error": "not_found",
  "message": "Client not found"
}
```

### 5.3 List clients: `GET /api/admin/clients`

Success (`200`):

```json
[
  {
    "clientId": "sumusic",
    "name": "SuMusic",
    "accessMode": "L1_AND_L2",
    "enabled": true,
    "redirectUris": [
      "https://app.example.com/auth/callback",
      "https://app1.example.com/auth/callback",
      "https://app2.example.com/auth/callback"
    ]
  }
]
```

### 5.4 Set user L1 grant: `PUT /api/admin/users/:userId/l1-access`

Request:

```json
{
  "enabled": false
}
```

Success (`200`):

```json
{
  "ok": true,
  "userId": "usr_01JABCDEF",
  "l1Access": {
    "enabled": false
  }
}
```

Failure (`404`):

```json
{
  "error": "not_found",
  "message": "User not found"
}
```

### 5.5 Set user client grant: `PUT /api/admin/users/:userId/client-access/:clientId`

Request:

```json
{
  "enabled": true,
  "appRole": "member"
}
```

Success (`200`):

```json
{
  "ok": true,
  "userId": "usr_01JABCDEF",
  "clientId": "sumusic",
  "grant": {
    "enabled": true,
    "appRole": "member"
  }
}
```

Failure (`404`, user/client):

```json
{
  "error": "not_found",
  "message": "User or client not found"
}
```

### 5.6 List user grants: `GET /api/admin/users/:userId/client-access`

Success (`200`):

```json
{
  "userId": "usr_01JABCDEF",
  "grants": [
    {
      "clientId": "sumusic",
      "enabled": true,
      "appRole": "member"
    },
    {
      "clientId": "s2",
      "enabled": false,
      "appRole": null
    }
  ]
}
```

### 5.7 Revoke user grant: `DELETE /api/admin/users/:userId/client-access/:clientId`

Success (`200`):

```json
{
  "ok": true
}
```

---

## 6) HTTP Status and Error Code Reference

Common status codes:

- `200` success
- `201` created
- `302` browser redirect (L1/L2 interactive flow)
- `400` invalid request / invalid grant
- `401` authentication failed (`invalid_client`, `invalid_token`)
- `403` authenticated but not authorized (`access_denied`)
- `404` not found
- `409` conflict

Common error codes:

- `invalid_request`
- `invalid_client`
- `invalid_redirect_uri`
- `unsupported_grant_type`
- `invalid_grant`
- `invalid_token`
- `access_denied`
- `not_found`
- `conflict`

---

## 7) Notes for Integrators

- `state` is required for L2 authorize and must be verified by client backend.
- `redirect_uri` must be exact-match with registered URI.
- Authorization code should be single-use and short-lived (recommended 60 seconds).
- Application should create its own local session after successful token exchange.
- L1 and L2 can be used independently, or together (`L1_AND_L2` mode).
