#!/bin/bash
# OPEN-ISSUES-06 / MJG-070: scrub daemon-junk paths from UNPUSHED git history.
# Rewrites the lineage of main + dev (tips' trees are already clean; this removes
# junk BLOBS from intermediate commits so GitHub push protection passes and the
# published history never exposes secrets or runtime data).
set -euo pipefail
cd /home/z/my-project

if [ -n "$(git status --porcelain 2>/dev/null | grep -v '^??')" ]; then
  echo "ERROR: worktree has unstaged changes; aborting rewrite" >&2
  exit 1
fi

JUNK='.env db/custom.db upload download tool-results worklog-entries server.log'

echo "=== before: junk objects in unpushed ranges ==="
git rev-list --objects origin/main..main origin/dev..dev | awk '{print $2}' \
  | grep -E '(^|/)(sharkpush\.txt|ferrix\.txt|\.env|custom\.db)$|^(upload/|download/|tool-results/|worklog-entries/|server\.log$)' \
  | sort -u | wc -l

FILTER="git rm -r --cached --ignore-unmatch -q $JUNK >/dev/null 2>&1 || true"

git filter-branch -f --index-filter "$FILTER" -- main dev

echo "=== after: junk objects in rewritten unpushed ranges (must be 0) ==="
git rev-list --objects origin/main..main origin/dev..dev | awk '{print $2}' \
  | grep -E '(^|/)(sharkpush\.txt|ferrix\.txt|\.env|custom\.db)$|^(upload/|download/|tool-results/|worklog-entries/|server\.log$)' \
  | sort -u | wc -l

echo "=== tip tree parity (must be empty) ==="
git diff main dev --stat && echo dev-parity-ok
echo "=== branches ==="
git branch | sed -n '1,6p'
echo "SCRUB COMPLETE"
