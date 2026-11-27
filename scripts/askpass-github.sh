#!/bin/sh
# GIT_ASKPASS helper for GitHub PAT push attempts.
# Usage: GIT_ASKPASS=/path/to/this TOKEN_FILE=/path/to/tokenfile git <cmd>
# The token is read from $TOKEN_FILE at prompt time and never printed to stdout
# of the git process, never placed in URLs or argv.
case "$1" in
  *Username*) echo "git" ;;
  *Password*)
    TOKEN=$(grep -oE '(gh[pousdhr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})' "$TOKEN_FILE" 2>/dev/null | head -1)
    echo "$TOKEN" ;;
  *) echo "" ;;
esac
