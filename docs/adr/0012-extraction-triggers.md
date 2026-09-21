# ADR 0012: Extraction triggers — the Go-core endgame and the wallet-sdk path

**Status:** accepted (2026-09-21, issue #358) — preserved from the 2026-09
architecture roadmap (removed from the repo; decision preserved here) ·
**Owner:** repo maintainer · **Review trigger:** any of the three extraction
signals below firing, a second wallet consumer appearing, or the extracted
core's runtime question being reopened (the divergence recorded in the
decision)

## Context

The 2026-09 architecture roadmap (removed from the repo; decision preserved
here) held the long-term shape decisions in three places that existed nowhere
in the kept docs: §10 "The Go question" (the extracted-core endgame and its
sequencing discipline), decision-register row D5 ("Go for
sync/wallet/integrations core — deferred with extraction signals defined"),
and §8.4 (the wallet-sdk extraction path). This ADR is the extraction of
those decisions, so removing the roadmap loses nothing.

What the roadmap planned as prerequisites has since landed, honestly: the
Phase A module layout exists as `src/backend/modules/*` (15 domains, each
service + repository + policy + types where its domain needs them), `/api/v1`
is live with its scope decided (ADR 0008), background jobs run on the DB
JobRecord table with a drain endpoint (`modules/jobs`), in-process domain
events exist (`modules/events`), and the wallet's `PaymentProvider` seam
(`providers.ts` — SimulatedProvider default, Daraja sandbox from env,
webhook + reconciliation sweep) is exactly the provider abstraction §8.5
described. The ledger remains the source of financial truth (double-entry
accounts/transactions/entries; ARCHITECTURE.md).

## Decision

**1. The endgame is an extracted core** owning sync, wallet, and
integrations — agreed for the roadmap's stated reasons: concurrency for sync
storms, financial-infrastructure discipline, operational simplicity.

**2. Sequencing discipline — a port, not a rewrite.** Working Next.js domain
logic is NOT rewritten into another runtime now: the product is
mid-feature-build, a rewrite freezes features for weeks and buys no user
value today. The module boundaries are precisely what makes a later
extraction a **port** (service interface in, extracted implementation out,
API contract unchanged) instead of a rewrite. This is also why the module
rules matter day to day: each module owns its Prisma models (no cross-module
raw `db.*` calls) and exports a service interface only — every violation
converts a future port back into a rewrite.

**3. Extraction order, gated by trigger signals** (the heart of this ADR —
none of these is scheduled work, each fires on its signal):

1. **Sync service** — when field clients multiply and sync QPS matters.
2. **Wallet/ledger** — when the second consumer or provider webhooks
   arrive.
3. **Integrations hub** — payments/SMS/WhatsApp fan-out, when the outbound
   integration count justifies owning it as one surface.

**4. The wallet-sdk path (§8.4).** The wallet module's service/repository
boundary is the future `wallet-sdk` — the same interface that other
applications (chama management, marketplace escrow) would consume. It was
built as a module with an explicit API from day one (now
`wallet/service.ts` + `repository.ts` + `providers.ts`); **extract when a
second consumer exists** — that same event is signal 2's "second consumer".

**5. Runtime note — an honest divergence to settle at extraction time.** The
roadmap's D5 named **Go** for the extracted core (concurrency for sync,
financial-infrastructure discipline). ARCHITECTURE.md's migration table
independently records "Java 25 LTS + Spring Boot modular monolith" for the
core backend, with a different trigger ("team grows beyond TypeScript; or
need for Spring's transactional tooling"). Both predate this ADR; the binding
decisions here are the **triggers** (§3) and the **port discipline** (§2) —
the extracted core's language is re-decided when a trigger actually fires,
by the ADR that supersedes this one. Preserved verbatim-in-substance from
the roadmap's §10: Python stays where ML genuinely benefits (none today —
the AI layer is API-based and stays behind the provider abstraction); Rust:
not now, not for this product's bottlenecks.

## Consequences

- Until a signal fires, extraction is deliberately unscheduled — the
  monolith keeps shipping features, and "extract X" is not a reason to
  stall a product change (but §2's module rules ARE reason to review one
  that reaches across a module boundary).
- The trigger list is now durable: field-client count / sync QPS, a second
  wallet consumer or a second provider webhook, and outbound-integration
  count are the numbers to watch, recorded here instead of dying with the
  roadmap.
- The wallet-sdk path gives the wallet module a second, external reason to
  keep its service interface clean — same discipline, two payoffs.
- When any trigger fires: write the extraction ADR (runtime, boundary,
  cutover plan) that supersedes this one. This ADR is the trigger list and
  the port discipline, not the extraction plan.
- ARCHITECTURE.md's migration table stays the kept doc's per-capability
  view; its core-backend row and this ADR's §5 name the divergence openly
  instead of silently contradicting each other.
