## Problem

The project versions its software everywhere **except** the one place that makes a version immutable and consumable:

- `package.json`: `"version": "0.2.5"`
- `docs/RELEASE-NOTES.md`: narrates v0.1.x → v0.2.5 wave by wave
- `ARCHITECTURE.md`, `DEPLOYMENT.md`: reference released capability waves

…but `git tag` returns **zero tags**, and the GitHub Releases API returns **zero releases** (verified 2026-10-01: `git tag | wc -l` → 0; `gh release list` → empty).

## Why it matters

1. **No rollback anchor.** DEPLOYMENT.md's self-host posture (build-on-host *or* pull-by-digest via `publish.yml` → GHCR) needs an immutable ref to mean "v0.2.5". Today "v0.2.5" is only a string in a manifest; any future commit can silently redefine it.
2. **No consumer-facing artifact.** RELEASE-NOTES.md is written for recruiters/investors/operators — but there is nothing to *link*; a Release page is the product-facing surface for exactly that audience.
3. **Deploy/rollback runbooks reference versions that cannot be resolved.** "Roll back to the previous release" is not currently executable.

## Current behavior

Tags: none. Releases: none. Version lives only in `package.json` + prose docs.

## Expected behavior

- Every documented version (at minimum v0.2.5 retroactively, then v0.3.0 onward) has a git tag `vX.Y.Z` on the exact main SHA that shipped it.
- Each tag has a GitHub Release whose notes are derived from `docs/RELEASE-NOTES.md` (plain-language section) + the engineering wave summary.
- A short convention note in CONTRIBUTING.md or DEPLOYMENT.md: tags are cut from `main` only, `v`-prefixed semver, matching `package.json`.

## Acceptance criteria

- [ ] `v0.2.5` tag exists on the SHA that carried the v0.2.5 wave (`2520d9b` or the SHA that closed the audit wave — confirm via `git log`).
- [ ] GitHub Release for v0.2.5 exists with notes from RELEASE-NOTES.md.
- [ ] Convention documented for future releases.
- [ ] Next release (v0.3.0) follows the convention end-to-end.

## Dependencies / Scope

- Tagging needs **no Actions** — doable today despite #98 (billing lock).
- Image digests for pull-by-digest deploys additionally require #98 unblocked (`publish.yml` has never run).
- Owner decision on retroactive-tagging older waves vs. starting clean at v0.3.0.
