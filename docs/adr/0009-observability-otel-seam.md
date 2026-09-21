# ADR 0009 — Observability phase 2: the opt-in OpenTelemetry seam (design note; implementation deliberately deferred)

- **Status:** Accepted (design only — **no OTel code, dependency or config ships in this decision**; phase 1, the auth-gated `/api/metrics` Prometheus endpoint, IS shipped via issue #205)
- **Date:** 2026-09-24
- **Issue:** [#205](https://github.com/Youngshark-Technologies/Mjengo-OS/issues/205) — audit finding **OBS-3** (P3); sibling finding **OBS-5** (trace-worthy spans)
- **Deciders:** Backend engineering (task 4-WAVE-B)
- **Related:** `GET /api/metrics` (phase 1, this issue — `src/app/api/metrics/route.ts`); `src/backend/lib/health-queries.ts` (the shared-query seam); issue #202 / `ERROR_SINK_URL` (the same opt-in, env-gated, fail-open posture this ADR copies); issue #204 / `LOG_FORMAT` (the structured-log seam); issue #217 / `docs/runbooks/MONITORING.md` (the outside-in checks); ADR 0002 (Supabase phase-2 — where a hosted collector would live); the 2026-09 integration audit baseline §5 ("Metrics — NONE", "Tracing — NONE" — removed 2026-09-21; the honest baseline this wave started from)

## Context

Issue #205 asks for metrics/tracing in two phases:

1. **Phase 1 (shipped):** an auth-gated `GET /api/metrics` in Prometheus
   text format, derived from the queries `/api/health` already runs —
   db probe latency, job rows by status, uptime, build info — behind a
   dedicated `METRICS_TOKEN` bearer credential (constant-time compare,
   fail closed). This needed no new dependency: the text exposition
   format is a few `# HELP`/`# TYPE` lines, and the signals already
   existed.
2. **Phase 2 (this ADR):** tracing — OpenTelemetry spans around the
   wallet/webhook/job surfaces, exported over OTLP.

The audit's own honesty note applies to phase 2 with full force: **there
is no trace consumer today.** The deployment posture is a single-node
self-host (DEPLOYMENT.md §7); the shipped observability stack is
structured logs (#204), an opt-in error-sink webhook (#202), the health
probe + gated detail (#164), and now the metrics scrape (#205) — all
journal-first, all zero-dependency, all opt-in. Shipping an OTel SDK +
collector wiring with nobody to receive the spans would add a dependency,
boot cost and a config surface whose only observable effect is "nothing
happens" — the exact anti-pattern the repo's opt-in seam pattern exists
to avoid.

## Decision

**Defer the implementation until a real consumer exists; record the seam
now so the eventual work is a translation, not a redesign** (the same
move MONITORING.md §4 made for the jobs-watch script → alert-rule
upgrade path).

The seam, when it is built:

1. **The gate is `OTEL_EXPORTER_OTLP_ENDPOINT`.** Unset (the default) =
   **zero behavior change** — no SDK import, no initialization, no export,
   no new logs. This is byte-for-byte the posture of `ERROR_SINK_URL`
   (#202) and `METRICS_TOKEN` (#205): the env var IS the opt-in, and
   "unset = the feature does not exist" is the contract.
2. **The registration point is `src/instrumentation.ts`** — the Next.js
   server-boot hook that already owns boot-time assertions (the SQLite
   `PRAGMA foreign_keys` check, issue #135). When the endpoint env is
   set, `register()` dynamically imports the OTel Node SDK, initializes
   it against the endpoint, and wires the span-creation helpers. Dynamic
   import keeps the SDK out of every bundle and every runtime that does
   not opt in (the edge-runtime exemption pattern already lives there).
3. **First span surfaces (OBS-5's list):** wallet/payment execution, the
   Daraja/WhatsApp/USSD webhook ingress paths, and the background-job
   drain (`POST /api/jobs/run` + per-handler execution). These are the
   money-adjacent boundaries where a trace's causal chain (request →
   job → ledger write) answers questions a gauge cannot. The
   `requestId` from #204 becomes the natural span-correlation key —
   one request, one greppable unit, across logs and traces.
4. **Fail-open, never-throws, never-blocks** — the error-sink contracts
   (#202) carry over verbatim: an unreachable/hung collector can never
   fail or delay a response or a job drain; export failures warn once
   in the journal and drop.
5. **No new metrics families appear before an emitter exists.** Phase 1's
   families are exactly the health probe's signals; counters/histograms
   (drain duration, job attempts, webhook latency) arrive together with
   the spans that produce them, never invented ahead of use.

## Revisit triggers

Any ONE of these reopens the implementation decision:

- an operator actually runs a collector (even a laptop `otel-collector`
  for a debugging session — the env-gated seam means enabling it is one
  env var, no redeploy of code);
- the Supabase/Postgres cutover (ADR 0002) lands and the hosted
  observability story expects traces;
- the multi-instance posture (DEPLOYMENT.md §7.2's single-process note)
  is ever revisited — cross-process request flows are where logs alone
  stop being sufficient;
- a second deployment of this codebase exists (the moment "which box
  answered?" is a real question).

## Consequences

- **Positive:** the growth path is a recorded decision with a named
  registration point, a named gate and named first spans — future work
  cannot "discover" a different shape; the opt-in seam family (logs,
  error sink, metrics token, OTLP endpoint) stays coherent; zero
  dependency/boot cost today.
- **Negative / accepted:** no tracing exists, and this ADR does not
  change that — a money-flow debugging session today still means
  grepping `requestId` across structured logs (which #204 made good
  enough for the single-node posture). Anyone needing traces NOW must
  say so via a revisit trigger, not work around the ADR.
- **Phase 1 remains the only scrapeable surface:** Prometheus gauges on
  `/api/metrics` (auth-gated); the JSON `/api/health` stays the probe.
