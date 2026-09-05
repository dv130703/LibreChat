#!/usr/bin/env bash
# Removes per-user OfficeCLI workspace directories that have been idle past
# the retention window. This is the sweep mcp-wrapper.sh's own comments say
# to pair it with — none existed until now (see officecli-harness/doctor.js,
# which flags this as a warning whenever it finds a workspace older than 1
# day with no sweep installed).
#
# Idle is measured by each workspace DIRECTORY's mtime, which advances on
# every file create/delete inside it (including retention's own touches),
# so a workspace a user is actively using is never swept mid-conversation —
# only ones nothing has written to in RETENTION_HOURS.
#
# Install as a periodic job (systemd timer example alongside this script;
# cron works identically):
#   crontab -e
#   0 * * * * /home/daniel/LibreChat/config/officecli/retention-sweep.sh >> /var/log/officecli-retention.log 2>&1
set -euo pipefail

WORKSPACE_ROOT="${OFFICECLI_WORKSPACE_ROOT:-$HOME/.local/share/officecli/users}"
RETENTION_HOURS="${OFFICECLI_RETENTION_HOURS:-24}"
DRY_RUN="${OFFICECLI_RETENTION_DRY_RUN:-0}"

if [[ ! -d "$WORKSPACE_ROOT" ]]; then
  echo "retention-sweep: workspace root $WORKSPACE_ROOT does not exist, nothing to do"
  exit 0
fi

now=$(date +%s)
swept=0
kept=0

for dir in "$WORKSPACE_ROOT"/*/; do
  [[ -d "$dir" ]] || continue
  dir="${dir%/}"
  mtime=$(stat -c %Y "$dir")
  age_hours=$(( (now - mtime) / 3600 ))
  if (( age_hours >= RETENTION_HOURS )); then
    if [[ "$DRY_RUN" == "1" ]]; then
      echo "retention-sweep: WOULD remove $dir (idle ${age_hours}h)"
    else
      rm -rf "$dir"
      echo "retention-sweep: removed $dir (idle ${age_hours}h)"
    fi
    swept=$((swept + 1))
  else
    kept=$((kept + 1))
  fi
done

echo "retention-sweep: swept=$swept kept=$kept threshold=${RETENTION_HOURS}h root=$WORKSPACE_ROOT"
