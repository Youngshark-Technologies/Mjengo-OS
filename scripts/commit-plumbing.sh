#!/bin/bash
# Generic daemon-tolerant commit: stage given paths into a temp index off a base ref,
# create a branch + merge it into dev. Usage: commit-plumbing.sh <branch> <base> <msg> <paths...>
set -euo pipefail
cd /home/z/my-project
BRANCH="$1"; BASE="$2"; MSG="$3"; shift 3

export GIT_INDEX_FILE="/tmp/mjengo-idx-$$-${BRANCH//\//-}"
git read-tree "$BASE"
STAGED=0
for p in "$@"; do
  if [ -e "$p" ]; then git add -- "$p"; STAGED=1; fi
done
if [ "$STAGED" -eq 0 ]; then echo "nothing to stage for $BRANCH"; rm -f "$GIT_INDEX_FILE"; unset GIT_INDEX_FILE; exit 0; fi

TREE=$(git write-tree)
COMMIT=$(git commit-tree "$TREE" -p "$BASE" -m "$MSG")
git branch -f "$BRANCH" "$COMMIT"
rm -f "$GIT_INDEX_FILE"; unset GIT_INDEX_FILE

MERGED=$(git merge-tree --write-tree dev "$BRANCH")
TREE_M=$(echo "$MERGED" | head -1)
CONFLICTS=$(echo "$MERGED" | tail -n +2)
if [ -n "$CONFLICTS" ]; then echo "CONFLICTS:"; echo "$CONFLICTS"; exit 1; fi
COMMIT_M=$(git commit-tree "$TREE_M" -p dev -p "$BRANCH" -m "Merge branch '$BRANCH' into dev")
git update-ref refs/heads/dev "$COMMIT_M" "$(git rev-parse dev)"
echo "merged $BRANCH -> $COMMIT_M"
