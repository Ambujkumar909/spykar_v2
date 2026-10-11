#!/usr/bin/env bash
# Mirror the OneDrive LFR / ESales Excel folders to local disk and report what
# changed since the last run. rclone compares size + modified-time + hash, so an
# edited workbook and a brand-new one are both picked up.
#
#   onedrive_pull.sh            pull, write the change report
#   onedrive_pull.sh --dry-run  show what WOULD change, touch nothing
#
# Report: $DEST/.changes/<timestamp>.txt, one line per changed file:
#   "+ path" new   "* path" modified   "- path" deleted in OneDrive
# Exit 0 with an empty report = nothing changed. Nothing else to run: point the
# API's ESALES_STOCK_DIR at "$DEST/ESales_Stock" and its folder watcher
# (src/jobs/esalesWatcher.js) loads whatever this pull changed within seconds.
#
# One-time auth: `rclone config` → new remote "spykar_od", type onedrive, log in
# with the Microsoft account. If the login ever expires (password change / MFA):
#   rclone config reconnect spykar_od:
set -euo pipefail

RCLONE=${RCLONE:-$HOME/.local/bin/rclone}
REMOTE=${ONEDRIVE_REMOTE:-spykar_od:QlickSense/ESales_Data}
DEST=${ONEDRIVE_DEST:-$HOME/spykar/onedrive/ESales_Data}

mkdir -p "$DEST/.changes"
report="$DEST/.changes/$(date +%Y%m%d-%H%M%S).txt"

# '~$*' = Excel lock files left while someone has the workbook open.
"$RCLONE" sync "$REMOTE" "$DEST" \
  --exclude '~$*' --exclude '.changes/**' \
  --combined "$report.all" "$@"

grep -v '^= ' "$report.all" > "$report" || true   # '=' lines are unchanged files
rm -f "$report.all"

echo "$(grep -c '^+ ' "$report" || true) new, $(grep -c '^\* ' "$report" || true) modified, $(grep -c '^- ' "$report" || true) deleted → $report"
cat "$report"
