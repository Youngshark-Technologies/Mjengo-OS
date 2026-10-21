#!/usr/bin/env python3
"""Fix broken `branches: ain]` workflow triggers on Mjengo-OS via GitHub Data API.

Commits server-side (blob → tree → commit → ref → PR) to be immune to the
split-brain local filesystem. Content is normalized in-memory so it does not
matter which replica the local read hits: both `branches: ain]` and an
already-fixed `branches: [main]` converge to `branches: [main]`.
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
LOCAL = "/home/z/my-project/repo-review"
BRANCH = "fix/ci-push-triggers-main"
TOKEN = open("/home/z/my-project/upload/sharkpush.txt").readline().strip()

COMMIT_MSG = """fix(ci): push/pull_request triggers actually point at main — 'branches: ain]' birth typo in all 4 workflows

The typo existed since 30e4e2c (PR #10, Sep 2). Commit 280fe0b claimed to
fix it but only edited a comment. Consequence: push-to-main has fired no
CI/test/docker/publish runs since Sep 2 — and will still not fire after
the #98 billing unblock until this lands.

- ci.yml: push branches [main]
- test.yml: push + pull_request branches [main]
- docker.yml: push branches [main]
- publish.yml: push branches [main]"""


def gh(endpoint, method="GET", payload=None):
    """gh api wrapper: relies on GH_TOKEN env."""
    cmd = ["gh", "api", endpoint]
    if method != "GET":
        cmd += ["-X", method]
    if payload is not None:
        cmd += ["--input", "-"]
    env = dict(os.environ, GH_TOKEN=TOKEN)
    r = subprocess.run(cmd, input=json.dumps(payload) if payload is not None else None,
                       capture_output=True, text=True, env=env)
    if r.returncode != 0:
        print(f"GH FAIL {endpoint}: {r.stderr[:2000]}", file=sys.stderr)
        sys.exit(1)
    return json.loads(r.stdout) if r.stdout.strip() else {}


def normalize(path):
    """Read local file, converge trigger lines to `branches: [main]`."""
    raw = open(os.path.join(LOCAL, path), "rb").read().decode("utf-8")
    fixed = raw.replace("branches: ain]", "branches: [main]")
    # sanity: every non-comment trigger line must now be [main]
    for i, line in enumerate(fixed.splitlines(), 1):
        s = line.strip()
        if s.startswith("branches:") and not line.lstrip().startswith("#"):
            assert "[main]" in s, f"{path}:{i} still broken: {line!r}"
    n = raw.count("branches: ain]")
    return fixed.encode("utf-8"), n


def main():
    ref = gh(f"repos/{REPO}/git/ref/heads/main")
    main_sha = ref["object"]["sha"]
    print(f"main HEAD: {main_sha}")
    commit = gh(f"repos/{REPO}/git/commits/{main_sha}")
    base_tree = commit["tree"]["sha"]
    print(f"base tree: {base_tree}")

    tree_entries, report = [], []
    for path in WORKFLOWS:
        content, n_fixed = normalize(path)
        blob = gh(f"repos/{REPO}/git/blobs", "POST",
                  {"content": base64.b64encode(content).decode(), "encoding": "base64"})
        tree_entries.append({"path": path, "mode": "100644", "type": "blob", "sha": blob["sha"]})
        report.append(f"  {path}: replaced {n_fixed} broken trigger(s)")
    print("\n".join(report))

    tree = gh(f"repos/{REPO}/git/trees", "POST", {"base_tree": base_tree, "tree": tree_entries})
    print(f"new tree: {tree['sha']}")
    new_commit = gh(f"repos/{REPO}/git/commits", "POST",
                    {"message": COMMIT_MSG, "tree": tree["sha"], "parents": [main_sha]})
    print(f"new commit: {new_commit['sha']}")

    # create branch ref (create, or fast-forward if it already exists)
    cmd = ["gh", "api", f"repos/{REPO}/git/refs", "-X", "POST", "--input", "-"]
    env = dict(os.environ, GH_TOKEN=TOKEN)
    r = subprocess.run(cmd, input=json.dumps({"ref": f"refs/heads/{BRANCH}", "sha": new_commit["sha"]}),
                       capture_output=True, text=True, env=env)
    if r.returncode == 0:
        print(f"branch {BRANCH} created")
    else:
        gh(f"repos/{REPO}/git/refs/heads/{BRANCH}", "PATCH", {"sha": new_commit["sha"]})
        print(f"branch {BRANCH} updated")

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
    print(f"PR opened: {pr['html_url']}")


if __name__ == "__main__":
    main()
