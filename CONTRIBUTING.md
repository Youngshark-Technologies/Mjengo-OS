# Contributing to MjengoOS

Thanks for helping build an evidence-based construction OS for Kenya. This
guide covers the day-to-day workflow. What the product *is* lives in the
[README](./README.md); how it's built lives in
[ARCHITECTURE.md](./ARCHITECTURE.md).

## Setting up

Follow the [one-command quickstart](./README.md#quick-start) in the README:

```bash
bun install
cp .env.example .env        # set NEXTAUTH_SECRET: openssl rand -hex 32
bunx prisma generate
bunx prisma migrate deploy  # or: bunx prisma db push
bun run seed                # demo data — the DB ships empty
bun run dev                 # -> http://localhost:3000
```

The demo sign-in accounts (`contractor@mjengo.os`, `admin@mjengo.os`, …) are
**intentional seed data** created by `prisma/seed-extras/users.ts` so the full
role matrix is explorable — they are not a credential leak. Don't report them
(see [SECURITY.md](./SECURITY.md#demo-credentials-are-intentional)).

## Branches

Branch from `main` and name by intent:

| Prefix | Use | Example |
|---|---|---|
| `feat/` | new capability | `feat/ussd-attendance` |
| `fix/` | bug fix | `fix/login-lockout` |
| `chore/` | tooling, deps, repo hygiene | `chore/gitignore-hygiene` |
| `docs/` | documentation only | `docs/readme-polish` |

## Commits

Conventional commits, imperative subject, ≤ 72 characters:

```
feat(wallet): escrow release gated on photo proof
fix(sync): reject stale outbox versions (keep-server)
docs(readme): correct the Prisma model count to 61
```

## Before you open a PR

Run the same gates CI runs:

```bash
bun run lint          # eslint — 0 errors, 0 warnings
bunx tsc --noEmit     # strict typecheck, 0 errors
bun run test          # vitest — the full unit suite (3,328 tests /
                      #   154 files — counts as of 2026-09-21; re-run
                      #   vitest for the current number)
bun run test:coverage # the same suite + coverage floors (issue #185) —
                      #   what CI runs; ~11% slower than the plain run
```

All must pass locally (the coverage variant is what CI runs; the plain run
is the fast inner loop).

**The finance gate** (issue #215): `bun run test:finance` is the one-command
money-invariant release gate — the 26 suites that pin the money core
(ledger posting/reversal, wallet idempotency, escrow, Daraja
callback/reconciliation, 3-way match, the v1 money routes, the integer-cents
arithmetic) plus the fence test that keeps the gate's own file list honest
(27 files / 629 tests, ~40s — versus ~85s for the full suite).

- **Money-path PRs** (anything under `src/backend/modules/ledger|wallet`,
  `src/backend/lib/money*.ts`, the Daraja routes, `/api/v1` money routes)
  run the gate alone for a fast read, then the full suite before pushing.
- **Every release** runs it alongside the full suite — DEPLOYMENT.md §5/§8
  list it as the pre-release money check, and release notes / QA reports
  cite it as a single line: "`bun run test:finance` green at `<sha>`".
- The file list is **explicit** in `tests/finance/gate-files.ts` (with the
  qualification rules and the judgment calls documented beside it). Adding
  a new money suite is a one-line edit there; `tests/finance/gate.test.ts`
  fails loudly if a money-named test file lands without being consciously
  added to the gate or judged out with a written reason.

**Coverage floors** (issue #185): `bun run test:coverage` runs the same suite
with `@vitest/coverage-v8` — a text table in the terminal plus
`coverage/lcov.info` — and enforces **per-module floor thresholds** for the
critical seams only: the money path (wallet, ledger, supply, invoices,
`lib/money*.ts`, `lib/idempotency.ts`), the sync/outbox core
(`backend/api/sync.ts`, `frontend/lib/outbox.ts`), and the guard/auth seams
(`guard.ts`, `auth.ts`, `next-auth-guard.ts`, `membership-scope.ts`,
`shared/permissions.ts`). The full measured-coverage table, the
measured-but-not-floored judgment calls, and the floor values live beside
the config in `vitest.config.mts`.

- **Why no repo-wide floor (honesty):** `src/` also contains the app-router
  surface and large UI swaths this node-env suite exercises only via
  grep-contract tests — a global threshold would either fail the build or be
  set so low it says nothing (measured repo-wide: ~50% lines / ~38%
  branches). Floors are scoped where correctness is non-negotiable; the
  report itself still covers every TypeScript source under `src/**` (minus
  the generated `src/frontend/ui/**` scaffolding), so a whole module with
  zero tests is visible at 0%, not hidden.
- **The ratchet convention:** every floor is `floor(measured)` at the time it
  was set — today's truth, not an aspiration. When your PR *raises* a
  module's measured coverage, **bump its floor in the same PR** (the run
  prints the measured number next to the threshold). Never lower a floor
  without an issue that documents why. Vitest's
  `coverage.thresholds.autoUpdate` is deliberately off — the conscious,
  reviewed config edit *is* the convention.
- **Glob rot fails loudly:** a threshold glob that matches zero files (module
  renamed/moved) fails the coverage run, and
  `tests/unit/coverage-config.test.ts` pins the floor set, the script, the CI
  artifact step and this documentation at plain `bun run test` speed.
- CI uploads the lcov report as an artifact on every run (harmless locally:
  `coverage/` is gitignored). Until #98's billing lock lifts, jobs still
  don't start — the local run is the gate that actually executes.

**Test-count convention:** living docs (README, CONTRIBUTING, DEPLOYMENT,
RELEASE-NOTES) quote the suite size only with a date stamp ("counts as of
2026-09-16 — re-run vitest for current"); dated reports and audit baselines
(`docs/QA-REPORT-*.md`, `docs/audit/*.md`) keep the numbers that were true
when they were written. If your PR adds tests, refresh the stamped counts
— `git grep 'counts as of'` finds every site.

CI runs the same gates on every push/PR:
`ci.yml` re-runs lint and the strict typecheck (web app **and** marketing
site) plus an informational `bun audit` and a real production build;
`test.yml` runs the full vitest suite; `docker.yml` builds both production
Docker images. One honest caveat: a billing lock on the GitHub account is
currently preventing CI jobs from starting (workflows fire, jobs are
rejected), so until it is restored the local run is the gate that actually
executes — re-run the full suite before pushing.
Touching the marketing site (`mjengoos-website/`)? Also run `bun run
site:lint` and `bun run site:typecheck`.

## Pull requests

- **Small and single-purpose** — one branch, one concern. If the diff sprawls,
  split it into stacked PRs.
- **Tests land with the code, in the same branch** — new behavior is pinned
  by new tests before it merges (the suite grew 495 → 1,513 tests across
  waves 1–6, then 1,700 → 1,811 across the 2026-09-10 audit-fix wave and
  1,888 after the 2026-09-16 hardening merges — counts as of 2026-09-16,
  re-run vitest for current; every merge re-ran the full suite).
- **Linked to an issue** — open or comment on one first, so the *why* is
  recorded before the *how*.
- **Left open for review** — every change lands through a reviewed PR, never
  a direct commit to `main`; don't expect the CI badge to carry the review
  while the account's billing lock blocks job starts (the gates are re-run
  locally per PR).
- **Honest scope** — state what works, what's simulated and what's deferred.
  This repo's culture is *reported vs verified, everywhere*; PRs follow it.

## Dependency updates (Dependabot)

[`.github/dependabot.yml`](./.github/dependabot.yml) watches all three
update surfaces on a weekly cadence: the root package tree (the app), the
`mjengoos-website/` package tree (its own `package.json` + `bun.lock`), and
the GitHub Actions workflows. Minor+patch bumps arrive as one grouped PR per
tree; majors arrive as individual PRs — a major is a migration, and a
migration is reviewed on its own, never inside a weekly batch. `next-auth`
is excluded from the root group entirely (ADR 0007's exact pin: every bump,
patch or major, gets its own immediately-reviewable PR). Both trees use
Bun's text `bun.lock`, which Dependabot's npm ecosystem reads and updates
natively — no Renovate config; that evaluation and decision live in #216.

**Triage policy** (issue #216):

- **Owner:** the repo maintainer triages every Dependabot PR — the same
  single owner as SECURITY.md disclosures.
- **Cadence:** grouped weekly batches merge the week they open. Root-tree
  PRs run the full gates (`bun run lint`, `bunx tsc --noEmit`,
  `bun run test`, plus `bun run test:finance` when a money-path dependency
  moves); website PRs run `bun run site:lint` + `bun run site:typecheck`
  and a look at the rendered site — the website's lower risk (no auth, no
  money, no data paths) buys the lighter review, not looser grouping;
  Actions PRs are expected one-line tag bumps. Majors are scheduled like
  any migration, not batch-merged.
- **Advisory-flagged bumps vs SECURITY.md:** Dependabot security PRs bypass
  groups and schedules and open immediately. They are triaged on
  SECURITY.md's 72-hour clock: the patch is merged — or a wontfix is
  recorded with a compensating control — within 72 hours of the PR opening.
  (SECURITY.md's 72h promise governs inbound *reports*; this extends the
  same clock to upstream advisories Dependabot surfaces.)
- **While the #98 billing lock holds:** Dependabot PRs cost zero Actions
  minutes and keep opening, but their check runs sit pending until CI jobs
  can start — run the gates locally per PR before merging, exactly the
  same posture as every other PR right now.

## Parallel work (waves & worktrees)

Several features are often built at once, in isolation, then merged
sequentially — that is how waves 3–6 were built. The working method:

- Build each feature in its own **git worktree** off `main`
  (`git worktree add ../wt-<task> -b feat/<name>`), so parallel branches
  never step on each other's working files.
- **One feature owns one file area** per wave — the branch plan keeps file
  ownership disjoint (e.g. only one branch touches `schema.prisma`, only one
  touches the i18n dictionaries).
- When two branches must touch the same file, **append at the end** — new
  i18n keys go at the bottom of the dictionary files under a comment header,
  which keeps the merge conflict trivial.
- Re-run the full gate (lint + typecheck + tests) in the worktree before
  committing; merge with `--no-ff` and re-run the whole suite once more on
  `main` after the merge.
- External services only ever appear as **honest seams** (env-gated,
  fail-closed): no feature needs outside credentials to build or test, and
  nothing pretends to be live when it isn't.

## Security

Found something security-sensitive? **Do not open a public issue** — follow
the disclosure policy in [SECURITY.md](./SECURITY.md): GitHub Security
Advisories, coordinated disclosure, acknowledgement within 72 hours.

## License

By contributing you agree that your work ships under the repository's
[MIT license](./LICENSE).
