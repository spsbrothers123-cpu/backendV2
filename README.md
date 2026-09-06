# Egg Mart POS — Unified Backend (Phase 1)

Foundation + authentication + cashier signup (via admin-generated invitation
code) + admin approval for the Egg Mart Admin and Cashier frontends. One
backend, one PostgreSQL database, one auth system, serving both apps.

This is a **fresh backend**, scaffolded to match the exact API contracts
already coded into `Admin2_0/src/api/*` and `Cashier2_0/src/api/*` (both of
which currently run against mock data / `USE_MOCK=true`). Point their
`VITE_API_BASE_URL` at this server and flip `VITE_USE_MOCK=false` to go live.

## Stack

Node.js · TypeScript · Fastify 5 · PostgreSQL · Prisma · Zod · Vitest ·
bcryptjs · jsonwebtoken · Resend (optional, for approval/rejection emails only)

## Getting started

```bash
npm install
cp .env.example .env        # then edit DATABASE_URL, JWT_SECRET, etc.

npx prisma migrate dev --name init   # creates tables
npm run prisma:seed                  # creates one Shop + one ACTIVE admin

npm run dev                          # http://localhost:5000
```

> **Note on this delivery:** `npm install` and the unit tests were run and
> verified in the sandbox this was built in. `npx prisma generate` / `prisma
> migrate dev` could **not** be run here because that sandbox's network
> doesn't reach `binaries.prisma.sh` (Prisma's engine-download host) — that's
> an environment restriction, not a code issue. A hand-authored migration
> (`prisma/migrations/20260831000000_invitation_code_signup/migration.sql`)
> is included; **before applying it to a real database**, run this once on a
> machine with normal internet access to confirm it matches what Prisma
> itself would generate, then let Prisma record it normally:
>
> ```bash
> npx prisma migrate diff \
>   --from-migrations prisma/migrations \
>   --to-schema-datamodel prisma/schema.prisma \
>   --script
> # diff against the hand-authored migration.sql above; then:
> npx prisma migrate dev
> npx prisma generate
> npx tsc --noEmit
> ```
>
> The integration test suite (`test/auth.integration.test.ts`) needs a real
> Postgres database for the same reason and is excluded from the default
> `npm test` run — see the comment at the top of that file to run it.

Default seeded admin (change immediately in any non-local environment):
`admin@eggmart.test` / `Admin@12345`.

## Project layout

```
prisma/schema.prisma       Shop, User, InvitationCode, Session, AuditLog
prisma/seed.ts             creates the default Shop + admin
src/config/env.ts          env var validation (zod)
src/lib/                   password, invitationCode, invitationToken, jwt, email, audit, serializers...
src/plugins/auth.ts        JWT + session verification, request.authUser
src/routes/auth.ts         signup (invitation-code gated), cashier + admin login, me, logout
src/routes/admin/          invitation codes, cashier-requests review, cashier management
src/routes/health.ts       GET /health
src/app.ts                 Fastify app factory, CORS, rate limiting, error handler
src/server.ts              entrypoint
test/                      vitest unit + integration tests
```

## Cashier signup: invitation code, not email OTP

The old cashier-signup flow (email a one-time code, verify it, then wait for
admin approval) has been fully removed and replaced end-to-end:

```
ADMIN                                   CASHIER
POST /admin/invitation-codes      →     (admin shares the 6-digit code out of band)
  → generates + returns plaintext       POST /auth/signup/verify-invitation {code}
    code once; only ever stored           → verificationToken (short-lived, signed)
    hashed after that                   POST /auth/signup {..., verificationToken}
                                           → 201 { requestId, email }
GET  /admin/cashier-requests               PENDING_ADMIN_APPROVAL
POST /admin/cashier-requests/:id/approve
  → ACTIVE                             POST /auth/login → works now
```

- A shop only ever has one **ACTIVE** invitation code; generating a new one
  revokes the previous one.
- A code is single-use: the registration transaction atomically claims it
  (`UPDATE ... WHERE status = 'ACTIVE'`), so two simultaneous signups racing
  on the same code can never both succeed.
- Admin approval is a completely independent second gate — a valid
  invitation code only authorizes *submitting* a signup request.
- The plaintext code is never stored outside a narrow window: it's kept only
  while the code is `ACTIVE` (so the Admin UI can redisplay it after a page
  refresh) and is wiped the instant it's used, revoked, or found expired.
  Every other endpoint only ever sees the SHA-256 hash.
- The invitation's `shopId` is the only source of truth for which shop a new
  cashier joins — the frontend never sends (and the backend never trusts) a
  `shopId` in the signup request.

## Design notes / where this project deviates from the master prompt

The invitation-code spec repeatedly suggests routes like
`POST /auth/invitation-code/validate` and a generic
`{success, data, message}` envelope everywhere. Both frontends' own
`src/api/*` files were already built and shipped against a specific,
slightly different contract, so that contract wins wherever the two
disagree:

- **Auth endpoints return flat bodies** (`{ token, cashier }`,
  `{ requestId, email }`, `{ verificationToken, expiresInSeconds }`, etc.)
  because that's exactly what the frontend code destructures (e.g.
  `Cashier2_0/src/api/auth.js`'s `verifyInvitationCode()` / `signup()`).
- **Admin invitation-code and cashier-request/management endpoints** use the
  `{success, data, message}` envelope, matching `Admin2_0/src/api/invitations.ts`.
- **`role` is serialized lowercase** (`"admin"` / `"cashier"`) to match
  `Admin2_0/src/types/index.ts` (`AdminRole = "admin" | "cashier"`) even
  though the Prisma enum is `ADMIN` / `CASHIER`.
- **`requestId`** returned by `/auth/signup` is the created cashier `User`'s
  own id — there's no separate "signup request" model; the user row's
  `status` column *is* the request's status. This also means it can never be
  guessed/forged into approving an arbitrary account, since `/auth/signup`
  is the only thing that can create a `PENDING_ADMIN_APPROVAL` cashier row.
- **`username` / `invitationCodeMasked`** on the Admin cashier-requests list
  (`Admin2_0/src/types/index.ts`'s `CashierRequest`) don't correspond to real
  signup fields (`Cashier2_0` only collects name/email/password) — `username`
  is derived from the email's local part, and `invitationCodeMasked` (e.g.
  `"••••31"`) is captured from the invitation code at the moment of use,
  before its plaintext is discarded.

## Endpoints

All routes are mounted under `/api` except `/health`.

### Auth — shared

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/auth/me` | Bearer token | Returns admin or cashier shape depending on role |
| POST | `/auth/logout` | Bearer token | Revokes the current session (JWT stops working immediately) |

### Auth — cashier signup (invitation code, no OTP)

| Method | Path | Auth | Request | Response |
|---|---|---|---|---|
| POST | `/auth/signup/verify-invitation` | none | `{ code }` | `{ verificationToken, expiresInSeconds }` |
| POST | `/auth/signup` | none | `{ name, email, password, verificationToken }` | `201 { requestId, email }` |
| GET | `/auth/signup/status?requestId=` | none | — | `{ status, name, email }` |
| POST | `/auth/login` | none | `{ email, password }` | `{ token, cashier }` |

Verify-invitation failure codes: `INVALID_INVITATION_CODE` / `INVITATION_CODE_EXPIRED`
/ `INVITATION_CODE_REVOKED` (400), `INVITATION_CODE_USED` (409).

Signup failure codes: `INVITATION_VERIFICATION_INVALID` /
`INVITATION_VERIFICATION_EXPIRED` (401), `ACCOUNT_ALREADY_EXISTS` /
`REQUEST_ALREADY_PENDING` / `INVITATION_ALREADY_USED` (409).

Login failure codes: `INVALID_CREDENTIALS` (401), `ACCOUNT_PENDING_APPROVAL`
/ `ACCOUNT_REJECTED` / `ACCOUNT_SUSPENDED` (403).

### Auth — admin

| Method | Path | Auth | Request | Response |
|---|---|---|---|---|
| POST | `/auth/admin/login` | none | `{ email, password }` | `{ token, user }` |

### Admin — invitation codes

All require `Authorization: Bearer <admin token>`; scoped to the admin's own shop.

| Method | Path | Notes |
|---|---|---|
| POST | `/admin/invitation-codes` | Generates a new code, revoking any existing ACTIVE one. Plaintext `code` is only ever in *this* response. |
| GET | `/admin/invitation-codes/active` | Current ACTIVE code (or `data: null`) — re-displays the plaintext code while it's still live. |
| POST | `/admin/invitation-codes/:id/revoke` | Immediately invalidates an ACTIVE code. |

### Admin — cashier requests (review queue)

All require `Authorization: Bearer <admin token>`; scoped to the admin's own shop.

| Method | Path | Notes |
|---|---|---|
| GET | `/admin/cashier-requests?status=` | Defaults to pending+rejected; `status=ALL` for everything |
| GET | `/admin/cashier-requests/:id` | Safe fields only — never password/invitation code hash |
| POST | `/admin/cashier-requests/:id/approve` | Requires `PENDING_ADMIN_APPROVAL`; sends approval email |
| POST | `/admin/cashier-requests/:id/reject` | Body: `{ reason? }`; sends rejection email |

### Admin — cashier management

| Method | Path | Notes |
|---|---|---|
| GET | `/admin/cashiers` | Active cashiers on the admin's shop |
| GET | `/admin/cashiers/:id` | |
| PATCH | `/admin/cashiers/:id` | Body: `{ name?, phone? }` |
| PATCH | `/admin/cashiers/:id/status` | Body: `{ status: "ACTIVE" \| "SUSPENDED" }` — suspending revokes all live sessions |

### Health

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | Checks DB connectivity too |

## Error shape

```json
{ "success": false, "message": "Human-readable message.", "code": "MACHINE_CODE" }
```

Both frontends' `apiClient` interceptors read `error.response.data.message`
and `.code` directly, so this shape works for both without changes.

## Security notes

- Passwords: bcrypt, 12 rounds. Invitation codes: SHA-256 (fast, short-lived,
  unlike passwords), compared with a timing-safe equality check — generated
  with `crypto.randomInt`, never `Math.random()` or a timestamp.
- Invitation codes: 6 digits, 30-minute expiry (`INVITATION_CODE_EXPIRY_MINUTES`),
  single-use, one ACTIVE code per shop — all enforced server-side. The
  post-validation verification token is separately short-lived
  (`INVITATION_TOKEN_EXPIRY_MINUTES`, default 15) and signed with the
  backend's JWT secret — the invitation code itself is never used as a
  token or secret.
- `role`, `shopId`, and any user id are **never** trusted from the request
  body — every protected route resolves identity from the verified JWT +
  a live database lookup (so a suspended user's still-unexpired token stops
  working immediately, not just at expiry). Likewise, the shop a cashier
  signs up into is always derived from the validated invitation, never from
  a frontend-supplied `shopId`.
- Admins only ever see/approve/manage cashiers and invitation codes on their
  own `shopId`.
- Rate limiting: global 100 req/min, tighter limits on signup/login/invitation
  endpoints specifically.
- CORS origins come from `CORS_ORIGINS` env var — never `*`.
- Nothing in the audit log or logs ever contains a password, full invitation
  code, or token — only masked/hashed forms where a reference is needed at
  all.
- Cashier signup has **no dependency on Resend** or a verified email domain;
  `RESEND_API_KEY` being unset never blocks startup or signup (approval/
  rejection notification emails, which do use Resend, silently log to
  console instead when it's unset).

## What's intentionally out of scope for Phase 1

Products, billing, inventory, reports, credits, expenses — everything
outside auth + cashier onboarding is Phase 2, per the master prompt.
