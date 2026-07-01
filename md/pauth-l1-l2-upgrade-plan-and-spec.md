# pauth L1/L2 Upgrade Plan and Specification (Draft v1)

This document defines the upgrade plan and baseline specifications for supporting:

- L1-only usage (gateway/browser pass-through)
- L2-only usage (application identity only)
- L1+L2 combined usage
- Independent L1 and L2 grants per user

---

## 1) Target Architecture

### 1.1 Layer definitions

- L1: gateway access gate for browser traffic
- L2: application-level identity and authorization for registered clients

### 1.2 Independence model

- L1 and L2 are independent grants
- A user may have:
  - L2 grant for SuMusic but no L1 grant
  - L1 grant only
  - both grants
  - neither grant

### 1.3 Effective decision rule

For a request to client `C`:

```text
ALLOW =
  authenticated
  AND client_enabled
  AND l2_granted(user, C)
  AND (
    C.access_mode != L1_AND_L2
    OR l1_granted(user)
  )
```

---

## 2) Data Model Specification

## 2.1 New tables

1) `clients`

- `client_id` (PK)
- `name`
- `access_mode` (`L2_ONLY` | `L1_AND_L2`)
- `enabled` (boolean)
- `created_at`, `updated_at`

2) `client_redirect_uris`

- `id` (PK)
- `client_id` (FK -> clients.client_id)
- `redirect_uri`
- unique (`client_id`, `redirect_uri`)

3) `user_l1_access`

- `user_id` (PK/FK -> users.id)
- `enabled` (boolean)
- `updated_at`

4) `user_client_access`

- `user_id` (FK -> users.id)
- `client_id` (FK -> clients.client_id)
- `enabled` (boolean)
- `app_role` (nullable text)
- `updated_at`
- unique (`user_id`, `client_id`)

5) `auth_codes`

- `code` (PK)
- `user_id`
- `client_id`
- `redirect_uri`
- `scope`
- `nonce`
- `expires_at`
- `used_at` (nullable)
- `created_at`

6) `access_tokens` (if opaque token mode)

- `token_hash` (PK)
- `user_id`
- `client_id`
- `scope`
- `expires_at`
- `revoked_at` (nullable)
- `created_at`

### 2.2 Existing table reuse

- Keep current `users`, `passkeys`, `sessions`, `audit_logs`.
- Do not overload `users.status` to represent L1/L2 grants.

---

## 3) API Specification Scope

### 3.1 L1 APIs

- `GET /api/verify` (gateway use)

### 3.2 L2 APIs

- `GET /api/l2/authorize`
- `POST /api/l2/token`
- `GET /api/l2/userinfo` (optional but recommended)

### 3.3 Admin APIs

- Client management
- User L1 grant management
- User L2 client grant management
- Audit query filters by layer/client/user/decision

---

## 4) Security Requirements

1. Exact redirect URI matching
2. Mandatory `state` in authorize flow
3. Recommended `nonce` support
4. Authorization code TTL <= 60s
5. Single-use code enforcement
6. Client secret required for token exchange (for confidential clients)
7. Opaque token storage as hash (not plain token)
8. Structured audit logging for all grant/deny/security events

Cookie requirements:

- `HttpOnly`
- `Secure` (production)
- `SameSite=Lax`
- `Domain=.example.com` (or equivalent parent domain)

---

## 5) Audit and Observability Spec

Each critical event should include:

- `event_type`
- `layer` (`L1` or `L2`)
- `user_id`
- `client_id` (for L2)
- `decision` (`allow` or `deny`)
- `reason_code`
- `request_id`
- `created_at`

Recommended event types:

- `L1_VERIFY_ALLOW`
- `L1_VERIFY_DENY`
- `L2_AUTHORIZE_ALLOW`
- `L2_AUTHORIZE_DENY`
- `L2_TOKEN_ISSUED`
- `L2_TOKEN_DENY`
- `ADMIN_CLIENT_CREATE`
- `ADMIN_GRANT_UPDATE`

---

## 6) Rollout Plan

### Phase 1: Schema and internal model

- Add new tables and indexes
- Add migration scripts and rollback notes

### Phase 2: L1 compatibility-preserving upgrade

- Keep `/api/verify` behavior
- Switch L1 decision to `user_l1_access.enabled`

### Phase 3: L2 protocol implementation

- Implement `/api/l2/authorize`, `/api/l2/token`
- Add optional `/api/l2/userinfo`

### Phase 4: Admin management

- Add client CRUD
- Add L1 and L2 grant APIs
- Add audit filters

### Phase 5: SuMusic integration

- SuMusic login redirects to `/api/l2/authorize`
- SuMusic backend exchanges `code` at `/api/l2/token`
- SuMusic creates local app session after token success

### Phase 6: Generalized client onboarding

- Add S2/S3 client registrations
- Reuse same L2 flow with client-specific grants

---

## 7) Backward Compatibility

- L1 gateways continue using `/api/verify`.
- Existing passkey login/session behavior remains valid.
- L2 is additive and does not break L1-only deployments.

---

## 8) Acceptance Checklist

- [ ] L1-only client works without L2 flows
- [ ] L2-only client works with no L1 grant
- [ ] L1+L2 client blocks users lacking L1 grant
- [ ] User with only SuMusic L2 grant can log in to SuMusic but not S2/S3
- [ ] Revoking grant immediately blocks next authorize/token exchange
- [ ] All deny decisions are visible in audit logs

---

## 9) Out of Scope (v1)

- Full OIDC discovery/JWKS metadata
- Social login providers
- Fine-grained consent UI and scopes beyond `openid profile`

