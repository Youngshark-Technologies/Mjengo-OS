## Problem

The repository has **no load/performance testing of any kind**: no k6/autocannon/artillery/locust scripts, no benchmark harness, no latency baselines (verified 2026-10-01: `rg -il "k6|autocannon|artillery|locust"` across tests/, scripts/, deploy/, docs/ → no tooling). The 3,647-test suite proves *correctness*; nothing measures *capacity*.

## Why it matters

The product posture is field-first (site devices on poor connectivity, photo uploads, offline outbox drains, USSD/WhatsApp webhooks). Performance characteristics that matter here are precisely the ones untested code never reveals:

- `/api/sync` outbox drain bursts (a site crew coming back online after hours offline)
- photo upload confirm + perceptual-hash + extraction pipeline under concurrency
- SQLite WAL write contention on concurrent ledger/inventory mutations (single-writer reality of the chosen engine)
- webhook handling latency for M-Pesa Daraja callbacks (provider timeout windows are finite)
- p95/p99 on guarded reads as project/evidence rows grow

Mission-level consequence: capacity claims in DEPLOYMENT.md remain qualitative ("single-node self-host") with no numbers behind them, and SLOs (mission §27) cannot be established — not invented — without a baseline.

## Current behavior

Nothing measures throughput, p50/p95/p99, error rate, DB latency, or WAL contention. No regression control for performance (mission §31 loop has no entry point).

## Expected behavior (incremental, honest)

1. **Phase A (no infra needed):** a repeatable local benchmark script (autocannon or k6 against a locally built standalone server + seeded SQLite) covering: `/api/health`, one guarded read, one auth flow, outbox `/api/sync` drain, and one ledger write path. Output: a committed `docs/performance/BASELINE.md` with the machine context stated (so numbers are reproducible-in-shape, not absolute).
2. **Phase B (staging):** same harness against docker-compose.staging with realistic photo volumes; record WAL checkpoint behavior under sustained writes.
3. **Phase C:** SLO proposal derived from observed data (NOT aspirational numbers) + a perf-regression gate for the money paths (budgeted threshold, fail the run on breach).

## Acceptance criteria

- [ ] Benchmark harness committed and runnable with one command from a clean checkout.
- [ ] `docs/performance/BASELINE.md` with per-endpoint numbers + stated machine context.
- [ ] At least the SQLite single-writer contention question answered with data (concurrent ledger writes: throughput + queue depth).
- [ ] SLO draft derived from measurements, filed as the follow-up.

## Dependencies / honest constraints

- Phase A is runnable in CI-adjacent environments but CI itself is billing-locked (#98) — first scheduled run needs the unblock.
- Numbers from a sandbox/host are context-specific by nature; the deliverable is the *harness + method + relative regression control*, not absolute capacity claims.
- Database-engine ceiling note: SQLite's single-writer model is a documented, deliberate architecture choice (DEPLOYMENT.md §7); the benchmark quantifies where that ceiling bites, it does not relitigate the ADR.
