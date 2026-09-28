#!/usr/bin/env bash
# Ett poll-tick: samla in → uppdatera arkivet → publicera HA → ev. notis/digest.
# Anropas av cron (t.ex. var 20:e minut). Loggas i out/watch.log.
set -uo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
cd "$(dirname "$0")"
mkdir -p out
{
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') watch-tick ==="
  node src/watch.js --once "$@"
} >> out/watch.log 2>&1
