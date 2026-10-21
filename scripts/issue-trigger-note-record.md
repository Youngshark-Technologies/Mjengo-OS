## Problem

Two documentation artifacts assert that the workflow push triggers were born with a malformed branch filter and later fixed. **Byte-level verification shows that claim is false** — the correct syntax has been present since each file's birth commit. The record is wrong and will mislead future debugging (it already cost one full false-alarm investigation, see Evidence).

The artifacts:

1. `280fe0b` — commit message: *"fix(ci): docker.yml push trigger actually points at main (was a birth typo) + publish.yml pointer"*. Its actual diff: **one comment line changed in docker.yml**; the trigger line was never touched.
2. `.github/workflows/publish.yml` lines 25–29 ("TRIGGER NOTE") — claims docker.yml's push trigger *was* a malformed literal and was "fixed in the same PR as this file".

## Evidence (byte-precise, display-artifact-proof)

Verified 2026-10-01 against `origin/main` (`2520d9b`):

```
$ git show <sha>:.github/workflows/ci.yml | grep -c 'branches: \[main\]'
30e4e2c (ci.yml birth, Sep 2)  → 1
b4dfb75                        → 1
280fe0b                        → 1
2520d9b (current main)         → 1

$ git show <sha>:.github/workflows/ci.yml | grep -c 'branches: ain\]'   # the claimed malformed literal
→ 0   at every commit above

docker.yml at c57c2c5 (birth of the smoke-test version) and 280fe0b:
'branches: [main]' → 1 at both; malformed literal → 0 at both

$ git show 2520d9b:.github/workflows/ci.yml | grep 'branches' | head -1 | od -c
→ "    branches: [main]\n"   (byte dump)
```

Corroboration from runtime history: push-to-`main` CI runs **did fire** throughout Sep 2–21 (CI runs for PR #93/#96 merges, Publish runs on the #382–#389 merges) — impossible had the push filter matched no branch. Runs stopped only when Actions went billing-locked (#98, Sep 9).

## Likely origin

An authoring-tool display artifact stripped the YAML flow-sequence opener + first char from rendered tool output, making the correct filter *look* malformed to the authoring session. The same artifact class was independently reproduced and root-caused during the 2026-10-01 external review (PR #391, closed with forensics after proving the false positive).

## Current behavior

- publish.yml's TRIGGER NOTE documents a typo that never existed and a "fix" that didn't touch the trigger.
- 280fe0b's message is permanently inaccurate (history is immutable — we do NOT rewrite it; the corrected record lives here and in the file comment).

## Expected behavior

TRIGGER NOTE in publish.yml replaced with the verified record:

> TRIGGER NOTE (corrected 2026-10-01, byte-level audit): an earlier version of this note claimed the push triggers carried a birth typo that commit 280fe0b fixed. Byte-precise verification (grep counts across 30e4e2c, c57c2c5, b4dfb75, 280fe0b, 2520d9b + od byte dump) shows every workflow has carried the correct main-branch flow-sequence filter since birth; 280fe0b only reworded a comment. The real Actions blocker was and is #98 (billing lock).

## Acceptance criteria

- [ ] publish.yml TRIGGER NOTE reflects the verified record (comment-only change; no trigger lines touched).
- [ ] CI/workflow YAML still parses (`yaml.safe_load` + grep-count regression check in the PR).
- [ ] This issue closed only after the PR merges.

## Scope / Risk

Comment-only change in one file. Zero runtime impact. No tests weakened; no functional change.
