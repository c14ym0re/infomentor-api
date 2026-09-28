#!/usr/bin/env bash
# Kvällskörning: samla in → rendera rapport → mejla. Loggas i out/cron.log.
# Anropas av cron kl. 18:00 (se `crontab -l`).
set -uo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
cd "$(dirname "$0")"
mkdir -p out

{
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') kvällskörning startar ==="
  node src/collect.js || echo "VARNING: collect misslyckades"
  node src/report.js  || echo "VARNING: report misslyckades"
  python3 src/send_mail.py || echo "VARNING: send_mail misslyckades"
  echo "=== klar $(date '+%H:%M:%S') ==="
} >> out/cron.log 2>&1
