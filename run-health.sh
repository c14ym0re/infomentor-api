#!/usr/bin/env bash
# Veckokoll: pollarens hälsa + InfoMentor-varningar i HA-loggen → mejl till admin.
# Anropas av cron (måndagar 08:00).
set -uo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
cd "$(dirname "$0")"
mkdir -p out
{
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') veckokoll ==="
  node src/healthcheck.js --mail
} >> out/health-cron.log 2>&1
