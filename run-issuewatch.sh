#!/usr/bin/env bash
# Bevakar GitHub-issues och mejlar vid ny aktivitet. Anropas av cron (varje timme).
set -uo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
cd "$(dirname "$0")"
mkdir -p out
{
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') issuewatch ==="
  node src/issuewatch.js
} >> out/issuewatch.log 2>&1
