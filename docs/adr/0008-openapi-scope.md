# ADR 0008 — OpenAPI document scope: the v1 family + enumerated app reads; the app surface and external gateways stay documented at their seams

- **Status:** Accepted (2026-09-23)
- **Issue:** [#165](https://github.com/Roy-Wanyoike/Mjengo-OS/issues/165) — audit finding **API-14** (P3)
- **Deciders:** Backend/API engineering (task 20-b)
- **Related:** issue #28 (created the doc), #29 (honest-copy sweep), #153 (extract-document — the one deliberate non-v1 addition since, and the template for future app-read additions); audit finding **API-10** (the action-schema registry this decision's main revisit trigger depends on); ADR 0001 (mobile scope — same "scope by decision, not omission" pattern); the 2026-09 API audit baseline §2 (removed 2026-09-21; the per-route inventory this ADR pointed to)

## Context

The OpenAPI document (`src/app/api/openapi.json/route.ts`, served unauthenticated at
`/api/openapi.json`) declares itself **the SDK-generation seam**. It currently documents
**30 of the app's 60 route paths (33 of 75 method-endpoints)**:

- the 27 `/api/v1/**` read + money paths,
- `/api/audit` and `/api/reports/budget-variance` (the wave-3 app-level GETs), and
- `/api/ai/extract-document` (GET review queue / POST draft / PUT human review gate — added by #153).

Until now that scope was an **implicit** decision: a prose sentence in `info.description`,
restated in ARCHITECTURE.md, never recorded as an ADR. The audit (API-14) flagged the
risk as *drift-by-silence*: the undocumented set grows with every app feature, and unlike
the v1 family — where the audit's cross-check found **zero** documented-but-missing and
**zero** implemented-but-undocumented paths, *because both sides were enumerated* — the
app surface has no contract check at all.

The undocumented 30 paths are not homogeneous. They split into three genuinely
different kinds of surface, which is why one blanket answer ("document everything")
would be the wrong close:

1. **The app mutation surface** — `/api/actions` (every product mutation, **124 action
   types** in the `ActionType` union: 30 direct members in `src/backend/lib/mjengo.ts`
   + 94 across the 11 family consts in `src/backend/actions/*.ts`), `/api/sync` (the
   offline outbox drain — each item *is* an action), and the AI remainder
   (`analyze-photo`, `voice-log`, `parse-text`, `anomaly-scan`, `recap`,
   `authenticity-screen`). Its payload contract is **`any` at the route** (audit
   API-10): validation lives inside the domain appliers. There is no machine-readable
   payload schema to emit an OpenAPI entry *from*.
2. **The webapp-private reads and infrastructure** — `project`, `projects`, `search`,
   `share`, `supplier`, `notifications`, `flags`, `jobs/run`, `upload` family
   (`upload`, `presign`, `confirm`, `re-sign`), `push` family (`subscribe`,
   `unsubscribe`), `health`, the `/api` root, `auth/[...nextauth]`, and
   `openapi.json` itself. Their only consumer is the webapp (plus tests), whose real
   "SDK" is the repo's shared code: the `CLIENT_ACTIONS`/`SUPPLIER_ACTIONS` allowlists
   (`src/shared/`), the route-level zod `strictObject`s, and the per-route headers.
3. **The external-by-design gateways** — `/api/ussd`, `/api/whatsapp`,
   `/api/webhooks/daraja` (+ the `[secret]` callback). These have integrators
   (aggregators/relays/Safaricom) but their contracts are **served by the routes
   themselves**: `GET /api/ussd`, `GET /api/whatsapp` and `GET /api/webhooks/daraja`
   return the full live contract (body shape, grammar, identity resolution, security
   posture, rate limits) — machine-readable JSON or plain text straight from the
   endpoint being wired. Their auth models (optional HMAC signatures, an unguessable
   secret path, phone-number identity) cannot be expressed by the doc's single
   `cookieAuth` securityScheme.

## Options considered

### Option A — extend the document to the full app surface now

**Rejected for now (not forever).** Four honest blockers:

- The actions/sync family **cannot be documented truthfully yet**: an OpenAPI entry
  with `payload: object` is *less* honest than no entry — it invites SDK consumers to
  validate nothing. Hand-maintaining 124 payload shapes in the doc would drift from
  the appliers within a feature or two (the exact drift-by-silence risk, moved
  in-house). The issue itself states the extension "depends on API-10".
- The webapp-private reads would **duplicate** contracts that already live in shared
  code in the same repo — two sources, one truth, guaranteed divergence.
- The upload flow is a **three-leg choreography** (`POST /presign` → direct storage
  `PUT` on the driver's URL → `POST /confirm`); the middle leg is not an app route,
  so the doc alone could never describe a completable flow.
- The gateways' auth models don't fit the document's securitySchemes, and their
  integrators are better served by the runtime GET contracts they already have.

### Option B — a second document (`/api/openapi-app.json`) for the app surface

**Deferred.** It dodges none of Option A's blockers (the API-10 dependency dominates:
actions + sync are the majority of the app surface), and it doubles the
honesty-maintenance burden — two documents to keep honest instead of one — before the
registry that would make either emittable exists. It becomes the right answer the day
a *second consumer* (mobile client, partner integration) makes the app surface an SDK
audience; see the revisit triggers.

### Option C — record the scope as this ADR + automate the cross-check (chosen)

Convert the implicit scope into an explicit decision with a pointer table (below),
link it from `info.description` and ARCHITECTURE.md, and — the part that actually
kills the drift-by-silence risk — **automate the audit's §3 cross-check as a test**
(`tests/unit/openapi-cross-check.test.ts`): documented ⇒ implemented (per method),
implemented v1 ⇒ documented (per method), and the app-read set pinned exactly, so the
documented scope can only change deliberately.

## Decision

1. **The OpenAPI document's scope is the v1 family + the enumerated app reads** — the
   30 paths above. This is a decision, not an omission: `info.description` states it
   and links here; ARCHITECTURE.md's API section references this ADR.
2. **The app mutation surface joins only when its schemas are emittable from code.**
   `/api/actions` and `/api/sync` enter the document (or a second document) when
   audit API-10's action payload registry/zod map exists — generating path entries
   from that registry, never hand-maintaining payload shapes beside the appliers.
3. **App reads may join one at a time, by the #153 template.** The bar that admitted
   `/api/ai/extract-document`: a stable request/response contract validated at the
   route (zod or equivalent), a surface that outlives a webapp tab (an operator or
   API-facing flow), and a cross-check pin update in the same PR. Anything less stays
   on the webapp-private side of this table.
4. **The external gateways stay out and keep their runtime contracts.** `GET /api/ussd`,
   `GET /api/whatsapp` and `GET /api/webhooks/daraja` remain the machine/human-readable
   contracts for those integrators — fetched from the live endpoint they wire to.
5. **The cross-check is a CI invariant, not a per-audit ritual.** The test enforces
   both directions over the documented scope (and only that scope — the undocumented
   families are deliberately out of the doc, so the reverse check is deliberately
   v1-only).

### Where every undocumented surface's contract lives

| Surface | Paths | Machine- or human-readable contract |
|---|---|---|
| App mutations (owner + client + supplier) | `POST /api/actions` | `ActionType` union — 124 action types, each with an inline payload-shape comment — `src/backend/lib/mjengo.ts` + the 11 family consts `src/backend/actions/*.ts`; role allowlists `src/shared/client-actions.ts` + `src/shared/supplier-actions.ts`; route header (auth, tenant pins, idempotency, rate limits, flag gates) `src/backend/api/actions.ts` |
| Offline sync | `POST /api/sync` | `src/backend/api/sync.ts` header — the deterministic conflict ladder (money rows server-wins / field rows human-decides / idempotent replays / entity versions); per-item contracts = the action contracts above |
| Upload family | `/api/upload`, `/upload/presign`, `/upload/confirm`, `/upload/re-sign` | zod `strictObject`s at each handler (`upload-presign.ts`, `upload-confirm.ts`, the `re-sign` route) + mode contracts in `upload.ts` (dataUrl/photo vs document, magic-number sniff); #159's replay/409 idempotency contract |
| Push family | `/api/push/subscribe`, `/api/push/unsubscribe` | zod (W3C `PushSubscription`) + VAPID key GET in `src/backend/api/push.ts` |
| AI remainder | `/api/ai/{analyze-photo, voice-log, parse-text, anomaly-scan, recap, authenticity-screen}` | `enforceAiRoutePolicy` field/type allowlists (`src/backend/lib/rate-limit.ts`) + per-route headers; API_BASELINE §2.2 |
| Webapp-private reads + infra | `project`, `projects`, `search`, `share`, `supplier`, `notifications`, `flags`, `jobs/run`, `health`, `/api` root, `openapi.json` | API_BASELINE §2.1 — the per-route inventory (auth model, rate limit, body cap, validation, DB touch, idempotency, audit) + route headers |
| Auth | `/api/auth/[...nextauth]` | next-auth v4's own provider contract; ADR 0007 tracks the v5 migration |
| USSD gateway | `/api/ussd` | **`GET /api/ussd`** — the JSON contract (body shape, `*384#` menu grammar, PIN resolution + open-posture rules, rate limits + PIN lockout) |
| WhatsApp relay | `/api/whatsapp` | **`GET /api/whatsapp`** — the plain-text relay contract (grammar, worker resolution, timestamp policy, sim footer) |
| M-Pesa Daraja | `/api/webhooks/daraja`, `/api/webhooks/daraja/{secret}` | **`GET /api/webhooks/daraja`** — the JSON contract (callback body shape, secret-path derivation, replay dedupe, query-API reconciliation); callback handler documented in `src/backend/modules/wallet/daraja*.ts` |

## Consequences

- The document stays a **clean, small, truthful SDK seam**: every path in it is
  implementable against, every payload schema is real, and — with the new test —
  every path/method is provably backed by a route file and vice versa (v1 side).
- Every surface in the repo now has a **named contract location**; "undocumented" no
  longer means "undiscoverable".
- Adding an app read to the doc is deliberately a two-step change (doc + cross-check
  pin), which is the point: scope changes become reviewable, not silent.
- **Accepted cost:** an integrator wanting the app-mutation surface today must read
  source contracts (the action registry comments, the sync header, API_BASELINE §2),
  not a machine-readable document. Accepted while the only consumers of that surface
  are the webapp and the test suite.
- The audit's API-14 finding is closed by this decision + the test; API-10 remains
  open and is now the named dependency for the main extension trigger.

## Revisit triggers — extend the document (or ship `openapi-app.json`) when ANY of these hold

1. **API-10 lands** (the action-type/payload schema registry for `/api/actions`) —
   then generate the actions + sync paths from the registry, the difference between
   emitting ~124 payload shapes and hand-maintaining them.
2. **A second consumer of the app surface appears** — the mobile client from ADR
   0001's triggers, or any non-webapp API consumer of actions/sync/upload.
3. **A public integrator/partner program launches** — machine-readable contracts
   become a product requirement, not a convenience.
4. **The upload family grows an API-driven consumer** (e.g. programmatic document
   intake) — `presign`/`confirm`/`re-sign` already have zod schemas and would join
   by the #153 template.

None of these hold today. When one does, this ADR is superseded by the extension PR
(and the cross-check pin grows with the doc, so the honesty invariant survives the
scope change).

## Related

- `src/app/api/openapi.json/route.ts` — `info.description` links here
- `tests/unit/openapi-cross-check.test.ts` — the automated §3 cross-check
- `ARCHITECTURE.md` — API section references this ADR
- the 2026-09 API audit baseline — §2 inventory (removed 2026-09-21; the contract record for the
  webapp-private surface), §3 cross-check, §5 API-14 resolution note
