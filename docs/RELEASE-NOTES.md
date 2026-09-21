# MjengoOS — Release Notes (plain language)

What shipped, wave by wave, in words a non-engineer can follow — written for
recruiters, investors and operators. Everything listed here **exists in this
repository and is pinned by tests** (1,888 tests across 76 vitest files —
counts as of 2026-09-16; re-run vitest for the current number); nothing is
roadmap dressed up as shipped. What is deliberately simulated is listed in
[the honest small print](#the-honest-small-print).
For the engineering detail behind each wave, see [ARCHITECTURE.md](../ARCHITECTURE.md)
and the [README](../README.md).

---

## v0.2.5 — The production-readiness audit wave

A four-team audit (backend security, frontend UX, marketing website, docs &
operations) of the entire codebase, followed by fixes for every blocker it
found — tracked openly in issues #73–#84, closed by PRs #86–#92.

**Money and data safety (the blockers):**
- The database migration history had drifted behind the schema — a fresh
  deployment would have started with a broken database. Migrations are now
  complete and verified: a brand-new install comes up correct (issue #73).
- Production logins now refuse to start without a proper sign-in secret
  instead of silently falling back to an insecure one (issue #74).
- Money transfers can no longer double-pay when a phone drops offline at the
  wrong moment: retries now recognize themselves and return the original
  result (issue #75).

**Offline promise (the field core):**
- A supervisor who closes the app offline and reopens it now sees their
  project data and queued actions — not a "you're offline" card (issue #78).
- The Kiswahili translation now covers the actual field work: attendance,
  materials, the offline queue, money toasts, share links (issue #79).

**Trust surfaces:**
- The marketing website's honesty sweep: no traction claims, AI features
  marked as pilot-enabled, privacy policy now names its real service
  providers, contact channel made real (issues #81, #82).
- The app is harder to crash: any render error shows a branded recovery
  card instead of a white screen; rapid project switches can't show stale
  data; server errors now say what actually failed (issue #80).
- Backend hardening: request size caps on the last uncapped routes, loud
  warnings when webhook secrets are unset, one stuck background job can no
  longer stall the queue (issues #76, #77).
- Docs now tell the truth about CI, versions and counts (issue #83).

**The honest small print (unchanged):** M-Pesa is sandbox-only until
certification (#43), USSD is a faithful simulation until a telco deal (#40),
and native apps are deliberately deferred in favour of the PWA (#41).

---

## v0.1 — The foundation

The core product: an evidence-based construction OS for Kenya. One login
screen, seven demo roles, a 13-tab workspace covering the whole build —
phase budgets kept on a double-entry ledger (the kind of bookkeeping an
accountant can audit), escrow-backed milestones that only release against
photo proof, a procurement loop that matches purchase order ↔ supplier
invoice ↔ delivery before anyone pays, an append-only "Bias-Free Ledger"
that records every action with who/when/where, workforce attendance with
verified-vs-reported trust levels, and a `*384#` USSD line so a fundi on a
feature phone can check in without an app. Diaspora clients follow their
build through a share link — no account, and the link can be revoked.
**Why it matters:** this is the trust substrate everything later builds on —
every number a client sees traces back to evidence rows, not promises.

## v0.2 — Production posture (28 commits)

The foundation made deployable and provable. Photo/document storage moved
behind a driver seam — local disk by default, S3/Cloudflare R2/MinIO when
configured, with client-direct presigned uploads (no new dependencies:
SigV4 signing implemented with Node's own crypto). A Safaricom M-Pesa
**Daraja sandbox** provider landed behind the payment seam, with a
reconciliation sweep that re-checks payments whose callback never arrived —
money never gets invented to make a ledger look tidy. Notifications gained
preference gating and an SMS webhook seam; document extraction learned to
read PDF text server-side; transactions gained phase cost codes so budget
variance is attributed honestly (real, mixed or estimated — labeled, never
guessed); rate limiting gained an optional shared SQLite store for
multi-process deployments. And the test suite more than doubled: 495 → 899
tests, including full pinning suites for the core modules and the v1 REST
routes. **Why it matters:** the difference between a demo and a system —
deployable, observable, and every claim checkable.

## v0.2.1 — Wave 3: trust foundation (security fix, money API, MjengoScore)

Three features, one theme: trust that survives scrutiny. First, a security
review found that the offline sync path could dispatch actions for features
that had been switched off — the fix puts the flag gate on **every** mutation
path (online actions, per-item on the offline sync drain, and the share
link's allowlist), so "off" now means off, and a denied item writes nothing.
Second, the v1 REST API grew the money-governance surface: milestone release
ladders, supplier invoices with the 3-way-match verdict (PO ↔ invoice ↔
delivery), and escrow balances **derived from the ledger itself** rather than
a stored number — 19 `/api/v1` paths in total, all documented live in an
OpenAPI contract an integrator can generate an SDK from. Third, **MjengoScore**:
a deterministic 0–100 contractor trust score computed from evidence the system
already records — evidence-backed releases, verified attendance, budget pace,
variation discipline, delivery accuracy, invoice disputes. Every point of
deduction traces to countable rows; young projects get an honest "not enough
evidence" instead of a fake number; and the score deliberately gates nothing —
it describes, humans decide. Suite: 1,019 tests.

## v0.2.2 — Wave 4: diaspora proof + field reach

The wave that turns trust into a portable artifact. When a milestone releases
now, the proof **freezes**: an immutable, SHA-256-stamped "evidence draw pack"
containing the evidence photos, the ledger reference, variations open at
decision time, the attendance window and the MjengoScore at release — served
through the client's existing (revocable) share link, printable, and
forwardable to a lender who can re-verify the hash offline. Second, SMS got a
real rail: an Africa's Talking provider behind the existing notification
seam, env-gated and fail-closed (pick it or the webhook relay; with neither,
nothing pretends to send). Third, the **WhatsApp field line**: a documented
webhook contract and keyword grammar — workers text `PRESENT`, `ABSENT`,
`HALF`, `BALANCE` or free text, and real attendance and photo notes land
through the same appliers the app uses. Honest seam: no Meta Cloud API is
wired; every reply is footered "MjengoOS sim". Suite: 1,102 tests, all
browser-verified end-to-end.

## v0.2.3 — Wave 5: engagement & coverage

The retention wave, shipped and browser-verified. **Web push notifications**
(VAPID-gated through the notify seam, same honest `logged` default) keep
the diaspora client in the loop with the tab closed. The **supplier-side
portal** gives the marketplace's supply side its own scoped role and
surface — catalog, quotes, orders, delivery confirmation — closing the one
structural gap the marketing site honestly flagged. Kiswahili coverage held
key-for-key parity through every new feature. **Why it matters:** retention
for the paying persona, and two-sided liquidity for the marketplace. Suite:
1,244 tests.

## v0.2.4 — Wave 6: the AI wave (advisory, flag-gated, ledger-anchored)

The wave that put a model on top of the evidence — without ever letting it
decide anything. It started with research (a market-gap analysis over 21
web searches — the dated research doc was removed with the 2026-09-21 repo
cleanup; its actionable findings live in the tracker's roadmap registers)
and a release plan (same cleanup — the wave specs all shipped or are
tracked), then shipped four things:

1. **The AI foundation** — a provider seam (`src/backend/modules/ai/`:
   chat, vision, transcription, speech) behind a new `ai` feature flag that
   ships **DEFAULT OFF**. Flag off → the SDK is never contacted. Failures
   come back as honest, leak-free errors — never a faked analysis.
2. **AI Draw Review** — the first AI review of construction money that runs
   on evidence the platform itself hash-chained: a vision pass over a frozen
   draw pack's photos plus an LLM cross-check against its milestone, invoice
   and budget context. The output is a confidence-labeled advisory note —
   the approval click stays human.
3. **Evidence Authenticity Screen** — in the genAI era a photo is no longer
   proof; a hash-chained, cross-checked, ledger-bound photo still is.
   Perceptual-hash duplicate detection ("this photo paid for the foundation
   AND the slab") plus a vision pass for phase consistency and render
tells — every flag advisory and source-labeled rule vs AI.
4. **Diaspora Trust Digest with voice** — a weekly "what your money did"
   digest in English and Kiswahili whose every number is a ledger row (the
   text is composed deterministically — the model never authors it), read
   aloud as a voice note and served through the revocable share link.

**Verified live, not just in tests:** real model calls through the running
app — chat ~300 ms, single-photo vision ~720 ms, a real TTS voice note for
the English digest. Production measurement raised the per-call timeout cap
8 s → 20 s (multi-photo vision measured 6–8 s alone). The vision pass
correctly flagged the seeded demo photos as **render-suspect** (they are
stock renders — the AI was right); a real draw review returned an advisory
verdict ("roof trusses installed ahead of milestone scope"); the Kiswahili
digest rendered real Kiswahili text while its voice note timed out honestly
— the text survived, by design. Suite: 1,244 → 1,513 tests across 45 → 54
files. The v1 REST API also grew its Phase-D read surface (workers,
attendance, tasks, suppliers, parcels, intel, budget-variance — 21 → 29
OpenAPI paths). **Why it matters:** AI construction-finance money flows to
US lender-side automation (Built's Draw Agent) — nobody anywhere binds AI
flags to a hash-chained evidence ledger; every AI row here is advisory,
append-only, and traceable to evidence the system itself manufactured.

---

## The honest small print

- **Payment rails default to simulated.** The ledger, approval workflow,
  idempotency and reversal mechanics are real; a Daraja **sandbox** provider
  activates only when its env credentials are set. No licensed rail, no real
  money — labeled as such in the UI.
- **USSD and WhatsApp are faithful simulations** that dispatch real records
  through the real appliers; no telco gateway or Meta Cloud API is wired yet.
- **Web push is VAPID-gated** and honest — with no VAPID keys configured,
  subscriptions store intent and sends stay `logged`.
- **Land verification records evidence**; it never claims government registry
  confirmation.
- **The Wave-6 AI layer ships dark** — the `ai` flag is off until an admin
  turns it on; live AI also needs a `.z-ai-config` file (no env vars). With
  either missing, every surface shows an honest off/unavailable state and
  nothing is faked.
- **AI never approves anything** — results carry verdicts, confidence labels
  and source labels (rule vs model), gate nothing, and wait for a human. No
  model-authored number is ever stored: figures are redacted on the draw
  review, and the trust digest's text is composed from ledger rows. AI rows
  are append-only; a failed TTS leg degrades the audio, never the text.

**Test growth across the releases:** 495 (v0.2 baseline) → 899 (v0.2 merged)
→ 1,019 (Wave 3) → 1,102 (Wave 4) → 1,244 (Wave 5) → 1,513 (Wave 6). Run
the whole thing yourself: `bun run test`. Screenshots: [MjengoScore](./screenshots/mjengo-score.png) ·
[draw pack](./screenshots/draw-pack.png) · [AI draw review](./screenshots/ai-draw-review.png) ·
[authenticity screen](./screenshots/ai-authenticity.png) ·
[trust digest](./screenshots/ai-trust-digest.png).
