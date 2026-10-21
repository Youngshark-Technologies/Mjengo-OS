## Problem

Dependabot **vulnerability alerts** are disabled for this repository. The GitHub API returns:

```
GET /repos/Youngshark-Technologies/Mjengo-OS/dependabot/alerts
→ 403 {"message":"Dependabot alerts are disabled for this repository."}
```

(verified 2026-10-01 with a collaborator token).

Dependabot **version updates** ARE configured and working (`dependabot.yml`, e.g. open PR #390) — but version PRs only cover *updates to newer manifests*, not *known CVEs in pinned versions*. Without vulnerability alerts, a published GHSA against e.g. `next`, `@prisma/client`, `better-sqlite3` or any transitive dependency in `bun.lock` produces **no signal at all** until the next scheduled version bump happens to cross the fixed version.

## Why it matters here

MjengoOS is a money-moving application (wallet, escrow, M-Pesa Daraja, ledger). The codebase already treats supply-chain posture seriously (trivy severity gate in `publish.yml`, GITHUB_TOKEN-only permissions, pinned action SHAs in CI). Vulnerability alerting is the one supply-chain sensor that is currently dark, and enabling it is free for public repositories and takes one settings toggle.

## Current behavior

- `dependabot.yml` present → version-update PRs flow (proof: #390).
- Vulnerability alerts → disabled (API 403 above).
- No issue tracks alert enablement (searched open + closed: #216 covered the *absence of dependabot config*, closed when config landed; alert enablement is a distinct, still-open gap).

## Expected behavior

- Dependabot alerts enabled in repo settings.
- `GET /dependabot/alerts` returns 200 (possibly an empty list initially).
- Any future GHSA against a locked dependency surfaces as an alert + (existing) version-update PR.

## Acceptance criteria

- [ ] Settings → Code security → Dependabot alerts = enabled (owner action, no billing required).
- [ ] API check returns 200: `gh api repos/Youngshark-Technologies/Mjengo-OS/dependabot/alerts`.
- [ ] If any alerts fire on enablement: triage each into this issue's thread or separate issues (P0/P1 per severity).

## Dependencies / Scope

None. This is a settings change, not a code change; no billing requirement (public repo). Owner action.
