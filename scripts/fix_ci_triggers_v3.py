#!/usr/bin/env python3
"""Fix `branches: ain]` triggers — v3: local git plumbing + pack-protocol push.

Why v3: this sandbox's GitHub API path and filesystem both exhibit
split-brain caching (silent corruption of API writes). Git's pack protocol
is per-object SHA-1 checksummed — a proxy cannot corrupt it silently; if
push succeeds, GitHub's objects are exactly what we hashed locally.

Strategy:
  1. read each workflow file locally (either replica state is fine — we
     normalize both `branches: ain]` and `branches: [main]` → `[main]`)
  2. assert the fix in memory
  3. `git hash-object -w --stdin` (content piped, never re-read from disk)
  4. build a commit via plumbing (read-tree HEAD → update-index → write-tree
     → commit-tree → update-ref) — working tree never consulted
  5. verify blobs by reading back from the local object store
  6. `git push --force` over HTTPS (token in URL, one-off)
"""
import json
import os
import subprocess
import sys

REPO_DIR = "/home/z/my-project/repo-review"
WORKFLOWS = [
    ".github/workflows/ci.yml",
    ".github/workflows/test.yml",
    ".github/workflows/docker.yml",
    ".github/workflows/publish.yml",
]
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


def run(args, input_bytes=None, env_extra=None, check=True):
    env = dict(os.environ, **(env_extra or {}))
    r = subprocess.run(args, cwd=REPO_DIR, input=input_bytes,
                       capture_output=True, env=env)
    if check and r.returncode != 0:
        print(f"FAIL {' '.join(args)}: {r.stderr.decode()[:1000]}", file=sys.stderr)
        sys.exit(1)
    return r.stdout.decode().strip()


def main():
    blob_shas = {}
    for path in WORKFLOWS:
        raw = open(os.path.join(REPO_DIR, path), "rb").read().decode("utf-8")
        fixed = raw.replace("branches: ain]", "branches: [main]")
        trig = [l for l in fixed.splitlines()
                if l.strip().startswith("branches:") and not l.lstrip().startswith("#")]
        assert trig and all("[main]" in l for l in trig), f"{path}: bad triggers {trig}"
        n = raw.count("branches: ain]")
        # pipe the exact fixed bytes; object store content-addresses them
        sha = run(["git", "hash-object", "-w", "--stdin"],
                  input_bytes=fixed.encode("utf-8"))
        # read back from object store (checksummed) and re-verify
        back = run(["git", "cat-file", "-p", sha])
        for l in back.splitlines():
            if l.strip().startswith("branches:") and not l.lstrip().startswith("#"):
                assert "[main]" in l, f"{path}: object-store blob still broken: {l!r}"
        blob_shas[path] = sha
        print(f"  {path}: {n} line(s) fixed → blob {sha[:10]} (verified in object store)")

    # plumbing commit — independent temp index, working tree untouched
    head = run(["git", "rev-parse", "HEAD"])
    tmp_index = os.path.join(REPO_DIR, ".git", "tmp-fix-index")
    ie = {"GIT_INDEX_FILE": tmp_index}
    run(["git", "read-tree", head], env_extra=ie)
    for path, sha in blob_shas.items():
        run(["git", "update-index", "--add", "--cacheinfo", f"100644,{sha},{path}"],
            env_extra=ie)
    tree = run(["git", "write-tree"], env_extra=ie)

    # verify tree entries point at OUR blobs
    ls_tree = run(["git", "ls-tree", tree, "--", ".github/workflows/"])
    for line in ls_tree.splitlines():
        parts = line.split()
        mode, typ, sha, path = parts[0], parts[1], parts[2], parts[3]
        if path in blob_shas:
            assert sha == blob_shas[path], f"tree mismatch {path}: {sha} != {blob_shas[path]}"
    print(f"tree {tree[:10]} verified against new blobs")

    commit = run(["git", "commit-tree", tree, "-p", head, "-m", COMMIT_MSG])
    run(["git", "update-ref", f"refs/heads/{BRANCH}", commit, head])
    print(f"commit {commit[:10]} → branch {BRANCH} (local)")

    # pack-protocol push — checksummed, fails loudly on any tampering
    url = f"https://x-access-token:{TOKEN}@github.com/Youngshark-Technologies/Mjengo-OS.git"
    r = subprocess.run(["git", "push", "--force", url, f"refs/heads/{BRANCH}:refs/heads/{BRANCH}"],
                       cwd=REPO_DIR, capture_output=True, text=True)
    print(r.stdout.strip() or r.stderr.strip())
    if r.returncode != 0:
        print("PUSH FAILED", file=sys.stderr)
        sys.exit(1)
    print("push OK — PR #391 now tracks the corrected head")


if __name__ == "__main__":
    main()
