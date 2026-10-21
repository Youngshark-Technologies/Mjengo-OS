#!/usr/bin/env python3
"""File the remaining audit issues: login modernization, mobile header, 320px overflow."""
import sys
sys.path.insert(0, '/home/z/my-project/scripts')
from gh_create_issue import api, decode_escapes
import json

def create(title, body, labels):
    status, resp = api('POST', 'issues', {'title': title, 'body': body, 'labels': labels})
    if status == 201:
        print(f"CREATED #{resp['number']} {resp['html_url']}")
    else:
        print(f"FAILED {status}: {resp}")
        sys.exit(1)

create(
    "UI/UX: modernize the login screen — lg+ split-screen with a brand panel (design validated 2026-10-12)",
    """## Problem

The login screen is a single centered card on every viewport. On large screens it wastes half the canvas, carries no brand context, and the demo-credentials affordances crowd the form. A full redesign was implemented and validated on 2026-10-12 but the branch was lost in a sandbox wipe before it could be pushed; origin/main still carries the old layout.

## Expected behavior (validated spec, re-apply as-is)

- **lg+ split-screen**: left `<aside aria-hidden>` stone-950 brand panel — 34px blueprint grid (`backgroundSize:'34px 34px'`), amber glow, MjengoOS wordmark, three value props (offline-first WifiOff, photo evidence Camera, ledger integrity Landmark); right `<main aria-label>` white card with the form (Mail/LockKeyhole leading icons, amber submit with spinner, error `role="alert"`).
- **<lg**: centered card preserved (current behavior).
- Demo quickfill stays `NODE_ENV !== 'production'` only (build-time DCE) — zero prod leakage (leak-scan verified 0 on both app bundles).
- 8 new i18n keys `login.brand.*` appended at dict end (en + sw).
- Preserved contracts: exact class strings `text-[11px] text-stone-600 truncate` / `text-xs text-stone-600 px-4`, quickfill container `role="list"`, `login.queuedNote`, W1-SEC lock-message passthrough + `CredentialsSignin` mapping + reload, 8 demo accounts.

## Validation evidence from the lost implementation (reproduce on re-apply)

- aside visible at 1440, hidden at 768/390/320; 0 horizontal overflow at all four; prod E2E contractor login → post-auth Welcome; vitest 3,647/3,647; frontend-a11y + i18n suites 121/121 on the merged branch.

## Affected files
`src/frontend/auth/login-screen.tsx`, `src/frontend/i18n/dicts/en.ts`, `src/frontend/i18n/dicts/sw.ts`, website hero/CTA sign-in entry points.

## Acceptance criteria
- [ ] lg+ shows the split-screen brand panel; <lg unchanged
- [ ] a11y + i18n suites pass; full vitest green
- [ ] Prod bundle leak-scan for demo credentials = 0
- [ ] No regression in the W1-SEC lock-message contract

Priority: P2 (UX modernization, design already owner-reviewed).""",
    ["frontend", "P2-medium"],
)

create(
    "UI/UX: owner header over-packs at 375–430px — leading chip clips off the left edge",
    """## Problem

At 375–430px the app header renders 9 controls in a `justify-center` row; the row overflows and the leading chip (mode chip) paints partially off-canvas — measured clipped children at 375/390/430.

## Expected behavior

- Brand group `shrink-0` (never compressed)
- ⌘K command trigger hidden below `md`
- data-mode selector hidden below `md`
- 0 clipped header children at 320/375/390/430

## Evidence (from the lost 2026-10-12 fix, re-apply as-is)

Measured 0 clipped children at 320/375/390/430 after the fix; the fix touched only the header component's responsive classes.

## Affected files
`src/frontend/**/header` (owner/app header component).

## Acceptance criteria
- [ ] 0 clipped header children at 320/375/390/430 (browser-measured)
- [ ] ⌘K + mode selector still available at md+
- [ ] No regression at 768/1024/1440

Priority: P2 (primary surfaces on the most common Kenyan phone widths).""",
    ["frontend", "bug", "P2-medium"],
)

create(
    "UI/UX: 320px surfaces — bottom-nav camera FAB and Overview data table overflow the viewport",
    """## Problem

Pre-existing 320px overflow, found during the 2026-10-12 UI/UX audit (runtime-measured):

1. **Bottom-nav camera FAB** (fixed element) paints past the right viewport edge (right edge x≈553 at 320px viewport).
2. **Overview data table** min-content width 549px > 320px viewport — horizontal scroll escapes the page container.

## Expected behavior

- Fixed FAB stays within the viewport at 320px (clamp `right` or shrink)
- Data tables either scroll within their own container (not the page) or adapt at 320px
- `document.documentElement.scrollWidth == clientWidth` at 320px on Overview

## Reproduction
Prod build, 320×568 viewport, contractor account → Overview; measure FAB bounding rect vs `document.documentElement.clientWidth`.

## Acceptance criteria
- [ ] FAB fully on-viewport at 320px
- [ ] No page-level horizontal scroll at 320px on Overview
- [ ] No functional regression at ≥375px

Priority: P3 (smallest supported class; documented in the audit).""",
    ["frontend", "bug", "P3-low"],
)
