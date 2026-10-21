#!/bin/bash
# Daemon-tolerant branch merge: merge-tree + commit-tree + update-ref (no checkout needed).
# Usage: bash scripts/merge-ref.sh <branch>
set -euo pipefail
cd /home/z/my-project
BRANCH="$1"
MERGED=$(git merge-tree --write-tree dev "$BRANCH")
TREE_M=$(echo "$MERGED" | head -1)
CONFLICTS=$(echo "$MERGED" | tail -n +2)
if [ -n "$CONFLICTS" ]; then echo "CONFLICTS:"; echo "$CONFLICTS"; exit 1; fi
COMMIT_M=$(git commit-tree "$TREE_M" -p dev -p "$BRANCH" -m "Merge branch '$BRANCH' into dev")
git update-ref refs/heads/dev "$COMMIT_M" "$(git rev-parse dev)"
echo "merged $BRANCH -> $COMMIT_M"
