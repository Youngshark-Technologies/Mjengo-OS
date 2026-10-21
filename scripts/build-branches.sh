#!/bin/bash
# MjengoOS — daemon-tolerant git workflow via plumbing (no HEAD movement).
# Builds per-issue branch refs from the dirty working tree using a temp index,
# then merges each into dev with true merge commits. main is NOT touched here.
set -euo pipefail
cd /home/z/my-project

branch_from_paths() {
  local BRANCH="$1"; shift
  local MSG="$1"; shift
  export GIT_INDEX_FILE="/tmp/mjengo-index-$$-${BRANCH//\//-}"
  git read-tree dev
  # stage each path (file or dir) if it exists
  for p in "$@"; do
    if [ -e "$p" ]; then git add -- "$p"; fi
  done
  local TREE COMMIT
  TREE=$(git write-tree)
  COMMIT=$(git commit-tree "$TREE" -p dev -m "$MSG")
  git branch -f "$BRANCH" "$COMMIT"
  rm -f "$GIT_INDEX_FILE"
  unset GIT_INDEX_FILE
  echo "branch $BRANCH -> $COMMIT"
}

merge_into_dev() {
  local BRANCH="$1"
  local MSG="$2"
  local MERGED
  MERGED=$(git merge-tree --write-tree "dev" "$BRANCH")
  local TREE
  TREE=$(echo "$MERGED" | head -1)
  local CONFLICTS
  CONFLICTS=$(echo "$MERGED" | tail -n +2)
  if [ -n "$CONFLICTS" ]; then
    echo "CONFLICTS merging $BRANCH:"; echo "$CONFLICTS"; exit 1
  fi
  local COMMIT
  COMMIT=$(git commit-tree "$TREE" -p dev -p "$BRANCH" -m "$MSG")
  git update-ref refs/heads/dev "$COMMIT" "$(git rev-parse dev)"
  echo "merged $BRANCH into dev -> $COMMIT"
}

# --- per-issue branches (all file-disjoint, base = current dev) ---
branch_from_paths feat/auth-api "feat(MJG-002,MJG-003): real auth (scrypt+DB sessions, httpOnly cookie) + dashboard API computed from live records

- /api/auth/{register,login,logout,me}: org+OWNER creation transaction, 409 duplicate,
  401 no-enumeration, session cookie lifecycle
- /api/dashboard: active sites, stock value, pending deliveries, evidence awaiting,
  payments awaiting, workforce today, monthly spend, recent activity — zero hardcoded stats" \
  src/app/api/auth src/app/api/dashboard

branch_from_paths feat/api-ops "feat(MJG-004): sites, materials, inventory and milestones APIs

- org-scoped CRUD with zod validation and uniform error envelopes
- inventory movements IN/OUT/ADJUST in transactions; OUT beyond stock -> 422
- movement ledger endpoint; milestone status transitions" \
  src/app/api/sites "src/app/api/sites/[id]" src/app/api/materials src/app/api/inventory src/app/api/milestones

branch_from_paths feat/api-procurement "feat(MJG-005): suppliers, purchase orders, deliveries with human verification

- PO status FSM (DRAFT->SENT->RECEIVED/CANCELLED) with 422 on invalid transitions
- delivery verify endpoint: OWNER/SUPERVISOR only, per-item accepted quantities,
  transactional stock application + movement ledger, idempotent (re-verify -> 422)" \
  src/app/api/suppliers src/app/api/purchase-orders src/app/api/deliveries

branch_from_paths feat/api-field "feat(MJG-006): workforce, site evidence, payments APIs (human-only decisions)

- workers/assignments/attendance with transactional upserts
- evidence verify: segregation of duties (reporter cannot verify own report, 403)
- payments: OWNER-only approve + mark-paid gating; verifiedBy/approvedBy = acting user
- fix(MJG-006): include photoUrl in evidence DTO mapping (contract alignment)" \
  src/app/api/workers src/app/api/assignments src/app/api/attendance src/app/api/evidence src/app/api/payments

branch_from_paths feat/marketing-hero "feat(MJG-007): marketing landing + 17s six-scene hero animation

- hero: blueprint self-draw, materials float-in, site assembly + module chips,
  human-review scene (no AI language), orbit + progress ring, end frame with CTAs
- a11y: reduced-motion static end frame, sr-only summary, offscreen pause via useInView
- fix(MJG-007): derived effectiveScene + removed setState-in-effect (react-hooks lint)
- pillars, workflow (Record->Review->Approve->Account), CTA band, footer, top nav" \
  src/components/marketing

branch_from_paths feat/views-ops "feat(MJG-008): app shell + dashboard, sites, inventory views

- stone-950 sidebar shell with amber accents, mobile top bar + bottom tabs + sheet
- dashboard consumes live /api/dashboard (KPIs, site progress, activity feed, empty states)
- sites CRUD with status pipeline; inventory levels + movement recording dialog" \
  src/components/app src/components/views/dashboard-view.tsx src/components/views/sites-view.tsx src/components/views/inventory-view.tsx

branch_from_paths feat/views-commerce "feat(MJG-009): procurement, deliveries, payments views

- PO builder with line items + live totals; suppliers tab
- delivery review dialog with per-item accepted quantities (human step, named verifier)
- payments with OWNER-only approve/reject/mark-paid (gated UI + server enforcement)" \
  src/components/views/procurement-view.tsx src/components/views/deliveries-view.tsx src/components/views/payments-view.tsx

branch_from_paths feat/views-field "feat(MJG-009): workforce, evidence, auth views

- workers/assignments/attendance tabs with bulk attendance save
- evidence: report form, verification queue with segregation-of-duties guard,
  'Verified by <name>' (human decisions only — no AI language)
- auth: split-screen login/register with stone-950 brand panel + blueprint grid" \
  src/components/views/workforce-view.tsx src/components/views/evidence-view.tsx src/components/views/auth-view.tsx

branch_from_paths feat/spa-integration "feat(MJG-010): SPA integration — session boot, view routing, MjengoOS metadata

- page.tsx: QueryClientProvider + /api/auth/me boot (401 -> null) -> landing | auth | app shell
- layout.tsx: MjengoOS metadata + theme color; fix(EvidenceDTO): photoUrl contract field" \
  src/app/page.tsx src/app/layout.tsx src/lib/types.ts

# --- merges into dev (sequential, file-disjoint -> no conflicts expected) ---
merge_into_dev feat/auth-api        "Merge branch 'feat/auth-api' into dev (MJG-002, MJG-003)"
merge_into_dev feat/api-ops         "Merge branch 'feat/api-ops' into dev (MJG-004)"
merge_into_dev feat/api-procurement "Merge branch 'feat/api-procurement' into dev (MJG-005)"
merge_into_dev feat/api-field       "Merge branch 'feat/api-field' into dev (MJG-006)"
merge_into_dev feat/marketing-hero  "Merge branch 'feat/marketing-hero' into dev (MJG-007)"
merge_into_dev feat/views-ops       "Merge branch 'feat/views-ops' into dev (MJG-008)"
merge_into_dev feat/views-commerce  "Merge branch 'feat/views-commerce' into dev (MJG-009a)"
merge_into_dev feat/views-field     "Merge branch 'feat/views-field' into dev (MJG-009b)"
merge_into_dev feat/spa-integration "Merge branch 'feat/spa-integration' into dev (MJG-010)"

echo "=== dev history ==="
git log --oneline dev -14
