# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| `main` branch (latest release) | ✅ |
| anything else (old forks, feature branches) | ❌ |

MjengoOS is a young project — only the tip of `main` receives security fixes.

## Reporting a vulnerability

**Please do not open a public GitHub issue for anything security-sensitive.**

Instead, use **GitHub Security Advisories**: go to this repository's
**Security → Advisories → "Report a vulnerability"** tab
(`https://github.com/Roy-Wanyoike/Mjengo-OS/security/advisories/new`).
Reports sent that way reach the maintainer privately and support coordinated
disclosure. If that path is unavailable to you, the repo README lists a
private contact preference.

Please include, where possible:

- a minimal reproduction (request/response pairs, URLs, payloads)
- the affected surface (see Scope below)
- your assessment of impact and suggested severity

### Response expectations

- **Acknowledgement within 72 hours** (usually much faster).
- Triage, severity rating and a fix-or-wontfix decision communicated through
  the private advisory thread.
- Credit in the release notes if you wish (opt-in; your choice).

## Scope

In scope:

- the **web application** (`src/`, served on port 3000 — UI, session handling,
  share-link access)
- the **HTTP API** (`src/app/api/**`, incl. `/api/v1` and the AI routes)
- the **marketing website** (`mjengoos-website/`, port 3001 / `/website`)
- infrastructure files in this repo (Dockerfile, docker-compose, workflows)

Out of scope (by design — documented in the README's honesty notes):

- the **simulated payment rails** — no real money moves; the
  `PaymentProvider` seam is intentionally a `SimulatedProvider`
- AI route behavior when the app runs outside its original sandbox without
  real AI credentials
- volumetric/DoS-only findings against a single-instance SQLite deployment
  (the known single-instance rate-limit limitation is documented in
  `src/backend/lib/rate-limit.ts` and ARCHITECTURE.md)

## Demo credentials are intentional

The accounts in `README.md` (`contractor@mjengo.os` … `admin@mjengo.os`) are
**seeded demo data**, created by `prisma/seed-extras/users.ts` so the whole
role matrix is explorable immediately. They are not a credential leak; do not
report them. A real deployment creates its own users and never seeds.

## Hardening already in place

Recruiters and reviewers can verify: per-route rate limiting + login lockout
(`src/backend/lib/rate-limit.ts`), login-timing equalization and scrypt
password hashing (`src/backend/lib/auth.ts`), error redaction on public
routes, zod-validated inputs, `Idempotency-Key` dedupe on money routes,
crypto-random 96-bit share tokens, fail-closed role guards
(`src/backend/lib/guard.ts`) mirrored client-side, project-membership read
scoping for the site team (`src/backend/lib/membership-scope.ts`, issue
#174 / SEC-6), **server-side session revocation** (issue #181 / SEC-15 —
sign-out bumps the user's `tokenVersion` and the guard rejects every token
that predates the bump; see the incident-response line below), and PR-only
`main` with CI quality gates.

### Incident response: revoking a user's sessions (issue #181 / SEC-15)

Sessions are 30-day JWTs by design (the offline-first posture — field
devices may sit offline for days; a shorter maxAge would force re-auth at
exactly the wrong moment). The kill switch is the per-user token version:
every guarded request proves the token's `tokenVersion` claim against the
current `User.tokenVersion` row (`src/backend/lib/session-revocation.ts`,
fail closed on any lookup failure).

To revoke **every session for user X** (device theft, shared-machine
exposure, suspected token compromise):

```sql
UPDATE "User" SET "tokenVersion" = "tokenVersion" + 1 WHERE "email" = 'x@example.com';
```

That one row invalidates the JWT on every device the user holds — this one,
other browsers', a stolen copy — from the next request (401, sign-in
offered). Sign-out already does this per-user (next-auth's `signOut` event
bumps the row). The per-device granularity trade-off and the design
reasoning (why a counter, not a session table) are recorded in migration
`20_token_version`'s header; the future password-change and role/pin-change
surfaces must bump it too.

## Accepted risk: single-org membership posture (SEC-6, issue #174)

**Status:** accepted (2026-09-17, issue #174) · **Owner:** repo maintainer ·
**Review trigger:** see below

Issue #174 introduced the `ProjectMembership` model and membership-scoped
reads: `supervisor`, `procurement`, `qs` and `finance` sessions read only the
projects they hold a membership row on (fail closed on zero rows — the honest
empty portfolio, never everything), while `contractor`/`admin` keep an
explicit code-level portfolio-wide grant. Worker PII (`idNumber`,
`emergencyContactName`, `emergencyContactPhone`) is served only to
membership-holders of that worker's project, contractor/admin, and the
project's own client; every other reader gets nulls.

**The accepted risk:** MjengoOS today is a single-org deployment — one
contractor's business, one site team, employees known to each other. The seed
(`prisma/seed-extras/memberships.ts`) therefore plants **every site-team
persona on every project**, so the demo journeys keep working and a fresh
deploy is not accidentally locked out. That blanket grant is only honest
under the single-org assumption; it is recorded here so nobody mistakes it
for a security boundary.

**Known gaps in the same posture (recorded, deliberately out of #174's read
scope):**

- **Mutations are not membership-gated.** `POST /api/actions` and the
  `/api/sync` outbox apply items to any project for any site-team role,
  exactly as before #174 (the issue was about reads). The `/api/sync`
  payload *refresh* IS membership-scoped.
- **Grant/revoke tooling does not exist yet.** Membership rows are written by
  the seed; revoking or granting access means editing the table directly
  (unaudited). Until tooling lands, treat membership rows as
  operator-controlled data.
- Other owner surfaces not named by #174 (the notifications center default,
  the admin-only audit feed is already admin-gated) still follow their
  pre-#174 contracts for site-team roles.

**Trigger conditions for revisiting (any one of these):**

1. **Multi-tenant / multi-org onboarding** — more than one contractor
   business (or franchise) shares an instance. The blanket seed grant must
   become per-project intent, and grant/revoke tooling (audited, admin-only)
   must ship before the first external org is onboarded.
2. **External professionals get accounts** — surveyors, architects or QS
   consultants who are NOT employees of the org. Their accounts must ship
   with narrow memberships from day one, never the blanket grant.
3. **Worker PII compliance obligations arrive** (Kenya Data Protection Act
   enforcement guidance covering employee identity data): revisit the PII
   grant list and add field-level audit logging of PII reads.

Out of scope here: the share-link surface (a share token is the project
client's own bearer capability — unchanged by design).
