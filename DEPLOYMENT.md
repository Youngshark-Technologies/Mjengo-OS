# MjengoOS — Deployment & Operations Guide

Everything a new engineer needs to build, run, verify and deploy MjengoOS.
For the product itself see `README.md`; for module boundaries see
`ARCHITECTURE.md`.

## 1. Architecture (one paragraph)

MjengoOS is a **single Node process**: a Next.js 16 (App Router, Turbopack,
TypeScript strict) application whose UI is one client-rendered page
(`src/app/page.tsx` — login gate, owner app, client "Virtual Site Visit" and
share-link views) talking to guarded API routes under `src/app/api/**`
(NextAuth v4 credentials + JWT session cookies, role guards, rate limits,
idempotency). Persistence is **Prisma 6 + SQLite** (single file at
`DATABASE_URL`) with a 68-model schema, a double-entry ledger and
`_prisma_migrations` bookkeeping. File uploads (site photos, documents) are
written to `public/photos/` and `public/docs/` on local disk. `next build`
emits a **standalone** server (`output: "standalone"` → `.next/standalone/
server.js`) that runs with `node` (or `bun`), so a self-host deployment is
one process + one SQLite file + one uploads directory — no message queue, no
external services. Background jobs run in-process (`POST /api/jobs/run` is
the cron hook — drained on a schedule by a token-authenticated scheduler:
compose sidecar / systemd timer / any cron, §7.3); the AI routes call
z-ai-web-dev-sdk from the backend only.

## 2. Prerequisites

| Tool | Version | Used for |
|---|---|---|
| [Bun](https://bun.sh) | ≥ 1.1 | package manager (`bun.lock`), running seeds (TS), dev server |
| Node | 20+ | production runtime (standalone server), Prisma CLI |
| Git | any | source |
| Docker (+ compose) | 24+ | optional but recommended self-host path |
| openssl | any | generating `NEXTAUTH_SECRET` |

## 3. Environment variables

Copy `.env.example` → `.env` (gitignored — **never commit real secrets**).

| Variable | Required | Value / semantics |
|---|---|---|
| `DATABASE_URL` | yes | SQLite file URL. Absolute path recommended in production (`file:/app/db/custom.db` in Docker). Relative paths resolve against the Prisma schema's directory. |
| `NEXTAUTH_SECRET` | yes | Secret for JWT session-cookie encryption — generate with `openssl rand -hex 32` (or `openssl rand -base64 32`), any value ≥ 32 chars. **Rotating it signs every user out.** In production (`NODE_ENV=production`) a missing or short (< 32 chars) secret is a **boot error** on the auth routes (`src/backend/lib/next-auth-guard.ts` fails closed, like `JOBS_RUN_TOKEN`); dev logs a one-time warning and keeps working. |
| `NEXTAUTH_URL` | situational | Public base URL. **Leave UNSET when the app is reached through a reverse proxy / any host-varying gateway** — with `AUTH_TRUST_HOST=1` next-auth v4 derives the origin per request from `x-forwarded-host`/`-proto`, so redirects, callback URLs and cookie origins always match the host the user actually browses. Set it ONLY for a fixed public domain (`https://your-domain.example`). Pinning it to localhost behind a proxy breaks sign-in (PR #7). |
| `AUTH_TRUST_HOST` | behind proxy: yes (`1`) | Makes next-auth v4's `detectOrigin` honor the proxy's forwarded host/proto headers instead of silently pinning every origin to `NEXTAUTH_URL` (or `http://localhost:3000`). Harmless for direct localhost access — keep it set whenever a proxy is involved. |
| `WEBSITE_ORIGIN` | with the marketing site | Rewrite target for `/website/*` — the origin of the `mjengoos-website/` Next.js app. Default `http://127.0.0.1:3001` (the site's own server in local dev); under docker-compose set `http://website:3001` (service DNS — `docker-compose.yml` does this for you). |
| `TRUST_PROXY` | hardening: `1` behind a trusted proxy | When set, the app reads the client IP from the **rightmost** `X-Forwarded-For` value (the one appended by your trusted proxy) for rate-limit keys, the login lockout and the Daraja IP allowlist. **Unset (default) the header is ignored entirely** (issue #156): every unauthenticated caller shares the one `anon` rate-limit bucket, and `DARAJA_ALLOWED_IPS` (if set) denies all traffic because the source IP is unresolvable — a client-forgeable header must never key a throttle or an allowlist. |
| `WEBHOOK_OPEN_POSTURE` | demo/dev only | Explicit opt-in for the **open** demo/gateway-trust posture on the unauthenticated field-line webhooks (`POST /api/ussd`, `POST /api/whatsapp`) when their HMAC secret is unset — non-production runtimes only. See the posture matrix below (issue #156). |
| `RATE_LIMIT_STORE` | multi-process: default `sqlite` | `sqlite` (default since issue #158) — one shared SQLite file per **host** so every process sees the same token buckets and login lockout (issue #33; needs `node` as the standalone runtime and one Docker COPY line, see §9.4). Any init failure (unwritable path, read-only FS, missing module, Bun runtime) logs one warning and stays in-memory — boot never fails. `memory` opts out to the historical in-process counters, exact for one process. |
| `RATE_LIMIT_SQLITE_PATH` | store path (default applies) | Path of the shared store file (default `db/ratelimit.db`, `file:` prefix tolerated). Keep it on the same persistent volume as `DATABASE_URL` — never point it at the Prisma database; it is disposable cache-like state. |
| `MUTATION_ORIGIN_ALLOWLIST` | hardening: optional | When set (comma-separated origin list), JSON mutation requests are rejected unless their `Origin` header matches — CSRF defense-in-depth on top of cookies. |
| `USSD_WEBHOOK_SECRET` | hardening: optional | When set, `/api/ussd` requires a valid HMAC signature derived from this shared secret on every request (authenticated gateway webhooks). Unset → fail-closed 503 unless `WEBHOOK_OPEN_POSTURE=1` opts into the demo posture outside production — see the matrix below (issue #156). |
| `WHATSAPP_WEBHOOK_SECRET` | hardening: optional | Same posture for the WhatsApp field line: when set, `POST /api/whatsapp` (contract documented at `GET /api/whatsapp`) must carry `X-Signature: <hex HMAC-SHA256 of the raw body>` — shared-secret auth for the relay (Meta Cloud API bridge or aggregator) that would POST `{ from, text, timestamp }`. Unset → fail-closed 503 unless `WEBHOOK_OPEN_POSTURE=1` (non-production) opts into the open demo posture (requests are still rate-limited 20/min/phone + 40/min/IP; every reply is footered "MjengoOS sim" — no WhatsApp provider is wired). |
| `JOBS_RUN_TOKEN` | scheduler: optional | Shared secret (`openssl rand -hex 32`) that lets an external scheduler authenticate `POST /api/jobs/run` with `Authorization: Bearer <token>` (no browser session needed — compose `jobs-tick` sidecar, systemd timer, any cron). Same value must reach the app and the scheduler. **Unset = the bearer path is fully disabled** (fail closed — the endpoint then answers only to contractor/admin sessions, exactly as before). See §7.3. |
| `JOBS_HANDLER_TIMEOUT_MS` | jobs: optional | Per-handler timeout for ONE background-job invocation during a `POST /api/jobs/run` drain — default `30000` (30 s: generous for the TTS/AI handlers, far below the route's own duration budget, so one hung handler fails its own `JobRecord` row instead of stalling the whole drain). Read at drain time, not import time — a change applies to the next drain without a restart. Invalid, zero or unset values fall back to the default (never 0 — a zero cap would fail every handler instantly). A handler that exceeds the cap is marked `failed` **terminally** (no retry — it already hung a full window and would re-hang; re-enqueue after investigating). |
| `HEALTH_DETAIL_TOKEN` | health detail: optional | Shared secret (`openssl rand -hex 32`) that unlocks the GATED diagnostics on `GET /api/health` (issue #164 / audit API-13) for ops dashboards and curl: send `X-Health-Detail: <token>` and the full pre-split body (job-queue counts, entity counts, package version, uptime, DB latency — plus the error text when the DB is down) comes back; the public body stays the probe minimum `{"ok":true,"db":"up","timestamp":…}` that compose healthchecks and the CI smoke test assert on. Constant-time compare, same discipline as `JOBS_RUN_TOKEN`. **Unset = the header path is fully disabled** (fail closed). The in-app admin SystemHealthCard needs no token — an admin session is its own gate. See §7.2. |
| `HEALTH_PUBLIC_DETAIL` | health detail: demo opt-in | Set to `1` (or `true`) to serve the FULL `/api/health` detail body to every unauthenticated caller — the explicit demo/trusted-intranet posture (issue #164). Deliberate opt-in only: anything else (unset, `0`, `yes`, `on`…) keeps the minimal public shape. Never set on an internet-fronted deployment — the counts/version are exactly what API-13 said not to hand to strangers. |
| `RECONCILIATION_CHECK_INTERVAL_MIN` | jobs: optional | Cadence of the scheduled reconciliation check (A-1-lite debit backing + the escrow projection drift alarm, issue #212) — default `1440` (daily). The `POST /api/jobs/run` callee seeds a fresh `reconciliation` job row whenever the newest one is older than this, so whatever drains that endpoint (compose `jobs-tick`, systemd timer, cron) also maintains the cadence. Never stacks rows (a queued/retrying row blocks the seed — a manual run and the schedule cannot double-book). Invalid values warn once and fall back to the daily default. See §7.3. |
| `ESCROW_DRIFT_ALERT_CENTS` | finance alarm: optional | Alert threshold for the escrow projection drift check, in **integer cents** — default `1` (the Money-tab chip's exact-equality convention, issue #122: a one-cent drift is a drift). `|derived ledger sum − EscrowWallet.balance| ≥ threshold` emits an `escrow.drift` domain event + in-app notifications to the **finance and contractor** audiences on the drifted project. Raise it only to tolerate a KNOWN projection quirk while it is being fixed — sub-threshold drift is still recorded (un-alerted) in the job's result JSON. Invalid (non-integer / < 1) values warn once and fall back to `1`. See §7.3. |
| `ERROR_SINK_URL` | observability: optional | The error sink gate (issue #202, audit OBS-1): when set, every captured error (route-kit error path, job-handler failures, webhook catch blocks) additionally makes ONE fire-and-forget JSON POST to this endpoint — `{ ts, service, environment?, scope, requestId?, route?, method?, error: { class, message, stack?, internal }, context? }` — with a 5s abort bound, no retries, and Prisma/framework internals redacted before the wire (the `safeErrorMessage` discipline; stacks omitted on internal errors). **Unset (the default) = journal-only: nothing external is contacted and `captureError()` is a no-op that warns once per process** — exactly the behavior of every prior release. Secret-class (a bearer capability into your collector); `ERROR_SINK_TOKEN` adds an optional Authorization header; `ERROR_SINK_ENV` is a non-secret deployment tag (falls back to `NODE_ENV`). See §10. |
| `NOTIFY_SMS_WEBHOOK_URL` / `_TOKEN` | notifications: optional | The SMS webhook relay: when the URL is set, notify calls that pass `opts.sms` additionally POST JSON `{ to, text, metadata }` to it (the optional token rides as a bearer header). Credentials stay in YOUR gateway — nothing SMS-related lives in this app. Rows honestly record `sent`/`failed` + delivery detail. |
| `AT_API_KEY` + `AT_USERNAME` (+ `AT_SENDER_ID`, `AT_ENV`) | notifications: alternative to the webhook | Direct **Africa's Talking** provider: with both values set (a partial pair is ignored, fail-closed) and no webhook URL configured, notify calls AT's REST v1 messaging endpoint directly and records the real `messageId` as `providerRef`. The API key can send and bill SMS on your AT account — keep the env file uncommitted and narrowly readable. `AT_ENV=sandbox` targets AT's sandbox host for wiring tests without billing. **Webhook wins if both are configured; with neither, nothing external is called** (rows stay `logged`). |
| `DARAJA_RECONCILE_AFTER_MIN` / `_INTERVAL_MIN` / `_MAX_AGE_MIN` | Daraja sweep: optional | Tuning for the `wallet.reconcile` job (pending STK-intent reconciliation, §7.3): probe intents once they are `AFTER` minutes old (default 2), re-probe every `INTERVAL` minutes (default 5, matching the scheduler tick), stop probing past `MAX_AGE` minutes (default 60 — the intent stays PENDING, never an invented failure/credit). Invalid values warn and fall back to defaults; all-unset = defaults, and with no Daraja env no intents exist so the sweep does nothing. |
| `DARAJA_ALLOWED_IPS` | Daraja webhook: optional | Comma-separated IPv4 CIDRs (and/or bare IPs), e.g. `196.201.214.0/24` — when set, the STK callback route rejects requests whose resolved client IP (x-forwarded-for per `TRUST_PROXY`) matches no entry with 403 **before the body is parsed**; unresolvable IPs are rejected too (fail closed). Unset = the documented posture (unguessable secret path + query-API reconciliation). IPv6 = exact-literal match only (no IPv6 CIDR). Invalid entries are logged and ignored, but a set value with zero valid entries denies **all** traffic. **Requires `TRUST_PROXY=1`**: with `TRUST_PROXY` unset the x-forwarded-for header is ignored (issue #156), the resolved IP is always unresolvable, and a set allowlist denies **all** traffic — only sound behind a proxy you control that forwards `x-forwarded-for`. |
| `S3_ENDPOINT` + 4 more | object storage: optional | The five `S3_*` values (`S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`) switch photo uploads from local disk to an S3/R2/MinIO-compatible bucket (presigned client-direct uploads become available). **All five or nothing** — a partial set fail-closes to local disk with one logged warning. Optional `S3_PUBLIC_BASE` = stable public/CDN URL base. See §9. |
| `PORT` / `HOSTNAME` | standalone runtime | `3000` / `0.0.0.0` defaults (set by the Docker image; `HOSTNAME=0.0.0.0` binds all interfaces). |

Cookie policy is switched per request in `src/backend/lib/auth.ts`
(`buildAuthOptions`): https (proxied) traffic gets `SameSite=None; Secure`,
direct localhost keeps next-auth's `lax` defaults.

### 3.1 Field-line webhook posture matrix (issue #156)

`/api/ussd` and `/api/whatsapp` are unauthenticated gateway seams. What a
POST gets, for every combination of secret × runtime × opt-in:

| Secret | Runtime | `WEBHOOK_OPEN_POSTURE` | POST result | Notes |
|---|---|---|---|---|
| set | any | (ignored) | `401` without a valid `X-Signature` | Shared-secret posture — the only one that should face a real gateway. USSD phone-tail PIN fallback OFF (kiosk PIN only). |
| unset | `NODE_ENV=production` | (ignored) | **503** before any body read | SEC-4 fail-closed — unchanged. Loud startup warning. |
| unset | non-production | unset (default) | **503** before any body read | New default (issue #156): staging/preview/no-`NODE_ENV` containers fail closed instead of silently accepting writes. |
| unset | non-production | `1`/`true` | **200** — open demo posture | Explicit opt-in: warn-and-accept, ONE loud startup warning per route, USSD phone-tail PIN fallback active. Never use on a shared host. |

The opt-in exists so local dev/demo keeps working with one honest env var;
production never reads it. Full per-variable commentary lives in
`.env.example` (each block is written to be copy-paste-safe).

**Web push (Wave 5, shipped):** the optional VAPID
pair (`VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY`, optional `VAPID_SUBJECT`)
enables push sends through the same env-gated, fail-closed pattern — unset,
subscriptions store intent and sends stay `logged`.

**The Wave-6 AI surface (no env vars — flag + config file):** the `ai`
feature flag **ships dark** (DEFAULT OFF in `FLAG_DEFAULTS`, seeded
disabled); an admin opts in through the header flags popover, and
`NEXT_FLAGS_OFF` can only force it off. Live AI additionally needs a
`.z-ai-config` JSON file (`{ baseUrl, apiKey }`) readable by the process —
the SDK looks in the working directory, the home directory, or `/etc`
(`src/backend/modules/ai/provider.ts` documents the resolution). There are
**no AI env vars by design**. Flag on + no config file → every surface
answers the honest "AI unavailable" state (no fake output, no error storm);
flag off → the SDK is never contacted. Every SDK call is capped at **20 s**
(raised from 8 s after production measurement — multi-photo vision carries
~1–2 MB of base64 and measured 6–8 s alone), and errors are leak-free
(HTTP status or error class only — never URLs, keys or bodies).

## 4. Local development quickstart

```bash
git clone https://github.com/Roy-Wanyoike/Mjengo-OS.git mjengo
cd mjengo
bun install                       # uses bun.lock

cp .env.example .env
# edit .env:
#   DATABASE_URL=file:../db/custom.db   (repo-relative; db/ is gitignored —
#                                         Prisma auto-creates it, see §4.1)
#   NEXTAUTH_SECRET=$(openssl rand -hex 32)     # or: openssl rand -base64 32
#   (≥ 32 chars. In production a missing/short secret is a BOOT ERROR —
#    see §3 NEXTAUTH_SECRET and src/backend/lib/next-auth-guard.ts; dev
#    logs a one-time warning instead.)

bunx prisma generate              # generate the Prisma client
bunx prisma migrate deploy        # apply prisma/migrations/ (see §4.1)
bun run dev                       # → http://localhost:3000
```

The database ships **empty** — seed the demo data next.

### 4.1 Migrations vs `db push`

- **`bunx prisma migrate deploy`** — the production path. Applies
  `prisma/migrations/` in order and records them in `_prisma_migrations`.
  It also **auto-creates missing parent directories** for SQLite URLs —
  verified 2026-09-16 against the repo-pinned Prisma 6.19.2: a scratch
  copy of `prisma/` with no `db/` present ran
  `DATABASE_URL=file:../db/custom.db prisma migrate deploy` → exit 0,
  all 11 migrations applied, `db/custom.db` created. So a fresh clone
  needs **no `mkdir db` step**. The guarantee is version-dependent: an
  older or unpinned Prisma (`npx prisma@<other>`) can still fail with
  "unable to open database file" — in that case pre-create the directory
  (`mkdir -p db`).
  Baseline: `0_init` (the foundation schema, generated from
  `prisma/schema.prisma`); then nine **additive-only** migrations:
  `1_mjengo_score` (W3-3 trust score), `2_draw_pack` (W4-1 evidence
  bundles), `3_push_subscription` (W5-1 web push), `4_supplier_user_link`
  (W5-3 — one `ALTER TABLE ADD COLUMN`), the Wave-6 AI tables
  `5_ai_review_note` / `6_photo_hash` / `7_ai_insight` / `8_trust_digest`,
  and `9_schema_reconcile` (issue #73 — the drift reconciliation, below).
  68 models today; every migration is `CREATE TABLE` / `ALTER TABLE ADD
  COLUMN` / `CREATE INDEX` — zero data migration, safe, never drops data.
- **Drift status: RESOLVED (issue #73, migration `9_schema_reconcile`).**
  Waves 2–6 let `schema.prisma` drift ahead of the migration history (five
  pieces landed via `db push` and were never captured as SQL), so a fresh
  `migrate deploy` used to boot a database missing `Task.version`,
  `Attendance.version`, `Transaction.phaseId`, `Notification.deliveryDetail`
  and the whole `DeliveryPhoto` table. `9_schema_reconcile` adds exactly
  those pieces additively, so **migrations and `schema.prisma` now agree:
  `bunx prisma migrate diff --from-migrations prisma/migrations
  --to-schema-datamodel prisma/schema.prisma --script` is empty**, and a
  fresh `migrate deploy` + the full §4.2 seed chain runs clean (verified on
  a throwaway `file:/tmp/fresh.db`). The historical dev database was
  baselined with `bunx prisma migrate resolve --applied 0_init …
  9_schema_reconcile` (it was already `db push`-synced to the same shape —
  verified with `migrate diff --from-url` — so the SQL was *not* re-executed
  against it; `migrate status` reports up to date). Docker/production boots
  (`prisma migrate deploy` in the image CMD) are migration-managed end to
  end — `db push` is no longer needed to reconcile anything for deploys.
- **`bunx prisma db push`** (or `bun run db:push`) — the prototyping path
  for LOCAL schema experimentation: pushes `schema.prisma` straight to the
  DB, ignoring migrations. It still works after the baseline — push does
  not read `_prisma_migrations` — but **once a real deployment exists,
  change the schema only via new migrations** (`bunx prisma migrate dev
  --name x` locally, commit the generated SQL, `migrate deploy` in
  production) so the migrate-managed path never drifts again.
- **`Transaction.phaseId` (issue #39, phase cost-codes)** is an additive
  schema change delivered by `9_schema_reconcile`: a nullable column + FK to
  `Phase` (`SetNull` on phase delete), zero data migration. Legacy rows and
  non-phase spend (wages, unattributed expenses) legitimately stay `null` —
  the budget-variance report then attributes them by its documented
  budget-share estimate, while money posted through seams that KNOW the
  phase (milestone releases, milestone payment requests, payer-attributed
  `invoice.pay`) carries a real code and counts directly. The report's
  `phaseAttribution.mode` (`real` / `mixed` / `estimated`) states which mode
  produced the numbers. Money math is untouched (amounts, ledger
  double-entry, balances — this is attribution only).
- Seeding does NOT run automatically in any path; run it explicitly (§4.2).

### 4.2 Seed chain (exact order)

Seed scripts are TypeScript run directly with bun. Order matters —
`prisma/seed.ts` creates the base rows everything else references:

```bash
bun prisma/seed.ts                   # base: 3 demo projects, phases, tasks,
                                     #   workers, attendance, materials,
                                     #   deliveries, transactions, photos,
                                     #   alerts, recaps + (inline, in order)
                                     #   professionals → land → supply →
                                     #   invoices → intel
bun prisma/seed-extras/users.ts      # 8 demo login accounts (wipes ONLY User)
bun prisma/seed-extras/tasks.ts      # task v2: priorities, assignees,
                                     #   blockers, overdue escalation case
bun prisma/seed-extras/domain.ts     # worker depth, delivery driver leg,
                                     #   project team roster (idempotent)
bun prisma/seed-extras/evidence.ts   # zones, photo comments, notifications,
                                     #   audit events
bun prisma/seed-extras/money.ts      # escrow, milestones, variation orders,
                                     #   double-entry ledger history, payment
                                     #   requests (wipes only money models)
bun prisma/seed-extras/trust.ts      # fundi attendance trust history + PINs
```

Every extras script is standalone-runnable for partial re-seeds; each wipes
only the models it owns (never the base seed). For a **from-scratch reset**:
`rm db/custom.db && bunx prisma migrate deploy && <full chain above>`.
Demo logins are listed in `README.md` (contractor/client/admin/finance …).

## 5. Testing & verification

Local gates (identical to CI):

```bash
bun run lint            # eslint .          → 0 errors
bunx tsc --noEmit       # strict typecheck  → 0 errors
```

The finance gate (issue #215) — the pre-release money check:

```bash
bun run test:finance    # the money-invariant release gate: 27 files / 629
                        #   tests (ledger posting + reversal, wallet
                        #   idempotency, escrow, Daraja callback/reconcile,
                        #   3-way match, v1 money routes, integer-cents
                        #   core, + the fence test that keeps the gate's own
                        #   file list honest — tests/finance/gate-files.ts).
                        #   Counts as of 2026-09-27; re-run for current.
```

Run it on every money-path change (seconds, instead of the full suite) and
<<<<<<< HEAD
before every release, alongside the full suite (`bun run test` — 3,159
tests / 143 files, counts as of 2026-09-27; the gate's files are a subset;
the living baseline is `docs/audit/TEST_BASELINE.md`).
=======
before every release, alongside the full suite (`bun run test` — 3,171
tests / 144 files, counts as of 2026-09-26; the gate's files are a subset).
>>>>>>> c950497 (test(qa): vitest coverage config + documented critical-module thresholds (closes #185))
Release notes and QA reports cite it as one line: "`bun run test:finance`
green at `<sha>`".

Coverage floors (issue #185) — the critical-module coverage check:

```bash
bun run test:coverage    # same suite + @vitest/coverage-v8: text table +
                         #   coverage/lcov.info, plus per-module floor
                         #   thresholds for the money path, sync/outbox core
                         #   and guard/auth seams — every floor set at
                         #   floor(measured); ratchet convention in
                         #   CONTRIBUTING.md; no repo-wide floor by design.
```

CI runs this exact command and uploads `coverage/` (the lcov report) as a
run artifact. Release QA cites it as one line: "`bun run test:coverage`
green at `<sha>` (floors held)".

Auth smoke test with curl (cookie jar):

```bash
JAR=/tmp/mjengo-jar.txt; rm -f $JAR
CSRF=$(curl -s -c $JAR http://localhost:3000/api/auth/csrf | python3 -c "import json,sys;print(json.load(sys.stdin)['csrfToken'])")
curl -s -b $JAR -c $JAR -X POST http://localhost:3000/api/auth/callback/credentials \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "csrfToken=$CSRF&email=contractor@mjengo.os&password=mjengo2026&json=true" -o /dev/null -w "login: %{http_code}\n"
curl -s -b $JAR http://localhost:3000/api/projects -o /dev/null -w "guarded: %{http_code}\n"  # 200 with session
curl -s http://localhost:3000/api/projects -o /dev/null -w "anon: %{http_code}\n"            # 401 without
```

Browser smoke: open `http://localhost:3000/`, sign in with a demo account,
check the Overview tab renders KPIs and `/api/health` shows `db: "up"`.

**What CI runs on every push to `main` and every PR** (`.github/workflows/`):

| Workflow | Job | Steps |
|---|---|---|
| `ci.yml` | `quality` | checkout → setup-bun → `bun install --frozen-lockfile` → `bun run lint` → `bunx tsc --noEmit` |
<<<<<<< HEAD
| `test.yml` | `test` (Vitest unit suite) | checkout → setup-bun → `bun install --frozen-lockfile` → `bun run test` (`vitest run` — 3,159 tests / 143 files, counts as of 2026-09-27; re-run vitest for current. No database or secrets required) |
| `ci.yml` | `build` | checkout → setup-bun → `bun install --frozen-lockfile` → `bunx prisma generate` → `bun run build` (standalone) with `DATABASE_URL=file:ci.db` + dummy `NEXTAUTH_SECRET` — the build must never need real secrets |
=======
| `test.yml` | `test` (Vitest unit suite) | checkout → setup-bun → `bun install --frozen-lockfile` → `bun run test:coverage` (`vitest run --coverage` — 3,171 tests / 144 files, counts as of 2026-09-26; re-run vitest for current. No database or secrets required. Enforces the per-module coverage floors — issue #185) → upload `coverage/` (lcov report) as a run artifact || `ci.yml` | `build` | checkout → setup-bun → `bun install --frozen-lockfile` → `bunx prisma generate` → `bun run build` (standalone) with `DATABASE_URL=file:ci.db` + dummy `NEXTAUTH_SECRET` — the build must never need real secrets |
>>>>>>> c950497 (test(qa): vitest coverage config + documented critical-module thresholds (closes #185))
| `docker.yml` | `docker-build` | `docker build -t mjengoos-ci .` on a GitHub runner — **real verification of the Dockerfile** (the dev sandbox has no docker CLI). No registry push. |
| `docker.yml` | `website-build` | `docker build -t mjengoos-website-ci ./mjengoos-website` — same posture, real verification of the marketing-site image. No registry push. |

PR runs cancel automatically when new commits land (`concurrency` guard).

## 6. Docker

### 6.1 What the image is

`Dockerfile` = two Debian-bookworm stages:

- **builder** — `node:20-slim` + the bun binary copied from `oven/bun:1`:
  `bun install --frozen-lockfile`, `bunx prisma generate`,
  `NEXTAUTH_SECRET=dummy DATABASE_URL=file:build.db bun run build`
  (the repo's build script already places `.next/static` + `public/` inside
  `.next/standalone/`).
- **runner** — `node:20-slim`, non-root `node` user, `PORT=3000`,
  `HOSTNAME=0.0.0.0`, EXPOSE 3000. Ships `.next/standalone`, the Prisma CLI
  + engine binaries + generated client, `prisma/schema.prisma` and
  `prisma/migrations/`. **On start it runs `prisma migrate deploy` (offline —
  everything needed is inside the image) and then `node server.js`.**
  Skipping migrations for one run: `docker run … mjengoos node server.js`.

`.dockerignore` keeps the context secrets-free (`.env*`, `db/`, logs, agent
artifacts, sibling projects are excluded — env reaches the image only via
`docker run`/compose at runtime, never from the build context).

The marketing website has its own image, built the same way — §6.5.

### 6.2 Build & run

```bash
docker build -t mjengoos .
docker run -d --name mjengoos -p 3000:3000 \
  -e DATABASE_URL="file:/app/db/custom.db" \
  -e NEXTAUTH_SECRET="$(openssl rand -hex 32)" \
  -v mjengoos-db:/app/db \
  -v mjengoos-photos:/app/public/photos \
  mjengoos
curl http://localhost:3000/api/health   # {"ok":true,"db":"up","timestamp":"…"} (minimal liveness — see §7.2)
```

### 6.3 docker compose (recommended)

```bash
cp .env.example .env     # set NEXTAUTH_SECRET (+ NEXTAUTH_URL only if fixed domain)
docker compose up -d --build
```

`docker-compose.yml` (single-node self-host, **three services**):

- **`app`** — the webapp on `3000:3000`, `restart: unless-stopped`, env from
  `.env` **except** `DATABASE_URL` which is pinned to the named volume
  (`file:/app/db/custom.db` → volume `app-db`), plus
  `WEBSITE_ORIGIN=http://website:3001` so the `/website/*` rewrite resolves
  the website service on the compose network. Named volume `app-photos` for
  `POST /api/upload` uploads; healthcheck probing `/api/health` with node's
  `fetch`.
- **`website`** — the marketing site (`./mjengoos-website`), built in
  integrated mode by default, `restart: unless-stopped`, **internal port
  3001 only** (not published — it is reached through the app's rewrite),
  named volume `website-data` for contact-form submissions, healthcheck
  probing `/website` with node's `fetch`.
- **`jobs-tick`** — a busybox sidecar (no app code) that POSTs
  `http://app:3000/api/jobs/run` every 5 minutes with
  `Authorization: Bearer $JOBS_RUN_TOKEN`, draining the background-job
  queue on a schedule. Enabled by setting `JOBS_RUN_TOKEN` in `.env`
  (unset → the app fails the bearer calls closed and every tick logs a
  401); `docker compose logs jobs-tick` is its health signal. Full
  contract: §7.3.

After `up -d --build`: the product is at `http://localhost:3000` and the
marketing site at `http://localhost:3000/website` — one origin, the site's
"Sign in" lands on the app's login screen. To publish the site's own origin
as well, add a compose override file with `ports: ["3001:3001"]`.

**These three volumes are the deployment's entire state.** `deploy/backup/`
ships a scheduled backup covering all of them (online SQLite `.backup`
snapshot of `app-db`, tar+gzip of `app-photos` and `website-data`,
7 daily / 4 weekly retention) plus a drilled restore runbook — install
it before real data lands: §7.2.1, restore: §7.2.2.

#### Container log rotation (issue #214)

Every service in `docker-compose.yml` carries an explicit `logging:` block —
the `json-file` driver capped at `max-size: "10m"`, `max-file: "3"` — a hard
ceiling of ~30 MiB per service (~90 MiB for all three together). Without it
the `json-file` driver keeps container stdout/stderr **forever** (Docker's
default when the daemon sets no caps), and `restart: unless-stopped` means a
crash-looping service emits log lines as fast as it restarts — the backups
above cover the three stateful volumes, never
`/var/lib/docker/containers/*/*-json.log`. Verify on your host after
`up -d`: `docker compose config` renders the options, and
`docker inspect mjengoos --format '{{.HostConfig.LogConfig}}'` shows the caps
the container was created with. Nothing about *what* is logged changes — the
log seam itself is §10.1.

These caps are **per-compose only**: any *other* container on the host
(a reverse proxy, a database, a monitoring agent) is not covered by them —
set daemon-level defaults for those (§7.2, "Container log rotation").

#### Retrieving contact-form leads (issue #110 / audit WD-8)

The website's contact and demo-request forms (`POST /api/contact`, proxied
at `/website/api/contact` in integrated mode) persist every submission to a
JSON file on disk and contact **no third party** — no email, webhook or
notification is ever sent, so reading that file is the only retrieval path
(an operator who forgets it loses leads silently). Where it lives and how
to read it:

- **Local dev / standalone site** — `mjengoos-website/data/submissions.json`
  (relative to the site process's working directory; gitignored runtime
  PII — the `data/` directory is absent on a fresh clone but the contact
  route creates it on first write with `mkdir -p` semantics, so no manual
  setup is needed). Pretty-print it with
  `python3 -m json.tool mjengoos-website/data/submissions.json`.
- **docker compose** — the file lives inside the `website` service container
  on the `website-data` volume (`/app/data/submissions.json`):

  ```bash
  docker compose exec website cat /app/data/submissions.json
  # keep a copy outside the volume:
  docker compose exec website cat /app/data/submissions.json > leads.json
  ```

- **Retention cap — read it regularly:** the store keeps only the **500 most
  recent** submissions; every write past 500 drops the oldest entry, and
  there is no rotation or archive file, so dropped leads are gone for good.
  Retrieve on a cadence, especially during onboarding bursts. The scheduled
  backup (§7.2.1) includes this volume — its retention bounds the loss
  window — but retrieval (above) is still the only way to actually READ
  leads. The eviction
  is **not silent** (issue #131): every write past the cap logs
  `[contact] submission cap reached — dropping N oldest …` (with the count)
  to the website container's logs —
  `docker compose logs website | grep "submission cap"` — so a burst that
  outpaces retrieval is visible in operations, not just in hindsight.

Each entry is the validated form payload —
`{ id, ts, source, name, email, phone?, organization?, role?, country?,
projectType?, message? }` — plaintext PII on disk; handle it accordingly
(the file is gitignored, and the site's `.dockerignore` keeps `data/` out
of images).

#### Contact-form rate limiting (issue #131 / audit WD-1)

`POST /api/contact` runs a two-layer limiter, both 1-hour rolling windows:

| `TRUST_PROXY` | Per-visitor layer | Global backstop |
|---|---|---|
| **unset** (default) | — (header is client-spoofable; ignored) | all traffic shares **one 200/hr bucket** |
| **set** (one appending proxy in front) | **5/hr** keyed on the proxy-appended (last) `x-forwarded-for` entry | **200/hr** across all visitors |

- The default posture is burst-tolerant by design: a launch push producing
  tens of leads an hour no longer 429s everyone (the old global cap was
  5/hr), while a flood still fails closed at 200/hr.
- A 429 response says which layer tripped:
  `reason: "rate_limited_visitor"` vs `"rate_limited_global"`.
- Tripping the **global** layer logs a warning that also states whether
  per-visitor keying is on, and how to enable it — visible via
  `docker compose logs website`.
- Set `TRUST_PROXY=1` at **runtime** (not build time) only when exactly one
  reverse proxy that appends the real client IP (nginx
  `proxy_add_x_forwarded_for` etc.) fronts the website container directly —
  see the site's `.env.example`. The app's `/website` rewrite does not
  append the header, so integrated-mode compose deployments leave it unset.
- Restart persistence of the counters is **deliberately declined**: they are
  in-memory, so a restart grants a fresh window — bounded (≤ 5/hr per
  visitor, ≤ 200/hr globally), not a bypass; the website stays a stateless
  container with no database (rationale in the route's header comment).

### 6.4 Seeding a containerized database (honest note)

The seed scripts are bun-run TypeScript files and the production runner image
has **node, not bun**. For a demo/self-host instance with seed data either:

1. bind-mount the DB instead of a named volume and seed from a host checkout:
   `-v ./data:/app/db` + `DATABASE_URL=file:./data/custom.db bun prisma/seed.ts …`;
2. or build a derived image (`FROM mjengoos` + `oven/bun:1` copied in) and run
   the chain in a one-off container.

Production data does not need seeds — users/projects are created via the app.

**Production guard (issues #126/#180).** Every seed entry (`bun run seed`,
`prisma/seed.ts`, `prisma/seed-extras/users.ts`) **refuses to run when
`NODE_ENV=production`**: the chain deletes all rows in the tables it owns
before writing demo data, so the only way through is an explicit, per-run
acknowledgment —

```bash
I_HAVE_BACKED_UP_AND_WANT_TO_SEED_PRODUCTION=1 NODE_ENV=production bun run seed
```

— and even then the guard refuses if `DATABASE_URL` is anything but a local
SQLite `file:` URL (defensive: the chain only supports the local demo DB, so
a `postgres://` target is rejected). In bypass mode the `admin@mjengo.os`
demo account is **not** created unless `SEED_DEMO_ADMIN=1` is also set (its
password is public in README.md); the other demo accounts are still created
with their documented public passwords — change or disable them before real
use. Non-production runs (dev, CI, unset `NODE_ENV`) are unchanged. The
rules live in `prisma/seed-guard.ts` and are pinned by
`tests/unit/seed-guard.test.ts`.

### 6.5 The marketing-website image

`mjengoos-website/Dockerfile` mirrors the root Dockerfile's conventions for
the marketing site (an independent Next.js app: no Prisma, no auth, no
database, so there is nothing to migrate and no build-time secret to dummy
out):

- **deps** — `node:20-slim` + the bun binary from `oven/bun:1`:
  `bun install --frozen-lockfile` against the site's own `package.json` /
  `bun.lock`.
- **builder** — `next build` under Node with the three `NEXT_PUBLIC_*` vars
  supplied as **build ARGs** (Next.js inlines them at build time — switching
  serving modes is a rebuild, not a re-run; defaults = integrated mode,
  `NEXT_PUBLIC_BASE_PATH=/website` + `NEXT_PUBLIC_APP_URL=/` + an empty
  `NEXT_PUBLIC_SITE_URL`, whose SEO/sitemap origin then falls back to the
  dev default — set it for any indexed deployment, §6.6; the launch-gate
  checklist is §6.7). A fourth,
  server-side build ARG `SITEMAP_LAST_MODIFIED` feeds the sitemap's
  lastModified (issue #143 — see below).
- **runner** — `node:20-slim`, non-root `node` user, **standalone output**
  (`output: "standalone"` in `mjengoos-website/next.config.ts`, mirroring the
  root app): ships `.next/standalone` + `.next/static` + `public/` only —
  not the ~600 MB `node_modules` tree — with `PORT=3001`, EXPOSE 3001,
  `CMD ["node", "server.js"]`. `/app/data` is created writable for the
  contact-form API.

The site's `.dockerignore` keeps its context clean: `.env*`,
`node_modules`, `.next`, `data/` and logs never enter an image.

Build & run (standalone container, no compose):

```bash
docker build -t mjengoos-website ./mjengoos-website
docker run -d --name mjengoos-website -p 3001:3001 mjengoos-website
curl http://localhost:3001/website     # 200 (default integrated basePath)
```

The sitemap's `lastModified` is derived at build time (issue #143 / audit
WD-6 — no hand-bumped date): from the last commit that touched
`mjengoos-website/` when building inside a checkout, or from the
`SITEMAP_LAST_MODIFIED` build ARG — the image context contains no `.git`,
so building from a checkout passes it explicitly (computed, never
hand-edited):

```bash
docker build -t mjengoos-website ./mjengoos-website \
  --build-arg SITEMAP_LAST_MODIFIED="$(git log -1 --format=%cI -- mjengoos-website)"
```

Without the ARG the sitemap omits `lastModified` (an honest absence crawlers
ignore) rather than stamp a made-up date.

For a standalone-domain image instead (§6.6):

```bash
docker build -t mjengoos-website ./mjengoos-website \
  --build-arg NEXT_PUBLIC_BASE_PATH= \
  --build-arg NEXT_PUBLIC_APP_URL=https://app.yourdomain.example \
  --build-arg NEXT_PUBLIC_SITE_URL=https://yourdomain.example \
  --build-arg SITEMAP_LAST_MODIFIED="$(git log -1 --format=%cI -- mjengoos-website)"
docker run -d --name mjengoos-website -p 3001:3001 mjengoos-website
curl http://localhost:3001/            # 200, site served at /
```

### 6.6 Marketing site deployment modes

The site supports two modes, chosen at **build time** (the `NEXT_PUBLIC_*`
vars are inlined by `next build`):

| Mode | Build values | Layout |
|---|---|---|
| **Integrated** (default) | `NEXT_PUBLIC_BASE_PATH=/website`, `NEXT_PUBLIC_APP_URL=/` | One origin: the webapp proxies `/website/*` to the site (its `next.config.ts` rewrite → `WEBSITE_ORIGIN`). "Sign in" goes to the app's login screen at `/` — same origin, same cookie domain. This is what compose runs. |
| **Standalone** | `NEXT_PUBLIC_BASE_PATH` empty, `NEXT_PUBLIC_APP_URL=https://app.yourdomain.example` | Own domain: serve port 3001 behind nginx/Caddy/CDN (e.g. `https://mjengoos.example.com`); "Sign in" jumps to the app's public origin; set `NEXT_PUBLIC_SITE_URL` (site `.env.example`) for SEO metadata / sitemap. |

In integrated mode the site's server must be reachable **from the app
process** at `WEBSITE_ORIGIN` — `http://127.0.0.1:3001` locally,
`http://website:3001` under compose. In standalone mode nothing proxies:
`WEBSITE_ORIGIN` is irrelevant and the site is fronted like any web origin.

### 6.7 Website launch gate — SITE_URL before an indexed site (issue #149)

Every absolute URL the site emits — sitemap.xml, the robots.txt sitemap
link, canonical tags, OG/Twitter cards, JSON-LD — is baked at **build
time** from `NEXT_PUBLIC_SITE_URL` (`mjengoos-website/lib/site.ts` MW-9).
Left unset it falls back to the dev origin `http://localhost:3001`.
That default is deliberate and correct for local dev and for the
un-indexed compose default, but on an **indexed** deployment it is an SEO
disaster: the canonical tags and sitemap would tell crawlers the real
pages live on `localhost` — the site effectively de-indexes itself.

**Launch checklist — before serving the site to crawlers (either mode):**

- [ ] `NEXT_PUBLIC_SITE_URL` is set at **build** time to the public origin
      the site is browsed at — standalone mode: `https://yourdomain.example`;
      integrated mode: the app's public origin (the sitemap then lists
      `https://yourdomain.example/website/<page>`). It is a Docker build
      ARG (§6.5) — `NEXT_PUBLIC_*` vars are inlined by `next build`, so
      changing it means **rebuilding the image**, not re-running it.
- [ ] Verify the bake, not the intention:
      `curl https://yourdomain.example/sitemap.xml` (or
      `…/website/sitemap.xml`) lists your origin — not `localhost:3001`.

**Build-time backstop (issue #149):** `next build` prints a loud
`[site-url]` warning for the one combination that means "indexed site,
localhost URLs" — a production **standalone** build (`NEXT_PUBLIC_BASE_PATH`
unset) with no usable `NEXT_PUBLIC_SITE_URL`. The warning is a watch item,
never a build failure (a deliberate localhost build for internal use still
succeeds — it just says so), and it stays **silent** for the integrated
zero-override default and for local dev, so `docker compose up` builds
without noise. The decision is pinned by `tests/unit/website-siteurl-gate.test.ts`.

### 6.8 Staging stack — `docker-compose.staging.yml` (issue #208)

The deployment ladder used to be two rungs — local dev (`bun run dev`) and
the single production node — so migrations, image rebuilds, seed chains and
restore drills had no rehearsal space that resembled prod.
`docker-compose.staging.yml` is the middle rung: **the same three services
(app, website, jobs-tick) on the same production image, with the same
migrate-on-boot CMD and healthchecks** — but its own compose project
(`name: mjengo-staging` → own network + volume prefix), container names
(`mjengo-staging-*`), volumes (`staging-*`), host ports (**3100** for the
app, 3101 for the website's own origin) and its own env file
(`.env.staging`), so it can coexist with a prod stack on one host or stand
alone on a rehearsal box.

**Honest scope:** staging ≈ prod shape on ONE box. It is not HA, not a
second region, and not the Supabase target state (#96 — closed — is that
design). Anything single-box SQLite cannot survive (host loss), staging
cannot either; what it buys is a place where the *mechanical* prod path
fails first.

**When to deploy to staging:**

- **Before every promote to prod** — rehearse the exact §8 update path
  (`git pull && docker compose up -d --build`): migrations apply on boot
  here first, where a bad migration bricks staging, not prod (the bug
  class of issue #73).
- **Before restore drills** — §7.2.2's runbook wants a rehearsal target
  that is not prod data (#199).
- **When trying a seed chain or a demo-data refresh** (below).
- **When validating compose/env changes** (new services, log caps,
  healthchecks — the `tests/unit/compose-log-rotation.test.ts` fence
  auto-discovers the staging file and pins the §6.3 log caps on its
  services too).

**Boot:**

```bash
cp .env.staging.example .env.staging
# edit .env.staging — REQUIRED / recommended:
#   NEXTAUTH_SECRET=$(openssl rand -hex 32)   # a NEW one — never prod's
#   NEXTAUTH_URL=http://<where-your-team-browses-staging>:3100
#   JOBS_RUN_TOKEN=$(openssl rand -hex 32)    # optional, also never prod's
docker compose --env-file .env.staging -f docker-compose.staging.yml up -d --build
```

The `--env-file` flag is load-bearing, twice: the fail-closed
`${NEXTAUTH_SECRET:?}` **interpolation** and the app service's `env_file`
both read `.env.staging`. Without the flag, compose falls back to the
project directory's `.env` — if prod's `.env` sits there, staging silently
boots on **prod's** secret (and prod's `JOBS_RUN_TOKEN`). Treat the full
command line as the one true incantation; the compose file's header says
the same.

**Why staging runs `NODE_ENV=production` (the SEC-2 sharp edge).** In a
non-production runtime a missing/short `NEXTAUTH_SECRET` degrades to the
publicly-derivable dev fallback secret — forgeable admin sessions (issue
#168, audit SEC-2). A naively-created staging node running "not quite prod"
is exactly where that hole would live. The staging stack pins
`NODE_ENV=production` (the image ENV plus an explicit re-assert in the
compose file) so the hole **cannot exist there by construction**: the boot
guard fails closed on a missing/short secret, `WEBHOOK_OPEN_POSTURE` is
ignored (§3.1), the JSON log format is the production one (§10.1), and the
seed guard below stands. A custom value like `NODE_ENV=staging` would also
fail closed for the secret itself (`tests/unit/nextauth-fallback-secret.test.ts`
pins that non-dev runtimes get no fallback candidates) — but it would drift
from prod in every other `NODE_ENV`-keyed behavior, so staging deliberately
ships the identical runtime posture, different data.

**Seeding staging — an explicit step, never in a boot CMD (the §6.4
invariant, kept).** Staging is the ONE environment where seeded demo data
MAY live (prod never). The seed chain is still a deliberate operator step —
no boot CMD, no compose service runs it — using §6.4's option-2 pattern
(the runner image ships node, not bun, so bun is layered onto a derived
image just for the seed):

```bash
# 1) one-off seeder image: the staging app image + bun + the seed scripts
docker build -t mjengo-staging-seed -f- . <<'EOF'
FROM mjengo-staging
COPY --from=oven/bun:1 /usr/local/bin/bun /usr/local/bin/bun
COPY --chown=node:node tsconfig.json ./
COPY --chown=node:node prisma/seed.ts prisma/seed-all.ts prisma/seed-guard.ts ./prisma/
COPY --chown=node:node prisma/seed-extras ./prisma/seed-extras
COPY --chown=node:node src ./src
EOF

# 2) run the chain in a one-off container against the staging DB volume
#    (verify the volume name with: docker volume ls | grep mjengo-staging).
#    The image ENV is NODE_ENV=production, so the #126/#180 guard demands
#    its explicit acknowledgment — deliberately: the image cannot tell
#    staging data from prod data, so "seed by accident" stays a two-flag
#    operation no matter which volume the command points at.
docker run --rm \
  -v mjengo-staging_staging-app-db:/app/db \
  -e DATABASE_URL="file:/app/db/custom.db" \
  -e I_HAVE_BACKED_UP_AND_WANT_TO_SEED_PRODUCTION=1 \
  -e SEED_DEMO_ADMIN=1 \
  mjengo-staging-seed \
  bun prisma/seed-all.ts
```

**Demo-credentials posture.** The seeded accounts
(`contractor@mjengo.os` / `mjengo2026` … — listed in README.md) have
public passwords. On staging that is the point: the full role matrix is
explorable, which is what staging is for. On prod it is never acceptable,
and two layers keep it that way (§6.4): the guard refuses
`NODE_ENV=production` without `I_HAVE_BACKED_UP_AND_WANT_TO_SEED_PRODUCTION=1`
(and only ever against a local SQLite `file:` URL), and the `admin@mjengo.os`
account additionally needs `SEED_DEMO_ADMIN=1`. Staging's convenience
weakens neither — the same guard runs there, answered deliberately.

**What to verify on staging (the checklist):**

1. **Health** — `curl -fsS http://localhost:3100/api/health` → 200
   `{"ok":true,"db":"up",…}` (the §7.2 probe minimum).
2. **Migrations applied** —
   `docker compose --env-file .env.staging -f docker-compose.staging.yml logs app`
   shows prisma's success line (`successfully applied` /
   `No pending migrations to apply`) — the same assertion the CI smoke
   test makes of the prod boot log.
3. **A seeded login works** — sign in as `contractor@mjengo.os` in a
   browser, or run §5's curl cookie-jar auth smoke against `:3100`.
4. **The website paths** — `http://localhost:3100/website` through the
   app's rewrite (the integration path prod uses) and
   `http://localhost:3101/website` directly (the staging-only publish).
5. **jobs-tick** (if `JOBS_RUN_TOKEN` is set) —
   `docker compose --env-file .env.staging -f docker-compose.staging.yml
   logs jobs-tick`: silence is health; every line is a failed drain.

**Promote to prod.** When the checklist is green on staging, run the SAME
mechanical path on the prod host (§8) — the release gates (lint / tsc /
`bun run test:finance` / the full suite) ran at merge; staging rehearsed
the pull → rebuild → migrate-on-boot → verify sequence. Promoting is NOT a
data copy: prod's volumes and secrets are never touched by staging
(separate names, separate secrets — and staging's seeded demo data never
leaves the staging volumes). After promoting, re-verify §7.2's health probe
on prod.

**Teardown:** `docker compose --env-file .env.staging -f
docker-compose.staging.yml down` — add `-v` to also destroy the staging
volumes (staging data is disposable by definition; that is the point).

## 7. Production self-host (without Docker)

```bash
bun install
bunx prisma generate
DATABASE_URL=file:/srv/mjengo/custom.db NEXTAUTH_SECRET=… bun run build
# start (repo script; runs the standalone server):
NODE_ENV=production DATABASE_URL=file:/srv/mjengo/custom.db NEXTAUTH_SECRET=… \
  bun run start            # = NODE_ENV=production bun .next/standalone/server.js
# or with node only:
DATABASE_URL=… NEXTAUTH_SECRET=… node .next/standalone/server.js
```

Run it under systemd/PM2/supervisor with `PORT`/`HOSTNAME=0.0.0.0` env, and
apply schema changes with `bunx prisma migrate deploy` (or
`node node_modules/prisma/build/index.js migrate deploy` on a node-only host)
**before** restarting the server. If you run the app itself under systemd,
run it as the dedicated `mjengo` service user (creation step in §7.3) with
the same hardening family as `mjengo-jobs.service` — but the app unit
additionally **writes** (the SQLite file, uploads), so it needs explicit
`ReadWritePaths=` entries for its database directory (e.g.
`ReadWritePaths=/srv/mjengo` for `DATABASE_URL=file:/srv/mjengo/custom.db`)
and any upload/log directories it owns; the jobs unit needs none because
it only POSTs.

### 7.1 Reverse proxy (the PR #7 lesson)

When MjengoOS sits behind nginx/Caddy/traefik, sign-in breaks unless the
proxy forwards the original host and scheme. PR #7
(`fix(auth): sign-in through the https preview gateway`) fixed exactly this:

1. next-auth v4's `detectOrigin` ignores `x-forwarded-*` unless
   `AUTH_TRUST_HOST` (or VERCEL) is set — unset, every origin silently
   degrades to `http://localhost:3000` and proxied sign-ins redirect/validate
   against the wrong host.
2. `NEXTAUTH_URL` must NOT be pinned to an internal host; leave it unset
   (origin derived per request) unless you serve one fixed public domain.
3. Cookies are policy-switched per request (`src/backend/lib/auth.ts`):
   https-proxied traffic needs `SameSite=None; Secure`, which the app sets
   automatically when the request arrives as https.

Minimum nginx proxy config:

```nginx
server {
  listen 443 ssl;
  server_name mjengo.example.com;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
}
```

### 7.2 Health, backups, secrets

- **Health (issue #164 — liveness split from gated detail):** the public
  `GET /api/health` answers the probe minimum —
  `{"ok":true,"db":"up","timestamp":"…"}` (503 `{"ok":false,"db":"down",…}`
  when the DB is down; the error text does not leak to the public). Wire
  uptime monitoring to exactly that (the compose healthcheck and the CI
  smoke test already do — status + `ok`/`db`, nothing more). The full
  diagnostics (job-queue counts, entity counts, version, uptime,
  `dbLatencyMs`) are GATED behind one of three credentials:
  1. an **admin session** — the in-app Overview SystemHealthCard, zero
     config;
  2. an ops **machine header** — set `HEALTH_DETAIL_TOKEN` in `.env`, then
     `curl -H "X-Health-Detail: $HEALTH_DETAIL_TOKEN" http://your-host/api/health`
     (constant-time compare, fail closed when unset — dashboards should
     use this);
  3. `HEALTH_PUBLIC_DETAIL=1` — the explicit demo/trusted-intranet opt-in
     that re-opens the detail for everyone (what a sandbox preview wants;
     never an internet-fronted deployment).
- **SQLite integrity posture (issue #135 / audit DB-12):** foreign-key
  enforcement in SQLite is a PER-CONNECTION `PRAGMA foreign_keys` (OFF by
  default in raw SQLite — it is not stored in the file). The app asserts it
  at boot: `src/instrumentation.ts` (the Next.js server-boot hook) runs
  `PRAGMA foreign_keys = ON` + a read-back verification via
  `src/backend/lib/db.ts` `ensureForeignKeys()` before serving anything, and
  a failure is FATAL — the server refuses to start rather than silently
  running with every Cascade/Restrict/SetNull in the schema neutered. The
  verified posture: Prisma's SQLite connector opens its connections with the
  pragma ON (pinned on the real engine by
  `tests/unit/db-fk-pragma-realdb.test.ts`, together with an orphan-insert
  P2003 rejection proving enforcement end-to-end). Two caveats for operators:
  1. **Non-Prisma writers** (`sqlite3` CLI, scripts, any direct driver) must
     run `PRAGMA foreign_keys = ON` on EVERY connection themselves — the
     pragma does not persist, and raw SQLite starts OFF. The seeds and every
     DB-touching script entrypoint run the same assert before their first
     query.
  2. **Multi-instance / multi-process deploys:** the ledger's in-process
     reference counter (BE-10, documented at `src/backend/modules/ledger/service.ts`)
     assumes ONE app process — running two instances against the same SQLite
     file risks lost-update races the counter cannot see (on top of SQLite's
     own single-writer model). Keep the deployment single-process per DB
     file; horizontal scaling waits on the Postgres/Supabase path (where this
     whole pragma concern disappears — Postgres enforces FKs natively, and
     the boot assert skips itself for non-SQLite `DATABASE_URL`s).
- **Backups — scheduled (issue #199):** `deploy/backup/` ships the whole
  thing — a script + a systemd timer covering all three stateful volumes:
  an **online** `sqlite3` `.backup` snapshot of the DB (WAL-safe, no app
  stop), tar+gzip of the photo and website-data volumes (+ optional
  app-docs), UTC date-stamped names, 7-daily/4-weekly retention, a
  sha256 sidecar per artifact, an integrity check on every fresh DB
  snapshot, and a loud failure contract (non-zero exit + journal line →
  a FAILED unit an uptime monitor can dead-man-switch on). Install in
  two minutes: §7.2.1. The manual one-liner remains valid for ad-hoc
  snapshots — it is the same command the script runs:
  `sqlite3 /srv/mjengo/custom.db ".backup '/srv/backups/mjengo-$(date +%F).db'"`
  — both produce a consistent snapshot; keep the uploads volume in the
  same backup (photos are evidence). The **`website-data` volume belongs
  in every ad-hoc backup too (issue #151 — it holds `submissions.json`,
  plaintext lead PII, and the 500-entry cap means backups may be the
  only surviving copy of early leads)**:

  ```bash
  docker compose exec -T website tar -C /app/data -cf - . > website-data-$(date +%F).tar
  # same thing from the host, no exec (mountpoint via
  # `docker volume inspect <project>_website-data --format '{{ .Mountpoint }}'`):
  tar -C /var/lib/docker/volumes/<project>_website-data/_data -czf website-data-$(date +%F).tar.gz .
  ```

  The `-T` is **not** optional: `docker compose exec` allocates a TTY by
  default and a TTY mangles a piped binary stream (newline translation
  corrupts the tar). No app stop is needed — a submission racing the read
  makes `tar` exit 1 ("file changed as we read it") instead of shipping a
  torn archive; re-run. Verify the archive lists the leads file with
  `tar -tf website-data-$(date +%F).tar`. Restores: §7.2.2.
- **Container log rotation (issue #214):** the compose file caps every
  service's `json-file` logs (`max-size: "10m"`, `max-file: "3"` — §6.3),
  but that protects only the three compose services. Any *other* container
  on the host (a reverse proxy, a database, a monitoring agent) still logs
  unbounded unless the Docker daemon itself has defaults — set them once
  per host in `/etc/docker/daemon.json`:

  ```json
  {
    "log-driver": "json-file",
    "log-opts": { "max-size": "10m", "max-file": "3" }
  }
  ```

  then `systemctl restart docker`. Daemon defaults apply to **newly created**
  containers only — existing ones keep the `LogConfig` they were created with
  until recreated (`docker compose up -d --force-recreate` refreshes the three
  MjengoOS containers, which already carry the same caps from compose).
  Bare-metal self-hosts (this section) are unaffected — journald rotates on
  its own (cap it via `SystemMaxUse=` in `journald.conf` if needed).
- **Rate-limit store file (`db/ratelimit.db`, the default since issue #158;
  present whenever the sqlite store initialized):** NOT part of backups — it
  is cache-like counter state (WAL sidecar files included); deleting it while
  the app is stopped simply resets everyone's limits and lockouts.
- **Secrets:** generate `NEXTAUTH_SECRET` with `openssl rand -hex 32`; store
  it in your secret manager / `.env` on the host (never in git, never in the
  image). Changing it invalidates all sessions (users just sign in again).
  Do not expose the SQLite file or `db/` via the proxy.

#### 7.2.1 Installing the scheduled backup

`deploy/backup/` holds four files: `mjengo-backup.sh` (the script —
read its header, it is the canonical contract), `mjengo-backup.service`
+ `mjengo-backup.timer` (the systemd pair, same least-privilege pattern
as the jobs pair in §7.3) and `mjengo-backup.env.example` (paths +
retention policy — **no secrets**, so `0644` is fine). One run:
`.backup` the DB online → integrity-check the snapshot → tar+gzip the
photo and website volumes → sha256 sidecars → refresh the weekly set on
the first run of each ~7-day window → prune by age. It deliberately
reads only the single DB file from the database directory, so
`db/ratelimit.db` is excluded **by construction**, never by
configuration that can rot.

```bash
# once per host: the dedicated service user (skip if the jobs pair
# already created it — §7.3):
useradd --system --user-group --home-dir /nonexistent \
        --shell /usr/sbin/nologin mjengo
install -D -m 0755 deploy/backup/mjengo-backup.sh  /usr/local/bin/mjengo-backup.sh
install -D -m 0644 deploy/backup/mjengo-backup.service /etc/systemd/system/
install -D -m 0644 deploy/backup/mjengo-backup.timer   /etc/systemd/system/
install -D -m 0644 deploy/backup/mjengo-backup.env.example /etc/mjengo/backup.env
install -d -o mjengo -g mjengo -m 0700 /var/backups/mjengo
# docker compose only — let the backup user read the volume data (the
# files belong to the container's `node` user; the d: default ACL keeps
# NEW files readable too; bare-metal self-hosts need nothing — the app
# itself runs as mjengo). Find your mountpoints first:
#   docker volume ls --format '{{ .Name }}' | grep -E 'app-db|app-photos|website-data'
#   docker volume inspect mjengo-os_app-db --format '{{ .Mountpoint }}'
setfacl -R -m  u:mjengo:rwX /var/lib/docker/volumes/mjengo-os_app-db
setfacl -R -m d:u:mjengo:rwX /var/lib/docker/volumes/mjengo-os_app-db
setfacl -R -m  u:mjengo:rX  /var/lib/docker/volumes/mjengo-os_app-photos
setfacl -R -m d:u:mjengo:rX /var/lib/docker/volumes/mjengo-os_app-photos
setfacl -R -m  u:mjengo:rX  /var/lib/docker/volumes/mjengo-os_website-data
setfacl -R -m d:u:mjengo:rX /var/lib/docker/volumes/mjengo-os_website-data
# edit /etc/mjengo/backup.env: set the three source paths for YOUR
# deployment (compose defaults assume a clone dir named mjengo-os) and
# retention if you want something other than 7 daily / 4 weekly, then:
systemctl daemon-reload
systemctl enable --now mjengo-backup.timer     # the TIMER, not the service
systemctl start mjengo-backup.service   # first run by hand — then check:
journalctl -u mjengo-backup.service     # the run's artifact list
ls -l /var/backups/mjengo/daily/ /var/backups/mjengo/weekly/
```

Operating notes:

- **Cadence:** daily at 04:30 local (`OnCalendar=*-*-* 04:30:00`,
  `Persistent=true` — a host that was down fires the missed run at next
  boot). The backup is online; 04:30 is a quiet window, not a
  maintenance window. `--dry-run` prints the full plan without writing.
  **The daily tick is also the lead-loss bound (issue #151):**
  `submissions.json` keeps only the **500 most recent** entries (§6.3),
  so a lead that arrives *and* is evicted between two runs exists in no
  backup at all — with daily runs that takes a >500-submission burst
  inside 24 h (the `[contact] submission cap reached` log line is the
  signal to retrieve immediately, §6.3). Back up **at least as often
  as your §6.3 retrieval cadence**, and run the service by hand after
  any burst: `systemctl start mjengo-backup.service`.
- **Failure is observable by design:** any failure (unwritable target,
  missing source, integrity check not `ok`, a photo written mid-tar…)
  exits non-zero with one `[mjengo-backup] FAILED …` line to stderr —
  under the timer that is a FAILED unit in the journal. Point an uptime
  monitor at the unit (dead-man switch: alert when the last successful
  run gets old) — nothing in-tree pages anyone yet.
- **Known honest failure mode:** `tar` exits 1 if a file changes while it
  is being read ("file changed as we read it") — an upload or a contact
  submission racing the run fails it ON PURPOSE rather than ship a torn
  archive. Re-run; the next daily timer tick self-heals.
- **PII (issue #151 — and the Kenya DPA 2019 angle):** the website
  archive contains `submissions.json` — plaintext lead PII (name,
  email, phone, message). Artifacts are written `0600` by the dedicated
  `mjengo` service user into the `0700` backup dir; treat the backup dir
  (and any off-host copies — take them!) with the same care as the live
  file. Concretely — the same spirit the repo already tracks for worker
  PII under the Kenya Data Protection Act 2019 (SECURITY.md); this is
  the self-host posture, not legal advice:
  - **Retention is bounded by design.** The 7-daily/4-weekly prune is
    the PII expiry: a lead leaves the backup tree at most ~28 days
    after its newest archived appearance. Raise the retention numbers
    only with that trade-off in mind, and date any off-host copies so
    they inherit the same clock.
  - **Access stays narrow.** Root + the `mjengo` user only — no
    group/world bits, and never park archives on shared drives, tickets
    or chats where the live file would not go.
  - **Erasure requests hit the live file first.** `submissions.json`
    is the system of record — edit/delete there (the §6.3 retrieval
    path is also the write-back path: pipe the corrected JSON back
    with `docker compose exec -T website sh -c 'cat >
    /app/data/submissions.json' < leads.json`). Backup copies age out
    on the retention clock above; when a request cannot wait that
    long, destroy the affected archives *together with their `.sha256`
    sidecars* rather than rewriting a tar by hand.
- The sandbox-level drill of the whole chain (including a live WAL
  writer and a restore): `docs/audit/RESTORE_DRILL_2026-09-18.md`.

#### 7.2.2 Restore runbook (drill it before you need it)

A backup that has never been restored is a hope, not a backup. This
runbook was executed once at script level on a scratch host — exact
commands and outputs in `docs/audit/RESTORE_DRILL_2026-09-18.md`. After
installing §7.2.1, run one full drill on YOUR hardware (the sandbox
drill could not bring up the compose stack; that part is deliberately
left as the operator's step).

**The WAL rule (governs every step).** A live SQLite database is up to
THREE files on disk: `custom.db` plus its `custom.db-wal` and
`custom.db-shm` sidecars. Never plain-copy, `rsync`, or "sync" any of
them while the app runs — the copy can capture a half-written page or a
detached WAL and restore as corruption. Backups are produced by
sqlite3's online `.backup` (which folds the WAL into one standalone
file); restores place exactly such a file. Hand-copying is only safe
after the app is stopped.

**What is in the backup set — and what is not.**

- `app-db` → `mjengo-db-<TS>.db`: the DB snapshot only.
  `db/ratelimit.db` is **never** backed up (cache-like — see the bullet
  above) and must **not** be restored: let the app recreate it. A
  restored one would resurrect stale throttle/lockout state for zero
  benefit.
- `app-photos` → `mjengo-photos-<TS>.tar.gz`: the uploads volume
  (photos are evidence).
- `website-data` → `mjengo-website-<TS>.tar.gz`: contains
  `submissions.json`, plaintext lead PII — and because of the 500-entry
  cap (§6.3), backups may be the ONLY surviving copy of early leads.
  The archive is PII too (issue #151): store/encrypt off-host copies
  accordingly.
- optional `app-docs` → `mjengo-docs-<TS>.tar.gz` if you enabled it.

**Order of operations.** (`<TS>` = the UTC timestamp in the artifact
names; `<project>` = your compose project name = clone dir name, e.g.
`mjengo-os`.)

0. **Verify the artifact before trusting it.** A checksum mismatch is
   the moment to stop, not to improvise:

   ```bash
   cd /var/backups/mjengo/daily      # or weekly/ for a deeper set
   sha256sum -c mjengo-db-<TS>.db.sha256 \
                mjengo-photos-<TS>.tar.gz.sha256 \
                mjengo-website-<TS>.tar.gz.sha256
   # any mismatch → do NOT use this set; step back to the previous
   # daily/weekly set (that is what retention is for)
   ```

1. **Stop the writers** — the app and anything else touching the
   volumes (the backup script is NOT one of them; it only reads):

   ```bash
   docker compose stop app jobs-tick    # restoring website-data too? add: website
   # bare metal: systemctl stop mjengo-app
   ```

   NEVER `docker compose down -v` here — `-v` **deletes the volumes**
   you are about to restore into (it is the fast way to turn a restore
   into a total loss).

2. **Restore the DB volume.** Find the volume's host path with
   `docker volume inspect <project>_app-db --format '{{ .Mountpoint }}'`:

   ```bash
   # docker compose (1000:1000 = the container's `node` user):
   install -o 1000 -g 1000 -m 0644 mjengo-db-<TS>.db \
     /var/lib/docker/volumes/<project>_app-db/_data/custom.db
   # bare metal: install -o mjengo -g mjengo -m 0644 mjengo-db-<TS>.db /srv/mjengo/custom.db

   # CRITICAL — remove any stale sidecars left by the OLD (dead) database.
   # A fresh main file + a foreign -wal is the classic silent-corruption
   # trap (demonstrated in the drill transcript):
   rm -f /var/lib/docker/volumes/<project>_app-db/_data/custom.db-wal \
         /var/lib/docker/volumes/<project>_app-db/_data/custom.db-shm

   # integrity-check BEFORE starting anything — must print: ok
   sqlite3 /var/lib/docker/volumes/<project>_app-db/_data/custom.db 'PRAGMA integrity_check;'
   ```

   Do not restore `ratelimit.db` (see above) — its absence is expected;
   the app recreates it on boot.

3. **Restore the volume tars:**

   ```bash
   tar -C /var/lib/docker/volumes/<project>_app-photos/_data   -xzf mjengo-photos-<TS>.tar.gz
   tar -C /var/lib/docker/volumes/<project>_website-data/_data -xzf mjengo-website-<TS>.tar.gz
   # extract as root to keep the archived ownership, or follow with:
   #   chown -R 1000:1000 /var/lib/docker/volumes/<project>_{app-photos,website-data}/_data
   # (bare metal: chown to the app user instead)
   ```

4. **Start:** `docker compose up -d` (or `systemctl start mjengo-app`).

5. **Verify:**

   ```bash
   curl -fsS https://your-host.example/api/health
   # → 200 {"ok":true,"db":"up",…,"counts":{"projects":…,"workers":…,"notifications":…}}

   # row counts, straight from the file (compare with your pre-incident
   # numbers — or with the counts in the health reply above):
   sqlite3 /var/lib/docker/volumes/<project>_app-db/_data/custom.db \
     'SELECT count(*) FROM Project; SELECT count(*) FROM Worker; SELECT count(*) FROM User;'
   ```

   Then spot-check one recent project's evidence photos render (an
   image that 404s means the photos tar is from a different date than
   the DB — re-do step 3 with the matching `<TS>`; every artifact of
   one run shares its timestamp) — and that **the leads file reads back
   through the site's own path (issue #151)**:

   ```bash
   docker compose exec website cat /app/data/submissions.json   # the §6.3 retrieval command
   ```

   It must parse as JSON and end with a recent `ts`; an empty or missing
   file means the website tar is stale for this `<TS>` or was extracted
   without the `chown` above.

6. **Aftermath:** the restored snapshot is now the live DB — trigger a
   fresh backup immediately (`systemctl start mjengo-backup.service`)
   to re-seed the retention window, and write down what the incident
   was while it is fresh.

If the app will not start, or `integrity_check` is anything but `ok`:
stop, re-verify the checksums, fall back to the previous daily/weekly
set, repeat from step 1. If no set verifies: STOP — do not start the
app on top of unknown state; that is the moment to get help with the
raw disk in hand, not to improvise.

### 7.3 Background jobs scheduler

Background jobs (anomaly scan, weekly digest, ledger reconciliation,
overdue check — `src/backend/modules/jobs/service.ts`) are drained by
`POST /api/jobs/run`. Nothing inside the app schedules that call — the
drain is deliberately an HTTP endpoint so any scheduler can own the
cadence. Pick **one** of the wirings below; they all just POST the
endpoint on an interval.

**The token.** A scheduler cannot hold a NextAuth session, so the
endpoint accepts a machine credential *in addition to* the
contractor/admin session (both paths stay live; the session path is
byte-identical to the pre-token behavior):

```bash
curl -X POST https://your-host.example/api/jobs/run \
  -H "Authorization: Bearer $JOBS_RUN_TOKEN" \
  -H 'Content-Type: application/json' -d '{}'
```

`JOBS_RUN_TOKEN` is a shared secret generated with
`openssl rand -hex 32`; the same value must reach the app **and** the
scheduler. **Unset = the bearer path is disabled entirely** — no default
token, no fallback: the endpoint then answers only to contractor/admin
sessions, exactly as before. A presented-but-invalid token gets
`401 {"error":"Invalid jobs token"}` (the secret itself is never echoed
back).

**Option A — docker compose sidecar (`jobs-tick`).** The compose stack
ships a busybox sidecar that POSTs `http://app:3000/api/jobs/run` over
the compose network (no proxy, no TLS needed) every 5 minutes. Enable it
by setting `JOBS_RUN_TOKEN` in `.env`: the app reads it via `env_file`,
the sidecar via compose interpolation — one file feeds both sides.
`docker compose up -d`, then watch it with
`docker compose logs jobs-tick`: a tick logs only failures (successful
drains are silent, like a cron); what actually ran is visible in the
Intel "Background jobs" card or via `GET /api/jobs/run`. Without the
token the sidecar still runs but every tick fails closed with a logged
401 — its startup banner explains the fix. Cadence: 5 minutes
(`sleep 300`), 50× under the endpoint's 10/min rate limit.

**Option B — systemd timer (bare-metal self-host).** `deploy/systemd/`
ships the pair `mjengo-jobs.service` + `mjengo-jobs.timer` (plus
`mjengo-jobs.env.example`):

```bash
# once per host: the dedicated, no-login service user (issue #197 —
# the unit never runs as root):
useradd --system --user-group --home-dir /nonexistent \
        --shell /usr/sbin/nologin mjengo
install -D -m 0644 deploy/systemd/mjengo-jobs.service /etc/systemd/system/
install -D -m 0644 deploy/systemd/mjengo-jobs.timer   /etc/systemd/system/
install -D -m 0600 deploy/systemd/mjengo-jobs.env.example /etc/mjengo/jobs.env
# edit /etc/mjengo/jobs.env (URL + JOBS_RUN_TOKEN), then:
systemctl daemon-reload && systemctl enable --now mjengo-jobs.timer
```

`OnCalendar=*:0/5` fires on the 5-minute grid (same cadence as the
compose sidecar) with `Persistent=true` — a host that was down fires one
catch-up drain on the next boot, which is safe (see idempotency below).
`curl -fsS` turns a 401/5xx into a failed unit: `journalctl -u
mjengo-jobs.service` shows both the failure and each drain's
`{ok, ran, results}` reply. The secret lives only in the root-only
`/etc/mjengo/jobs.env` (chmod 600), never in the tracked unit files.

The service runs as the dedicated `mjengo` system user under a full
sandboxing block (`NoNewPrivileges`, `ProtectSystem=strict`,
`PrivateTmp`, `PrivateDevices`, empty `CapabilityBoundingSet`, syscall /
address-family / namespace filters — see the unit file). Two deliberate
properties, so nobody "fixes" them backwards:

- `/etc/mjengo/jobs.env` **stays `root:root`, chmod 600** — the systemd
  manager (PID 1) reads `EnvironmentFile=` and passes the values into
  the service's environment; the `mjengo` user never opens the file, so
  no ownership change is needed (and none should be made).
- The unit has **no `ReadWritePaths=`** — it only POSTs and prints the
  JSON reply to stdout (→ the journal); under `ProtectSystem=strict`
  the whole filesystem is read-only for it, which is exactly right for
  a curl oneshot. `IPAddressDeny=`/`IPAddressAllow=` are likewise unset
  because `MJENGO_JOBS_URL` may legitimately point at a remote host; on
  a same-host install you may add `IPAddressDeny=any` +
  `IPAddressAllow=localhost`.

Measured with `systemd-analyze security --offline` (systemd 257):
exposure **9.4 UNSAFE** before (root, no sandboxing) → **1.2 OK** after.
The observable drain behavior is unchanged — same journal lines, and a
401/5xx still fails the unit (curl's non-zero exit), keeping the
fail-closed contract intact.

**Option C — any external cron.** Anything that can POST with a header
works: a host crontab, cron-job.org, a GitHub Actions scheduled
workflow, a k8s CronJob:

```bash
*/5 * * * * curl -fsS -X POST https://your-host.example/api/jobs/run \
  -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' -d '{}'
```

**Vercel Cron caveat:** it only issues GET requests (its `CRON_SECRET`
can add a bearer header, but the method is fixed) while the drain is
POST-only by design — on Vercel you would need a thin GET wrapper route
(not shipped) or an external POST-capable scheduler.

**Security model.**

- The token is a shared secret that grants, for this one endpoint, what
  a contractor/admin session grants there: enqueueing and draining jobs.
  It grants **no read access** — `GET /api/jobs/run` stays session-only.
  Treat it like a password: 64-hex random, no default, never in git (it
  lives in `.env`/process env and the scheduler's config only).
- Comparison is constant-time (`crypto.timingSafeEqual` over
  length-matched buffers — `src/backend/lib/jobs-token.ts`). Comparing
  lengths first leaks the token's *length* (not its content) to a timing
  observer: the standard trade-off of that approach.
- The endpoint stays rate-limited: valid bearer calls pass through the
  same 10 runs/min bucket as session calls (for token calls the bucket
  key is the caller's IP-derived principal — the compose sidecar's
  direct internal call carries no cookie and no `x-forwarded-for`, so it
  lands in the shared `anon` bucket; 1 tick / 5 min leaves 50× headroom).
  Invalid tokens 401 before the bucket, exactly as session 401s always
  did.
- Repeated/overlapping ticks are safe — jobs are idempotent from the
  scheduler's perspective (`src/backend/modules/jobs/service.ts`): a
  drain only picks `queued`/`retrying` rows whose `runAt` is due;
  `done`/`failed` rows are never re-run; a failed handler retries with
  exponential backoff (2 → 8 → 30 min) and lands terminally `failed`
  after 3 attempts, keeping `lastError` on the row (the row itself is
  the dead letter). A missed or duplicated tick costs queue latency,
  never double work — modulo the narrow find-then-update race covered by
  service.ts's "single drain process" honesty note, which the 5-minute
  cadence (with 90–150 s call timeouts) makes practically unreachable.
  Note the scheduler also drives *retries*: without it, a `retrying` row
  waits for the next manual drain.
- **Rotation:** generate a new value → put it in the app's env and
  restart the app (`docker compose up -d` recreates app + sidecar; for
  systemd, edit `/etc/mjengo/jobs.env` and restart the app unit) → the
  next tick uses it. A few 401s during the swap are harmless — rows wait
  in the queue. Rotate on suspected leak or staff turnover; there is no
  automatic expiry (add a calendar reminder, or wrap the token in your
  secret manager's rotation if you use one).

**Daraja pending-intent reconciliation (`wallet.reconcile`).** The drain
also carries the M-Pesa STK safety net (issue #34): an STK initiation
whose Safaricom callback never arrives would leave the payment intent
pending forever, so every pending initiation seeds a `wallet.reconcile`
job row (due at `DARAJA_RECONCILE_AFTER_MIN`, default 2 min) and each
sweep re-probes unsettled intents every `DARAJA_RECONCILE_INTERVAL_MIN`
(default 5) until they settle or pass `DARAJA_RECONCILE_MAX_AGE_MIN`
(default 60). The sweep re-drives the **same callback processor** the
real webhook uses — it never posts money through a second path: the
query API (`stkpushquery`) is still the gate, the dedupe is still
`CheckoutRequestID` + the durable `daraja.callback:<id>` record + the
ledger idempotency key, so a sweep racing a late callback is always a
no-op on the losing side. Unmapped query results keep the intent
pending (never a credit); past max-age the intent stays pending and the
payment request stays approved for a re-initiation. With the whole
Daraja block unset, no intents exist and the sweep seeds nothing — the
default deployment is unchanged. Watch it in the jobs card or
`GET /api/jobs/run` (result JSON: scanned / probed / credited /
unverified / followUpAt). The webhook route itself accepts an optional
source-IP allowlist (`DARAJA_ALLOWED_IPS`, see §3) checked before the
body is parsed — the unguessable path + query-API reconciliation remain
the always-on integrity model.

**Initiate-timeout residual risk (issue #211) — recorded and alerted,
never silently lost.** If the STK push HTTP call itself fails without
an answer (10s timeout / network error / unreadable 2xx body),
Safaricom may STILL have accepted the push and the customer may still
confirm it — but the `CheckoutRequestID` (the only key the callback and
the sweep can ever match) was never learned. For that outcome-unknown
class the wallet service records, at initiation time, an
*unresolved-initiation* row (`daraja.unresolved:<attempt>:<request>` in
the same idempotency store: request code, amount, payer, failure line).
The sweep deliberately cannot resolve these rows (`stkpushquery` keys on
the checkout id); a later verified-success callback for such a checkout
still posts **nothing** (fail-closed — no invented credit), but it is no
longer silently ignored: the server log gets a `console.warn` with the
checkout id / receipt / amount, and when the payer MSISDN matches an
unresolved initiation, the candidate project's finance audience gets a
`payment.orphaned` notification naming the candidate request.
**Operator path:** reconcile against the M-Pesa portal, then record the
payment manually (or re-issue) — automatic crediting of an unmatched
checkout is a deliberate never. Definitive initiation failures (a real
HTTP rejection) write no row: no push went out, so no money can move.

**Escrow projection drift alarm (`reconciliation`, issue #212).** The same
drain now carries the escrow safety net: `EscrowWallet.balance` is a cached
projection, the `ESCROW:<projectId>` ledger entries are the source of truth
(spec §39), and until #212 the only thing that ever compared them was a
human opening the Money tab. The `reconciliation` job now ALSO sweeps every
escrow wallet (cross-project) comparing the derived ledger sum (the #144
SQL aggregates) against the stored projection — **read-only**: the check
never writes wallets or ledger rows; it only records its findings on the
`JobRecord` (per-project `derivedCents` / `projectedCents` / `driftCents` /
`consistent`, cents as decimal strings — drifted wallets first, bounded to
10 entries + a `projectsOmitted` count so the result column's 2000-char cap
never truncates the JSON; **alerting is not bounded** — every drifted wallet
gets its event) and raises the alarm. Scheduling is
piggybacked, deliberately: `POST /api/jobs/run` keeps one `reconciliation`
row on the books — every call seeds a fresh row iff no queued/retrying one
exists and the newest is older than `RECONCILIATION_CHECK_INTERVAL_MIN`
(default 1440 = daily), so ANY drain wiring above (sidecar, timer, cron)
runs the check on that cadence with zero new infrastructure, and a manual
`{type: "reconciliation"}` POST can never double-book (the seed's dedupe
sees the queued row). Empty installs (no projects) seed nothing. When
`|drift| ≥ ESCROW_DRIFT_ALERT_CENTS` (default 1 cent — the chip's
exact-equality convention): one `escrow.drift` DomainEvent on the drifted
project and **in-app notification rows for both the finance and contractor
audiences** (the notification center's "Money" group, red triangle-alert
icon); while drift persists, each scheduled run re-alerts (daily by
default). Healthy runs are quiet by design — nothing is emitted, and the
job's result JSON is the durable all-clear record (the Intel "Background
jobs" card summarizes it, e.g. `Ledger consistent · escrow 0/1 wallet(s)
drifted`). **Operator path when it fires:** open the Money tab (the chip
shows derived vs projected), audit recent escrow writes plus the
`DomainEvent` / `AuditEvent` trails for the project, and repair the
projection through the normal money flows — the alarm never mutates money
itself.

## 8. Updating a deployment

Release checklist before pulling any update onto a deployment (issue #215
made the money check a single command):

```bash
bun run lint && bunx tsc --noEmit   # quality gates — 0 errors
bun run test:finance                # the money-invariant release gate
                                    #   (pre-release money check — §5)
bun run test                        # the full suite (superset of the gate)
bun run test:coverage               # the full suite + critical-module
                                    #   coverage floors (issue #185 — §5)
```

```bash
git pull && docker compose up -d --build   # Docker path — rebuilds BOTH images
                                           # (app + website); migrations run on boot
# or, bare metal:
git pull && bun install && bunx prisma generate && bun run build \
  && bunx prisma migrate deploy && systemctl restart mjengo
```

CI guarantees the gate before this ever reaches production: lint, strict
typecheck (build fails on TS errors — `ignoreBuildErrors` is gone), a real
`next build`, and a real `docker build` on every PR.

## 9. Object storage (S3 / R2 / MinIO)

Photo evidence (site photos, delivery photos) used to live on the app
server's local disk — fine for one box, broken the moment you run more than
one instance behind a load balancer (instance A's `public/photos` is
invisible to instance B). The upload module has a **storage driver
seam** (`src/backend/lib/storage/`) with two drivers, and since the driver
**read/re-sign seam** landed, BOTH transport directions go through it:
uploads (photos AND documents), extraction reads, and presigned-GET
re-signing:

| Driver | Selected when | Files land | Public URL | Presigned flow |
|---|---|---|---|---|
| `local-disk` (default) | any of the five required `S3_*` values is unset/blank | `public/photos/<key>` + `public/docs/<key>` on the app server | `/photos/<key>` and `/docs/<key>` (served by Next) | no — honest 409 from `/api/upload/presign` and `/api/upload/re-sign` |
| `s3-compat` | **all five** set: `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | `s3://<bucket>/<key>` (path-style; documents under `docs/`) | `S3_PUBLIC_BASE/<bucket>/<key>` when set; otherwise a presigned GET (7-day SigV4 maximum — see below) | yes |

Fail-closed: a **partial** env set is treated as unset — one server warning
naming the missing keys (names only, never values), local-disk behavior.
`S3_ENDPOINT` examples: `https://s3.eu-central-1.amazonaws.com` (AWS),
`https://<account>.r2.cloudflarestorage.com` (R2, region `auto`),
`http://minio.internal:9000` (MinIO). SigV4 is implemented with
`node:crypto` — no new dependencies.

### 9.1 The two upload paths

**Server-mediated (unchanged, works on every driver):** the client POSTs the
photo to `/api/upload` as it always did; the route validates caps + magic
numbers and writes through `getStorageDriver().put()`. With local-disk this
is byte-identical to every prior release (same key shape `upp-*`, same
`/photos/<key>` URL, same response contract). With the S3 driver the bytes
land in the bucket and the response URL is the driver's public URL.

**Presigned client-direct (new, S3 driver only):** the photo never detours
through the app server — no ~5.4 MB base64 envelope per 4 MB photo:

```
client                    app                         object storage
  │                        │                                │
  │ POST /api/upload/presign                                │
  │  { contentType,        │ mints server-generated key     │
  │    sizeBytes,          │  upp-<ts>-<hex>.<ext>          │
  │    category }          │ + SigV4 presigned PUT (5 min)  │
  │◄───────────────────────┤ { uploadUrl, key, expiresSec,  │
  │                        │   headers: {Content-Type} }    │
  │                                                        │
  │ PUT uploadUrl (bytes, Content-Type) ──────────────────►│ object stored
  │                                                        │
  │ POST /api/upload/confirm                               │
  │  { key, category }     │ HEADs the object via the      │
  │                        │ driver: exists? ≤ 4 MB?       │
  │                        │ image content-type?           │
  │                        │ → creates the Attachment row  │
  │◄───────────────────────┤ { ok, attachment: { id,       │
  │                        │   storageKey, fileName,       │
  │                        │   category, reviewStatus } }  │
```

`/api/upload/presign` answers **409** on the local-disk driver with an
honest error ("server-mediated upload only") instead of pretending.
`/api/upload/confirm` verifies before it records: existence, the 4 MB cap,
and the image `Content-Type` (whatever the client's PUT carried — the
presign response told it exactly which header to send). The Attachment row
is created at `reviewStatus: 'pending'`, exactly like every other upload
path (humans review; AI never auto-approves).

**Document uploads are driver-mediated too (the former scope cut, closed):**
`POST /api/upload { mode: 'document' }` passes the active driver into the
documents service — local-disk writes the exact historical `public/docs/`
layout (`docs/<name>` key, row `storageKey` `/docs/<name>`, byte-identical
behavior), an S3-backed deployment PUTs the document into the bucket under
`docs/` and records the driver's public URL. Extraction
(`/api/ai/extract-document`) reads the bytes back through the same seam
(the driver's `read`), so documents stored in the bucket extract exactly
like local ones — including rows whose recorded URL is an expired presigned
GET: the driver resolves the recorded key and mints a fresh short-lived URL
for the read.

### 9.2 The presigned-URL expiry tradeoff (choose per deployment)

`Attachment.storageKey` is the URL the frontend renders. With
`S3_PUBLIC_BASE` set it is **stable forever** — set it whenever the bucket
(or a CDN in front of it) is publicly readable. Without it, the driver's
public URLs are **presigned GETs that expire after 7 days** (the SigV4
maximum): rows recorded today stop resolving next week. That is an
operational choice, not a bug to code around — and it now has a
**mitigation**:

**`POST /api/upload/re-sign`** (session-guarded like the other upload
routes, project-scoped): body `{ attachmentIds: string[] }` (1–50 cuid
ids) → the route checks the caller can SEE each attachment the same way
the photo replay path (`/api/project` → supply slice) does — client-role
sessions are pinned to their own project (own rows and delivery-linked
rows only; anything else is a fail-closed 403, and one bad id blocks the
whole batch), owner roles mirror `/api/project`'s any-project posture —
then resolves each row's recorded `storageKey` back to a driver key and
mints a **fresh presigned GET (15 minutes)**:

```json
{ "ok": true, "expiresSec": 900, "urls": [{ "attachmentId": "…", "url": "https://…?X-Amz-Expires=900…" }] }
```

Honest failures instead of pretending: 409 on the local-disk driver (its
public URLs never expire — there is nothing to re-sign), 404 naming
unknown ids, 409 when a row's `storageKey` was written by a different
storage backend (the local→S3 migration case — re-upload those files).
The recorded `storageKey` is NEVER rewritten: Attachment rows are
append-only evidence, the re-sign is transport-only, and the re-signed URL
is deliberately short-lived because it is a bearer capability (a render
window, not another week). With `S3_PUBLIC_BASE` set you do not need this
endpoint at all — it still answers (the driver can presign either way), it
is just pointless.

**Known follow-up (honest scope):** the frontend does not call this endpoint
yet — components render `storageKey` as-is, so a private-bucket deployment
still needs the UI wiring (render-time re-sign for stale URLs) to fully
benefit; the API seam itself is complete and pinned by tests.

### 9.3 Self-host local path (nothing to do)

Single-box self-hosts keep the default: leave the whole `S3_*` block unset.
Uploads write `public/photos/` exactly as before; in a **frozen production
build** `public/` is snapshotted at build time, so runtime-written photos
still need a persistent volume for that directory (the historical caveat —
unchanged, and one more reason multi-instance deploys should switch to the
S3 driver).

### 9.4 Multi-instance note

Running >1 app instance? Set the five `S3_*` values so file storage stops
being the thing that breaks: every instance PUTs to and reads from the same
bucket, and the client-direct presigned flow removes the upload bandwidth
from the app tier entirely.

The rate limiter and login lockout have a real **single-host** answer
(W3-b, issue #33) — and since issue #158 it is the DEFAULT, not an opt-in:
with `RATE_LIMIT_STORE` unset (or `sqlite`), every process on that host
shares ONE SQLite store (WAL journal, busy-timeout, `BEGIN IMMEDIATE`
around every read-modify-write): a bucket exhausted on instance A is
exhausted on instance B, and the 5-strike login lockout trips no matter
which process served the failures. The semantics are the same the
in-memory store pins in tests — same key formats, same continuous
token-bucket refill, same lockout lifecycle.

```bash
# nothing to set — this IS the default. Optional knobs:
# RATE_LIMIT_SQLITE_PATH=db/ratelimit.db   # keep it next to custom.db, same volume
# RATE_LIMIT_STORE=memory                  # opt OUT (single-process dev only):
#                                          # per-process counters, the historical behavior
```

One boot log line states which store is live — `[rate-limit] store: sqlite
(db/ratelimit.db) — shared per host, multi-process safe` (or the memory
line with the opt-out hint). Check it after a deploy: a memory line you did
not choose means the sqlite init failed and the honest warning is right
above it.

Honest requirements and limits of that path:

- **Runtime must be node** — the store is `better-sqlite3`, a native addon
  the Bun runtime **crashes** on (verified on Bun 1.3.x). The Docker CMD
  (`node server.js`) is fine; the loader detects Bun and falls back to
  memory with one warning instead of crashing.
- **Docker: one COPY line** — the module is loaded dynamically
  (createRequire — invisible to the bundler's standalone tracing), so the
  Dockerfile's runner stage COPYies it explicitly
  (`COPY --from=builder /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3`,
  present since issue #158 made the store the default). A hand-rolled image
  without that line still boots — it logs one fallback warning and stays
  in-memory. `bun install` in the builder downloads the platform prebuild
  (prebuild-install; node:20-slim has no compile toolchain, so a
  GitHub-releases-blocking proxy needs a mirrored artifact).
- **Same host only.** One shared file on one filesystem — put it on the
  same volume as `DATABASE_URL` (default `db/ratelimit.db` → `/app/db/`
  in Docker). Do **not** point it at the Prisma database; the file is
  disposable (delete while stopped = reset all limits/lockouts) and is
  deliberately excluded from backups.
- **Fail-safe posture:** any init failure (module missing, unwritable
  path — e.g. a read-only filesystem or CI container — or a bad value)
  logs ONE warning and degrades to the in-memory stores — rate limiting
  never prevents boot. Runtime store failure fails OPEN with a warning
  (an unavailable optional store must not wedge every request behind
  429s).

**Multiple hosts** (a real load-balanced cluster, ≥2 machines): a shared
SQLite file does not cross machines — that still needs the Redis
implementation of the same store seams (`INCR`+`TTL`, or a Lua token
bucket for the exact continuous-refill semantics), deliberately not built:
no Redis dependency exists in this repo. Until then, an N-host deployment
honestly means per-host shared state, not global state.

### 9.5 Honest scope notes

- **Document extraction on PDFs** reads the text layer **server-side**
  (`src/backend/lib/pdf-text.ts`, zero-dependency best-effort parser:
  FlateDecode content streams, Tj/TJ text operators, object-stream page
  trees) — no client `ocrTextHint` is required anymore; a supplied hint
  still wins. Honest limits: it is NOT OCR — scanned/image-only PDFs
  (empty text layer) and encrypted PDFs return the same explicit 400 the
  route has always returned for unusable PDFs (upload an image or supply
  a hint); CID/Type0 fonts are decoded best-effort. The extraction stays
  draft-only (Attachment extraction fields, human review gate) and is
  capped like a hint (8 MB in, 100 k chars out).
- **Document uploads** are driver-mediated (see §9.1): the local-disk layout
  is byte-identical to the historical `public/docs/` write, S3-backed
  deploys store documents in the bucket under `docs/`, and extraction reads
  back through the driver seam (which is what unlocked this — extraction
  needed a read seam, not just a put seam). The land module's parcel documents
  (`/documents/<projectId>/<name>` storage keys on `ParcelDocument` rows)
  are a separate, older path and are deliberately untouched.
- A row whose recorded `storageKey` was minted by a DIFFERENT driver than
  the active one (local→S3 migration) honestly fails: re-sign answers 409,
  extraction reports the stored file as missing. The fix is operational —
  re-upload the affected files — not a guessed key.
- The frontend wiring for `/api/upload/re-sign` (render-time re-sign of
  stale private-bucket URLs) is the documented follow-up (§9.2); the API
  seam itself is complete.
- The legacy `/api/upload` data-URL photo path creates **no Attachment row**
  (historical contract — its URL is consumed by the AI photo flow); the
  presigned flow is the one that records rows (that is the point of
  `confirm`).
- `confirm` is **not idempotent**: Attachment rows are append-only evidence
  (same posture as the rest of the app); confirming one key twice records
  two rows pointing at the same object.

## 10. Observability (logs and the error sink)

### 10.1 Structured logs (`LOG_FORMAT`, issue #204)

The backend logs through the ONE seam `src/backend/lib/log.ts` — one line
per event, `log.error/warn/info(scope, message, fields?)`. Two formats:

| Format | When | Shape |
|---|---|---|
| `json` | **production default** (`NODE_ENV=production`) | one JSON object per line — `{"ts","level","scope","msg", "requestId"?, "ip"?, "route"?, "method"?, …fields}` — for `docker logs` / journald / any aggregator |
| `text` | everywhere else (dev/test) | the historical human line `[scope] message rid=<id>` + raw args |

Override explicitly with `LOG_FORMAT=json|text` (read per emit — no restart
needed beyond the env change reaching the process). Every request gets a
requestId: minted or honored from a validated inbound `x-request-id` header,
echoed on the response, attached to every log line under the request, and
SHARED with the audit ledger rows (one id per request). Background job
drains mint their own `drain-<uuid>` so one drain is one greppable unit.
The client IP is logged only when `TRUST_PROXY` is set (an untrusted
`x-forwarded-for` is a client-seeded lie — omitted, not logged); query
strings are never logged (share tokens ride in `?query`).

### 10.2 The error sink (`ERROR_SINK_URL`, issue #202 / audit OBS-1)

**Honest default: UNSET = journal-only.** The current default behavior is
UNCHANGED by this feature — errors land in the structured log lines (and,
for jobs, the `JobRecord.lastError` column) and nothing external is
contacted. `captureError()` is then a no-op that warns ONCE per process
(never per call) that the sink is inactive.

When `ERROR_SINK_URL` is set, the capture sites wired in v1 — the route-kit
default error path, the jobs drain failure path (alongside `lastError`), and
the three webhook route catch blocks (ussd, whatsapp, daraja) — additionally
POST one JSON payload per error to your collector:

```
{ "ts": "…", "service": "mjengo-os", "environment": "prod-1",
  "scope": "api/wallets POST", "requestId": "…", "route": "…", "method": "POST",
  "error": { "class": "Error", "message": "…", "stack": "…", "internal": false },
  "context": { "jobType": "wallet.reconcile", "jobId": "…", "attempts": 2 } }
```

Contracts (all unit-pinned in `tests/unit/error-sink.test.ts`):

- **Fail-open, never-throws, never-blocks** — `captureError` is synchronous
  and returns before the POST leaves; the POST is detached behind a 5s
  AbortController bound. A down/hung/slow collector cannot fail or delay a
  response or a job drain.
- **No secrets on the wire** — the `safeErrorMessage` discipline extended to
  the wire: internal errors (Prisma/framework class names, `P####` codes,
  multi-line messages) ship a redacted placeholder message and **no stack**
  (stacks leak absolute build paths). The client IP is never sent. Caller
  context fields are identifiers (`jobType`, `jobId`, …), redact-walked.
- **No retry storm** — one POST attempt per captured error; failures
  (non-2xx, timeout, network) warn once in the journal with the error class
  or HTTP status only (never the URL) and are dropped. The journal line is
  the durable record either way.

v1 is deliberately provider-agnostic (a plain webhook — point it at a relay
you own, a Slack/Discord hook bridge, or any HTTP collector); a Sentry-class
adapter can be built later behind the same seam. **Known limitation:** the
v1 routes with custom error mappers (the `/api/v1/*` family) and the events
service's notify-failure catches are not yet wired — they migrate
mechanically (`captureError(e, { scope })` alongside their `log.error` line).
