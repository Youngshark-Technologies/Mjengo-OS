## Problem

The repository ships four GitHub Actions workflows (ci.yml, test.yml, docker.yml, publish.yml) but has **no code-scanning analysis**:

```
GET /repos/Youngshark-Technologies/Mjengo-OS/code-scanning/alerts
→ 404 {"message":"no analysis found"}
```

(verified 2026-10-01). Nothing has ever analyzed the code with a static security scanner (CodeQL or otherwise), so vulnerability classes that unit tests structurally miss (injection sinks, SSRF, regex DoS, unsafe deserialization, prototype pollution in JS deps) have no automated signal.

## Why it matters here

This is a financial construction OS: wallet, escrow, ledger, payment webhooks, USSD/WhatsApp public webhooks, document uploads with VLM extraction. The codebase already invests heavily in the right manual patterns (fail-closed guards, constant-time compares, allowlist dispatch, mutation-safety, PII scrubbing) — CodeQL is the cheap continuous checker that those patterns hold as the code evolves. `trivy` in publish.yml covers **image CVEs**; CodeQL covers **first-party code**. Neither duplicates the other.

## Current behavior

- No `.github/workflows/codeql.yml`.
- Code-scanning API: "no analysis found".
- Root dependency: Actions is billing-locked (#98) — no workflow can run until that resolves. This issue is deliberately filed now so the unblock day checklist is complete in one place.

## Expected behavior

- A `codeql.yml` workflow: `security-extended` query suite, JS/TS, analyzed on push to `main` + weekly schedule + PR diff analysis.
- First successful run after #98 unblocks; alerts triaged (this repo's audit discipline suggests: real findings become P0/P1 issues, false positives get inline suppression with justification comments).

## Acceptance criteria

- [ ] `codeql.yml` merged (can land any time — it simply won't execute until #98 resolves).
- [ ] After unblock: at least one successful `analyze` run on `main`.
- [ ] Alerts (if any) triaged into issues with severity labels.

## Security considerations

CodeQL results are security-sensitive (they describe exploitable paths). Default permissions of the workflow are read-only; alerts are visible to collaborators only. No new secrets required (GITHUB_TOKEN only), matching the repo's permission-surface discipline (see publish.yml's design note).

## Dependencies

- Hard dependency: **#98** (Actions billing unblock) for the first *run*.
- Soft dependency: #390's trivy bump is unrelated (image scanning) but lands in the same security-automation family.
