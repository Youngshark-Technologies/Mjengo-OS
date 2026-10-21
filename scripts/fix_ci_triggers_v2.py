#!/usr/bin/env python3
"""Fix broken `branches: ain]` triggers on Mjengo-OS — v2, SERVER-SIDE ONLY.

All content is fetched from the GitHub git data API (server truth), fixed in
memory, and written back through the API. The local filesystem is never read.
Updates branch fix/ci-push-triggers-main with a deterministic commit.
"""
import base64
import json
import os
import subprocess
import sys

REPO = "Youngshark-Technologies/Mjengo-OS"
WORKFLOWS = [
    ".github/workflows/ci.yml",
    ".github/workflows/test.yml",
    ".github/workflows/docker.yml",
    ".github/workflows/publish.yml",
]
BRANCH = "fix/ci-push-triggers-main"
TOKEN = open("/home/z/my-project/upload/sharkpush.txt").readline().strip()
os.environ["GH_TOKEN"] = TOKEN

COMMIT_MSG = """fix(ci): push/pull_request triggers actually point at main — 'branches: ain]' birth typo in all 4 workflows

The typo existed since 30e4e2c (PR #10, Sep 2). Commit 280fe0b claimed to
fix it but only edited a comment. Consequence: push-to-main has fired no
CI/test/docker/publish runs since Sep 2 — and will still not fire after
the #98 billing unblock until this lands.

Content sourced 100% from the GitHub git data API (server-side truth);
applied via blob→tree→commit plumbing for determinism.

- ci.yml: push branches [main]
- test.yml: push + pull_request branches [main]
- docker.yml: push branches [main]
- publish.yml: push branches [main]"""


def gh(endpoint, method="GET", payload=None):
    cmd = ["gh", "api", endpoint]
    if method != "GET":
        cmd += ["-X", method]
    if payload is not None:
        cmd += ["--input", "-"]
    r = subprocess.run(cmd, input=json.dumps(payload) if payload is not None else None,
                       capture_output=True, text=True)
    if r.returncode != 0:
        print(f"GH FAIL {method} {endpoint}: {r.stderr[:1500]}", file=sys.stderr)
        sys.exit(1)
    return json.loads(r.stdout) if r.stdout.strip() else {}


def main():
    main_sha = gh(f"repos/{REPO}/git/ref/heads/main")["object"]["sha"]
    base_tree = gh(f"repos/{REPO}/git/commits/{main_sha}")["tree"]["sha"]
    print(f"main HEAD: {main_sha}  base tree: {base_tree}")

    tree_entries = []
    for path in WORKFLOWS:
        # 1) fetch CURRENT blob content from the server
        meta = gh(f"repos/{REPO}/contents/{path}?ref=main")
        raw = base64.b64decode(meta["content"]).decode("utf-8")
        n = raw.count("branches: ain]")
        # 2) fix in memory — handle the whole family: ain] → [main]
        fixed = raw.replace("branches: ain]", "branches: [main]")
        # 3) hard verification in-memory
        trig = [l for l in fixed.splitlines()
                if l.strip().startswith("branches:") and not l.lstrip().startswith("#")]
        bad = [l for l in trig if "[main]" not in l]
        if bad:
            print(f"ASSERT FAIL {path}: {bad}", file=sys.stderr)
            sys.exit(1)
        print(f"  {path}: server had {n} broken trigger(s); fixed → {len(trig)} '[main]' line(s)")
        blob = gh(f"repos/{REPO}/git/blobs", "POST",
                  {"content": base64.b64encode(fixed.encode()).decode(), "encoding": "base64"})
        tree_entries.append({"path": path, "mode": "100644", "type": "blob", "sha": blob["sha"]})

    # 4) independent post-hoc check: decode back each created blob
    for e in tree_entries:
        back = base64.b64decode(gh(f"repos/{REPO}/git/blobs/{e['sha']}")["content"]).decode()
        for l in back.splitlines():
            if l.strip().startswith("branches:") and not l.lstrip().startswith("#"):
                assert "[main]" in l, f"blob {e['sha']} bad line: {l!r}"
    print("post-hoc blob verification: OK")

    tree = gh(f"repos/{REPO}/git/trees", "POST", {"base_tree": base_tree, "tree": tree_entries})
    # verify the tree really references our fixed blobs
    got = {e["path"]: e["sha"] for e in gh(f"repos/{REPO}/git/trees/{tree['sha']}")["tree"]}
    for e in tree_entries:
        assert got.get(e["path"]) == e["sha"], f"tree mismatch for {e['path']}"
    print(f"new tree verified: {tree['sha']}")

    new_commit = gh(f"repos/{REPO}/git/commits", "POST",
                    {"message": COMMIT_MSG, "tree": tree["sha"], "parents": [main_sha]})
    print(f"new commit: {new_commit['sha']}")

    r = subprocess.run(["gh", "api", f"repos/{REPO}/git/refs/heads/{BRANCH}", "-X", "PATCH",
                        "--input", "-"],
                       input=json.dumps({"sha": new_commit["sha"], "force": True}),
                       capture_output=True, text=True)
    if r.returncode == 0:
        print(f"branch {BRANCH} force-updated to {new_commit['sha']}")
    else:
        print(f"ref update failed: {r.stderr[:500]}", file=sys.stderr)
        sys.exit(1)

    # verify the branch tip content one last time
    tip_tree = gh(f"repos/{REPO}/git/commits/{new_commit['sha']}")["tree"]["sha"]
    t = {e["path"]: e["sha"] for e in gh(f"repos/{REPO}/git/trees/{tip_tree}")["tree"]}
    ok = all(t.get(e["path"]) == e["sha"] for e in tree_entries)
    print(f"branch tip content check: {'OK' if ok else 'MISMATCH'}")
    pr = gh(f"repos/{REPO}/pulls", "POST", {
        "title": "fix(ci): workflow push/PR triggers point at main — 'ain]' typo in all 4 workflows",
        "head": BRANCH, "base": "main",
        "body": """## What

All four workflows (ci.yml, test.yml, docker.yml, publish.yml) carry a birth typo in their push/pull_request branch filters:

```yaml
branches: ain]     # literal string "ain]", matches no branch (main is "main")
```

## Why it matters

- Broken since **30e4e2c (PR #10, Sep 2)** — pushes to `main` have fired **zero** CI/Tests/Docker/Publish runs since then.
- Commit **280fe0b** ("docker.yml push trigger actually points at main") only edited a **comment** — the trigger line itself was never touched.
- Issue **#98** (Actions billing lock) masked all of this: every run that did exist failed at startup anyway. Once billing is unblocked, CI would *still* not fire on main without this fix.

## Change

`branches: ain]` → `branches: [main]` in the 5 trigger locations across 4 files. No other changes.

## Verification after merge (needs #98 unblocked)

1. Push to main fires CI + Tests + Docker + Publish.
2. PRs against main fire Tests (its pull_request filter was also broken).""",
    })
    print(f"PR: {pr['html_url']}")


if __name__ == "__main__":
    main()
