#!/usr/bin/env python3
"""Issue #395 lifecycle v2: comment-only record correction in publish.yml.

Robust against the sandbox's oscillating filesystem:
  - content read via `git show origin/main:<path>` with stabilization loop
    (repeat until two consecutive identical reads, anchors present)
  - fix applied IN MEMORY, verified by byte counts (display-proof)
  - commit built with plumbing (hash-object --stdin / read-tree /
    update-index / write-tree / ls-tree verify / commit-tree / update-ref)
  - pushed via pack protocol, verified with ls-remote
Working tree never consulted for commit content.
"""
import os
import subprocess
import sys
import time

REPO = "/home/z/my-project/repo-review"
PATH = ".github/workflows/publish.yml"
BRANCH = "fix/395-trigger-note-record"

NEW_NOTE = """# TRIGGER NOTE (corrected 2026-10-01, byte-level audit, issue #395): an
# earlier version of this note claimed the push triggers carried a birth
# typo -- a malformed branch-filter literal -- that commit 280fe0b fixed.
# Byte-precise verification (grep counts across 30e4e2c, c57c2c5, b4dfb75,
# 280fe0b, 2520d9b, plus an od byte dump of current main) shows every
# workflow in this repo has carried the correct main-branch flow-sequence
# filter since its birth commit; 280fe0b only reworded a comment. The
# malformed literal appears in NO commit's trigger line of these files.
# The real Actions blocker was and is #98 (billing lock) -- once
# unblocked, these triggers fire on real main pushes.
"""

MSG = (
    "docs(ci): correct the TRIGGER NOTE record - the claimed birth trigger "
    "typo never existed in any trigger line (byte-level audit, closes #395)\n\n"
    "280fe0b's message and this comment asserted a malformed branch filter was "
    "fixed. Byte-precise verification proves the correct filter was present at "
    "every commit (30e4e2c, c57c2c5, b4dfb75, 280fe0b, 2520d9b): count=1 "
    "correct, count=0 malformed in trigger lines, od-verified. 280fe0b only "
    "reworded a comment. The real Actions blocker is #98 (billing lock)."
)


def run(args, input_bytes=None, env_extra=None):
    env = dict(os.environ, **(env_extra or {}))
    r = subprocess.run(args, cwd=REPO, input=input_bytes, capture_output=True, env=env)
    if r.returncode != 0:
        print(f"FAIL {' '.join(args)}: {r.stderr.decode()[:600]}", file=sys.stderr)
        sys.exit(1)
    return r.stdout.decode().strip()


def stable_show(ref_path, tries=12):
    """Read content via git show until two consecutive reads agree AND anchors hold."""
    prev = None
    for i in range(tries):
        cur = run(["git", "show", ref_path]).encode()
        ok = (cur == prev and b"# TRIGGER NOTE" in cur and b"# WHY A SEPARATE" in cur
              and cur.count(b"branches: [main]") == 1)
        if ok:
            print(f"stable read after {i+1} attempt(s), {len(cur)} bytes")
            return cur
        prev = cur
        time.sleep(0.5)
    print("UNSTABLE READ", file=sys.stderr)
    sys.exit(1)


def main():
    head = run(["git", "rev-parse", "origin/main"])
    print(f"base: origin/main {head[:10]}")

    raw = stable_show(f"origin/main:{PATH}")
    fixed = (raw.replace(b"branches: ain]", b"branches: [main]")
                .replace(raw[raw.find(b"# TRIGGER NOTE"):raw.find(b"# WHY A SEPARATE WORKFLOW")],
                         NEW_NOTE.encode()))
    # re-derive anchors on RAW (indices must come from raw itself)
    start = raw.find(b"# TRIGGER NOTE")
    end = raw.find(b"# WHY A SEPARATE WORKFLOW")
    assert start != -1 and end != -1 and start < end
    fixed = raw[:start] + NEW_NOTE.encode() + raw[end:]

    # QA: counts are display-artifact-proof
    q_correct = fixed.count(b"branches: [main]")          # must be 1 (trigger)
    q_malformed = fixed.count(b"branches: ain]")          # must be 0
    q_note = fixed.count(b"# TRIGGER NOTE")               # must be 1
    q_len_delta = len(fixed) - len(raw)
    print(f"QA: correct-trigger={q_correct} (want 1), malformed={q_malformed} (want 0), "
          f"note-blocks={q_note} (want 1), bytes {len(raw)}→{len(fixed)} ({q_len_delta:+d})")
    assert (q_correct, q_malformed, q_note) == (1, 0, 1), "QA counts failed"
    # trigger line byte-identical to base
    base_trigger = [l for l in raw.split(b"\n") if b"branches: [main]" in l]
    fixed_trigger = [l for l in fixed.split(b"\n") if b"branches: [main]" in l]
    assert base_trigger == fixed_trigger, "trigger line changed!"
    print("QA: trigger line byte-identical to base ✓")

    # plumbing commit
    blob = run(["git", "hash-object", "-w", "--stdin"], input_bytes=fixed)
    back = run(["git", "cat-file", "-p", blob]).encode()
    assert back == fixed, "object-store read-back mismatch"
    print(f"blob {blob[:10]} written + read-back verified")

    ie = {"GIT_INDEX_FILE": os.path.join(REPO, ".git", "tmp-395-index")}
    run(["git", "read-tree", head], env_extra=ie)
    run(["git", "update-index", "--add", "--cacheinfo", f"100644,{blob},{PATH}"], env_extra=ie)
    tree = run(["git", "write-tree"], env_extra=ie)
    ls = run(["git", "ls-tree", tree, "--", PATH])
    assert ls.split()[2] == blob, f"tree mismatch: {ls}"
    print(f"tree {tree[:10]} verified")

    commit = run(["git", "commit-tree", tree, "-p", head, "-m", MSG],
                 env_extra={"GIT_AUTHOR_NAME": "Roy-Wanyoike", "GIT_AUTHOR_EMAIL": "roy@youngshark.tech",
                            "GIT_COMMITTER_NAME": "Roy-Wanyoike", "GIT_COMMITTER_EMAIL": "roy@youngshark.tech"})
    run(["git", "update-ref", f"refs/heads/{BRANCH}", commit, head])
    print(f"commit {commit[:10]} on {BRANCH}")

    token = open("/home/z/my-project/upload/sharkpush.txt").readline().strip()
    url = f"https://x-access-token:{token}@github.com/Youngshark-Technologies/Mjengo-OS.git"
    r = subprocess.run(["git", "push", "origin", f"refs/heads/{BRANCH}:refs/heads/{BRANCH}"],
                       cwd=REPO, capture_output=True, text=True)
    print((r.stdout + r.stderr).strip()[-300:])
    if r.returncode != 0:
        sys.exit(1)

    # verify via ls-remote (protocol-level, checksummed)
    ls_remote = subprocess.run(["git", "ls-remote", url, f"refs/heads/{BRANCH}"],
                               capture_output=True, text=True).stdout.strip()
    assert ls_remote.startswith(commit), f"remote ref mismatch: {ls_remote}"
    print(f"ls-remote verified: {ls_remote[:50]}...")
    print(commit)


if __name__ == "__main__":
    main()
