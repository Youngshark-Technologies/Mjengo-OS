# ADR 0007 — next-auth v4 → v5 (Auth.js) migration: plan, interim pin, advisory watch

- **Status:** Accepted (plan only — the v5 cutover itself is **scheduled work, not executed in this PR**; see §8)
- **Date:** 2026-09-18
- **Issue:** [#173](https://github.com/Roy-Wanyoike/Mjengo-OS/issues/173) — SEC-5 (P2)
- **Deciders:** Principal engineering (task 4-a)
- **Related:** the 2026-09 security audit baseline (removed 2026-09-21; its register lives in the tracker) §12 + findings register **SEC-5**; ADR 0002 (Supabase Phase-2 identity — v5 credentials is the bridge to it); issues #74 (boot guard), #94 (dev fallback mirror), #216 (Dependabot extension to `mjengoos-website/`), #7 (proxy origin derivation); the `fix/audit2-security` wave (SEC-1/SEC-2 — same files, already on `main`)

## Context

The authentication core runs **next-auth `4.24.15` on Next `^16.1.1` + React
`^19.0.0`** (`package.json:86-94`). Honest nuance: 4.24.15's declared peer
range *nominally* admits `next ^16` / `react ^19` (a late 4.24.x widening
visible in `bun.lock`), but v4 **predates the App Router route-handler
contract** that Next 16 enforces — which is why the handler is shimmed with a
type cast exactly where signature drift would show up first:

```ts
// src/app/api/auth/[...nextauth]/route.ts:25-33
async function handler(req: Request, ctx: unknown): Promise<Response> {
  ...
  const nextAuth = NextAuth(buildAuthOptions(secureCookies)) as unknown as (
    r: Request,
    c: unknown,
  ) => Promise<Response>   // ← silences the type system on the auth hot path
  return nextAuth(req, ctx)
}
```

The v4 line is **maintenance-mode upstream**; the v5 line (Auth.js,
`next-auth@5` wrapping `@auth/core`) is the supported one for this Next
generation. Auth is the keystone of a money-moving app (escrow releases,
payment queues, wage data): an upstream breaking change or an unpatched v4
advisory would land on an integration nobody supports, hidden behind a cast.

SEC-5 was flagged "flag, don't fix" in the audit (SECURITY_BASELINE.md §12);
this ADR converts the flag into a scheduled, test-first migration plan, plus
two interim protections that land **now**:

1. **Exact patch pin** — `next-auth: "4.24.15"` (was `^4.24.15`) in
   `package.json`, so no v4 line movement can arrive unreviewed.
2. **Advisory monitoring** — `.github/dependabot.yml` (npm + github-actions,
   weekly, grouped; security advisories bypass the group and open
   immediately). This satisfies issue #173's "advisory monitoring wired for
   next-auth" acceptance criterion. It covers the root package tree only;
   **issue #216 tracks extending it to the `mjengoos-website/` package tree.**

## Inventory — every v4-coupled seam and its v5 equivalent

Verified by reading the current code (not from memory). This is the complete
surface a v5 cutover must touch; anything not in this table should not need
to change.

| # | Seam (file) | v4 today | v5 equivalent |
|---|---|---|---|
| 1 | `src/app/api/auth/[...nextauth]/route.ts` | `NextAuth(buildAuthOptions(secureCookies))` cast to `(r: Request, c: unknown) => Promise<Response>`; per-request `secureCookies` sniffed from `x-forwarded-proto` (route.ts:25-33); `warnNextAuthUrlMismatch(headers)`; `enforceNextAuthSecretAtBoot()` at module load | `export const { handlers, auth, signIn, signOut } = NextAuth(config)`; `export const { GET, POST } = handlers` — **typed for the App Router, the cast disappears**. Per-request protocol handling moves into v5 itself: `trustHost: true` derives the origin from `x-forwarded-host`/`-proto` and secure-cookie state from the protocol (replaces the manual sniff, PR #7 lineage). The URL-mismatch warning becomes a boot-time `AUTH_URL` sanity check (same failure class, checked once). Boot guard stays (see #8). |
| 2 | `src/backend/lib/auth.ts` — options builder | `NextAuthOptions` type; `CredentialsProvider` from `next-auth/providers/credentials`; `secret: process.env.NEXTAUTH_SECRET`; `useSecureCookies` per request; `session: { strategy: 'jwt', maxAge: 30d }`; `jwt`/`session` callbacks stamping `id/role/projectId/supplierId`; module augmentation for `next-auth` + `next-auth/jwt` | `NextAuthConfig` type (same callback shapes — the augmentation blocks carry over); `Credentials` provider (import path/name updated); `secret: process.env.AUTH_SECRET`; `trustHost: true`; same JWT strategy/maxAge/callbacks. **Cookie overrides must be rewritten for v5 names** (see breaking changes) keeping the `SameSite=None; Secure`-on-https / `lax`-on-http iframe policy. |
| 3 | `src/backend/lib/auth.ts:92-106` — `cookieOverrides()` | Unprefixed names `next-auth.session-token` / `next-auth.csrf-token` / `next-auth.callback-url`; `sameSite: 'none'` + `secure` when https, `lax` otherwise (iframe-preview requirement) | Same policy expressed against v5's `authjs.*` default names (`authjs.session-token`, `__Secure-authjs.session-token`, …) via `cookies.sessionToken/csrfToken/callbackUrl` overrides. Decision: **adopt v5 default names** (do not pin the old names) — see rollback notes. |
| 4 | `src/backend/lib/auth.ts:238-253` — `requireSession()` | `getToken({ req, secret: process.env.NEXTAUTH_SECRET })` | Callers move to the single guard seam (#5); or `getToken` from `next-auth/jwt` still exists in v5 (reads `authjs.*` names + `AUTH_SECRET`). Prefer `auth()` to shrink the custom-crypto surface. |
| 5 | `src/backend/lib/guard.ts:10-44` — `getSessionFromReq()` | `getToken` from `next-auth/jwt`; manual precedence `NEXTAUTH_SECRET ?? AUTH_SECRET`; then the **dev fallback-secret candidate loop** (issue #94) trying `devFallbackSecretCandidates(req)` | `auth()` from the handlers export (reads `cookies()` via `next/headers`) or a shared `decode` helper. **The fallback loop is deleted** — v5 has no internal fallback secret (it throws `MissingSecret` instead). Dev quickstart DX moves to an explicit generated dev secret (see #7). This is also where **SEC-12 dies**: v5's `AUTH_SECRET`-only precedence removes the alias split-brain (`guard.ts:15` reads the alias; `principalFor` doesn't). |
| 6 | `src/backend/lib/rate-limit.ts:88-95` — `principalFor()` | `getToken({ req, secret: process.env.NEXTAUTH_SECRET })` (alias-ignoring — the other half of SEC-12) | Reuse the guard seam from #5 (one `readSession(req)` helper for the whole backend). Same principal shape: `user:<email>` else IP else `anon`. |
| 7 | `src/backend/lib/nextauth-fallback-secret.ts` (whole file) | Golden-tested byte-mirror of v4's `createSecret`/`parseUrl`/`detectOrigin` internals, **designed to fail if v4's derivation changes** | **DELETE.** v5 has no internal fallback to mirror. Replacement dev DX: a committed `.env.development` (git-ignored) generated by a `predev` script (`openssl rand -hex 32` / bun crypto one-liner) + README quickstart line — dev secrets become real secrets by construction, and the SEC-2 "forgeable key on non-prod runtimes" class disappears entirely. |
| 8 | `src/backend/lib/next-auth-guard.ts` — boot guard (#74 / BE-2) | Fails closed at module load when `NODE_ENV=production` and `NEXTAUTH_SECRET` missing/< 32 chars; build phase exempt | **Keep the guard, rename the env**: `AUTH_SECRET`, same ≥ 32-char rule, same clear boot error. Still worth having in v5 — our fail-closed-with-actionable-message + length policy is stricter and friendlier than v5's `MissingSecret` throw. Tests: `tests/unit/next-auth-boot-guard.test.ts` ports 1:1 with the rename. |
| 9 | `src/backend/modules/{invoices,wallet,supply}/session.ts` — `currentActor()` ×3 | Each hand-rolls `parseCookieHeader` + `getToken({ req: { cookies, headers: {} } as never, secret: NEXTAUTH_SECRET })` off `next/headers()` | Collapse all three onto the single seam from #5 (`auth()` already reads `next/headers` cookies — the hand-rolled parse and the `as never` shape die). One actor-resolution function, three thin callers. |
| 10 | `src/frontend/auth/session-provider.tsx` + 10 `useSession`/`signOut` consumers (`src/frontend/mjengo/*` incl. `header.tsx`, `app.tsx`, `supplier/supplier-portal.tsx`, `settings-tab.tsx`, …; `src/shared/permissions.ts:18`) | `SessionProvider` / `useSession` / `signIn` / `signOut` from `next-auth/react` (v4) | Same import paths and hook contract in v5 — **mechanical no-op** once the server side is cut over, but every consumer must be smoke-checked because the session payload shape is enforced by our `Session` augmentation (unchanged). |
| 11 | `src/frontend/auth/login-screen.tsx:62-97` — credentials sign-in UX | `signIn('credentials', { redirect: false })` and **relies on v4 surfacing authorize-thrown messages verbatim in `res.error`** (the lockout copy "Too many attempts — locked for N min"); maps only the literal `'CredentialsSignin'` to the generic wrong-password string | v5 does **not** propagate provider-thrown messages to the client `signIn()` result by default. Redesign (contract-tested first — see Phase 1): a `CredentialsSignin`-style error code (or a thin server action wrapping `signIn` with try/catch) mapping typed errors → the same user-visible strings. **Behavior to preserve:** wrong password ⇒ generic copy; locked ⇒ the minutes-remaining copy; network ⇒ retry copy. |
| 12 | Tests — golden/canary set | `tests/unit/nextauth-fallback-secret.test.ts` (golden vs v4 internals loaded by file URL from `node_modules`); `tests/unit/share-token-entropy.test.ts` (mints cookies via `encode` from `next-auth/jwt` + literal `next-auth.session-token` name); `tests/unit/next-auth-boot-guard.test.ts`; `vi.mock('next-auth/jwt')` in `storage-document-read`, `storage-presign-routes`, `storage-resign-routes`, `push-routes` tests; `tests/e2e/*` 7-persona login paths (`helpers.ts` drives the real credentials flow) | Fates are itemized in §5. |
| 13 | Config/docs surface | `README.md` env table (NEXTAUTH_SECRET/AUTH_TRUST_HOST, :519-535), `DEPLOYMENT.md` §3 (:43-45, :495), `.env.example` (:17-34), `docker-compose.yml` (:41-45, boot-guard twin comment), `Dockerfile` (:26-53 build-time dummy), `.github/workflows/ci.yml:80` (CI dummy secret) | Rename to `AUTH_SECRET` / `AUTH_URL` / `AUTH_TRUST_HOST` everywhere, one PR, in lockstep with #8. |
| 14 | `bun.lock` | Resolves `next-auth@4.24.15` with `@panva/hkdf`, `jose@^4`, `oauth`, `openid-client`, `preact` (v4's own tree) | v5 tree: `@auth/core` (+ `@panva/jose` v5). Smaller, framework-native dependency set — one of the wins of the migration. |

**Non-seams (verified unaffected):** scrypt password hashing and the
timing-equalizer (`auth.ts:52-73` — our own crypto, provider-agnostic);
login lockout accounting (`rate-limit.ts` store resolution, trackers);
role allowlists / tenant pins (`guard.ts:89-153` — operate on the session
shape, not on next-auth APIs); `route-kit`'s documented exception for the
auth routes (own CSRF — v5 keeps its own CSRF); no `middleware.ts` exists
today (SEC-11), so v5 middleware auth is an option, not a requirement.

## Breaking-change inventory (v4 → v5)

1. **Cookie names.** `next-auth.session-token` → `authjs.session-token`
   (`__Secure-` prefix variants on https; likewise csrf/callback/pkce
   cookies). Every hard-coded name in tests (#12) and the cookie overrides
   (#3) must switch. Crypto-wise both versions wrap the same JWE scheme
   family, but **we do not assume v4-minted cookies verify under v5** — the
   plan treats cutover as a one-time global sign-out (30-day sessions
   re-login once). If a Phase-2 experiment shows byte-compatible
   verification with identical names+secret, that is a bonus, never a gate.
2. **`getToken` → `auth()`.** The canonical server-side session read becomes
   the `auth()` export; `next-auth/jwt` still exists in v5 for raw minting
   (tests) but reads the new names/env. All five call sites (#4, #5, #6, #9)
   collapse onto one seam.
3. **`AUTH_SECRET`-only precedence.** v5 reads `AUTH_SECRET` / `AUTH_URL` /
   `AUTH_TRUST_HOST` and **does not read the `NEXTAUTH_*` names**. This
   kills the alias split-brain the audit logged as **SEC-12**
   (`AUTH_SECRET` honored by `guard.ts:15`, ignored by
   `rate-limit.ts:90`, undocumented in `.env.example`) — one variable, one
   reader, one precedence. Deployments must carry the renamed vars **before**
   cutover (Phase 1 dual-set).
4. **Credentials provider changes.** Import (`Credentials` from
   `next-auth/providers/credentials`), `authorize`'s second argument becomes
   a standard `Request` (headers still `.get()` — `clientIpFromHeaders`
   survives), and **thrown messages no longer reach the client verbatim**
   (see seam #11 — the lockout UX must be re-plumbed, contract-tested first).
5. **Route handler signature.** `NextAuth(options)` returning a
   `(req, res?)` handler → `{ handlers, auth, signIn, signOut }`. **The cast
   at route.ts:25-33 is deleted** — the type system resumes guarding the auth
   hot path. Per-request cookie policy moves from our manual
   `x-forwarded-proto` sniff to v5's `trustHost` behavior.
6. **No internal fallback secret.** v5 throws `MissingSecret` instead of
   deriving one — `nextauth-fallback-secret.ts` and its golden test die by
   design (issue #173's explicit either/or: port to v5 semantics or delete;
   we delete, replacing dev DX with a generated dev secret).
7. **Type renames.** `NextAuthOptions` → `NextAuthConfig`; module
   augmentation paths (`next-auth`, `next-auth/jwt`) carry over.
8. **Beta-line churn.** v5 is still a beta line — pin the exact version at
   cutover (same policy as the v4 pin here) and re-verify the specifics
   above against the pinned version at Phase-2 kickoff; this ADR's
   mechanics are stable, exact identifiers may move.

## Decision — phased, test-first cutover

### Phase 0 — interim protection (THIS PR, 2026-09-18)

Documentation + pin + monitoring only. **No runtime behavior changes.**

- This ADR (the plan).
- `package.json`: `"next-auth": "4.24.15"` (exact pin — an upstream v4
  patch/advisory can no longer ride a caret; any bump is a reviewed PR).
- `.github/dependabot.yml`: npm (root tree) + github-actions, weekly,
  grouped minor/patch — with `next-auth` **excluded from the group** so any
  proposed bump (patch or major) is its own immediately-reviewable PR.
  Dependabot security advisories bypass groups/schedules entirely. Satisfies
  #173's advisory-monitoring criterion; `mjengoos-website/` coverage is
  tracked by #216.

### Phase 1 — prep on main, still zero v4→v5 dependency changes

1. **Contract tests first** (they define "the migration succeeded"):
   - E2E: lockout journey — 5 wrong passwords ⇒ visible "Too many attempts —
     locked for …" copy; correct-password-during-lockout ⇒ rejected; sign-out
     ⇒ session gone. Pins seam #11's UX across the rewrite.
   - Unit: boot-guard matrix (ports to the `AUTH_SECRET` rename), and the
     guarded-route 401/403 shape against a minted cookie.
2. **Unify the decode seam**: `principalFor` (#6) and the three
   `currentActor`s (#9) call `guard.getSessionFromReq` (or a sibling in
   `guard.ts`) instead of their own `getToken`s. After this, the v5 swap
   touches **one** session-decode file.
3. **Dual env bridge**: set `AUTH_SECRET` (same value as `NEXTAUTH_SECRET`)
   and, where pinned, `AUTH_URL` in `.env.example`, `DEPLOYMENT.md`,
   `docker-compose.yml`, CI and Dockerfile. v4 already accepts the alias
   (same precedence chain it documents in `guard.ts:11-14`) — behavior is
   byte-identical, and v5 will find its vars waiting. Document `AUTH_SECRET`
   in `.env.example` (also closes the documentation half of SEC-12 early).

### Phase 2 — the cutover (one atomic PR, scheduled; see §7)

1. `bun add next-auth@<pinned v5>` (exact pin, same policy as Phase 0).
2. Rewrite `route.ts` per seam #1 — handlers export, **cast deleted**,
   `trustHost: true`, cookie overrides with `authjs.*` names keeping the
   SameSite=None/https + lax/http policy.
3. Swap the single decode seam to `auth()`; delete the fallback loop in
   `guard.ts`; delete `nextauth-fallback-secret.ts` + its golden test; add
   the replacement posture test: **no `AUTH_SECRET` ⇒ every guarded route
   401s and boot fails closed in production** (v5 has no fallback; our dev
   story is the generated `.env.development` secret + `predev` script).
4. Rename the boot guard's env to `AUTH_SECRET` (#8) and its tests.
5. Re-plumb the login error surface (#11) to preserve the Phase-1 contract.
6. Update every hard-coded cookie name and `vi.mock('next-auth/jwt')`
   target in the test tree (#12); port `share-token-entropy` to mint with
   v5's `encode` + new cookie name.
7. Docs/config rename sweep (#13) + flip this ADR's Status to
   "Implemented" + update the SECURITY_BASELINE register row.

**Cutover gate (all must be green on the PR):** full unit suite · `tsc` ·
`lint` · `next build` · the 7-persona E2E against the seeded dev server ·
manual sign-in inside the iframe preview (the SameSite=None path) · a
`MissingSecret` boot check in a throwaway production-mode container.

### Rollback

- **Phase 0/1:** pure reverts (docs / pin / config); v4 keeps running
  untouched.
- **Phase 2:** single revert commit — code, tests and docs land in one PR
  precisely so rollback is atomic. Because Phase 1 dual-sets the env, a
  revert restores v4 **without any environment surgery**; the only
  user-visible artifact is that sessions minted during the v5 window die
  (one extra re-login). Rollback is a deliberate, boring non-event.
- **Do not** attempt a hybrid (v4 minting + v5 verifying) — the fallback
  mirror taught us what coupling to auth internals costs.

## Canary tests and their v5 fate

| Canary (golden) test | What it pins today | v5 fate |
|---|---|---|
| `tests/unit/nextauth-fallback-secret.test.ts` — golden family | The mirror is byte-identical to v4's own `createSecret`/`parseUrl`/`detectOrigin` (internals loaded by file URL from `node_modules`); candidate gating; real-JWE end-to-end through the guard | **DELETED with the mirror** (it fails by design the moment v4 internals change — that is its job). Replaced by: missing-`AUTH_SECRET` fail-closed tests (boot guard + guarded-route 401s) and a dev-quickstart test for the generated-secret path. |
| `tests/unit/share-token-entropy.test.ts` | Mints a session cookie via `next-auth/jwt` `encode` (literal `next-auth.session-token` name) and drives `POST /api/projects` | **KEPT, ported** — mint via v5 `encode`, new cookie name, `AUTH_SECRET`. The token-entropy assertions are auth-version-agnostic. |
| `tests/unit/next-auth-boot-guard.test.ts` | NEXTAUTH_SECRET boot matrix (missing/short/build-exempt) | **KEPT, ported** — env rename to `AUTH_SECRET`, same matrix. |
| `storage-{document-read,presign,resign}-routes`, `push-routes` tests (`vi.mock('next-auth/jwt')`) | Guarded routes 401/200 behavior with a mocked decode | **KEPT, retargeted** — mock the unified seam (`@/backend/lib/guard` or the `auth()` wrapper), not the next-auth module path. |
| `tests/e2e/*` — 7 persona golden paths | Real login form → role shell, per persona; the honest end-to-end contract | **KEPT UNCHANGED** — behavioral, framework-agnostic. This is **the** cutover gate. |
| Lockout E2E (added Phase 1) | Login lockout copy + rejection semantics | **KEPT** — the contract the v5 error-surface redesign must satisfy. |

## Timeline

| When | What | Owner |
|---|---|---|
| 2026-09-18 (this PR) | Phase 0: ADR + exact pin + Dependabot | principal-engineer (done) |
| Next wave (target ≤ 2026-09-26) | Phase 1: contract tests, seam unification, dual env | backend |
| Within 2–3 weeks (target early Oct 2026), in a low-traffic window | Phase 2 cutover + soak on preview | backend + reviewer |
| After soak | ADR status flip, SECURITY_BASELINE register close, #173 closed | principal-engineer |

Scheduling constraints (from the issue): **after** SEC-1/SEC-2 (already on
`main` — verified: `mutation-safety.ts` is wired into `rate-limit.ts`);
**before** ADR 0002's Supabase Phase-1 cutover and any real-money pilot
(one migration window is cheaper than three — coordinate with the
session-lifecycle work logged as SEC-15 in the same audit batch).

## Risk assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| One-time global sign-out at cutover (cookie names change) | Certain | Low (annoyance, not loss) | Announce; 30-day users re-login once. Optional experiment to keep old names (§ breaking changes #1) — never a gate. |
| Lockout error-copy regression (v5 error surfacing differs) | Medium | Medium (support load; masks security feedback) | Phase-1 contract tests pin the visible strings before any v5 code exists. |
| Iframe preview sign-in breaks (SameSite policy mis-ported) | Medium | High (preview unusable) | Cookie overrides are a named seam (#3); manual preview check in the cutover gate; E2E covers login but not the iframe context — the manual check is mandatory. |
| Deployment missing `AUTH_SECRET` at cutover | Medium | High (auth dead) | Phase-1 dual-set; boot guard fails **closed with a clear message** (existing #74 posture, renamed); compose `:?` guard already refuses boot without the var. |
| v5 beta churn between plan and execution | Medium | Low-Medium | Exact-pin v5 at cutover; re-verify §2 identifiers against the pinned version at kickoff (§ breaking changes #8). |
| Hidden `getToken` semantic drift in `principalFor`/`currentActor` | Low (post-unification) | Medium | Phase 1 collapses five decode sites to one before the swap; the one file gets full test coverage. |
| Migration keeps sliding (plan-only risk) | Medium | High (SEC-5 stays open) | Named Phase-1/Phase-2 dates above; SEC-5 register row tracks "planned"; the pin + Dependabot make the interim state visible, not silent. |
| Do nothing | — | High | v4 maintenance-mode advisory lands with no supported fix path on Next 16, behind a cast that hides the drift. This is the risk the whole ADR exists to retire. |

## What this PR deliberately does NOT do

- **No v5 code, no dependency swap, no cookie/env renames** — the migration
  is scheduled work (§ Timeline), per the audit's "flag, don't fix" doctrine
  and the issue's acceptance criteria ("migration executed, **or explicitly
  scheduled**"). This ADR is the explicit schedule.
- No changes to `mjengoos-website/` (issue #216 owns its Dependabot
  coverage).
- No test-suite run in this docs-only worktree (CI validates on the PR).

## Consequences

- **Positive:** the unsupported pairing gets a bounded retirement date
  instead of an open flag; the exact pin + Dependabot turn silent v4 drift
  into reviewed PRs; SEC-12's alias split-brain gets a designed death
  (v5's single-var model); five scattered session-decode sites become one;
  the v4-internals mirror (a standing maintenance liability the golden test
  exists to detect) is deleted rather than re-mirrored; the cast comes off
  the auth hot path.
- **Negative / costs:** one migration window of engineering time; a
  one-time global re-login at cutover; the login error surface needs a
  small redesign (v5 semantics); v5 is a beta line (pinned + re-verified);
  `mjengoos-website/` remains unwatched until #216.
- **Risks accepted:** sessions invalidated once at cutover; dev quickstart
  changes shape (generated secret instead of magic fallback) — README
  quickstart updated in Phase 2.

## Related

- Issue #173 (this ADR's trigger; closes on Phase-2 completion — the
  fallback-secret either/or is resolved as "delete")
- SECURITY_BASELINE.md §12 + findings register SEC-5 (P2), SEC-12 (P3 —
  resolved by the v5 env model)
- ADR 0002 (Supabase): Phase-1 keeps NextAuth as the enforcement point —
  v5 is the bridge; Phase-2 (Supabase Auth) supersedes the credentials
  provider later, unchanged by this ADR
- Issues #74 (boot guard), #94 (the fallback mirror this plan deletes),
  #216 (Dependabot for the website tree), #7 (proxy origin derivation that
  v5's `trustHost` formalizes)
- the tracker (issue #360 tracks the SEC-5 cutover delivery state)
