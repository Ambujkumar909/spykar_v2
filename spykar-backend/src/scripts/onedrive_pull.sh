#!/usr/bin/env bash
# Mirror dtlake@spykar.com's OneDrive stock folders to local disk and report
# what changed since the last run. Read as BIMis@spykar.com (rclone remote
# "spykar_od", read-only). rclone compares size + modified-time + hash, so an
# edited workbook and a brand-new one are both picked up. Feeds, in order:
#   ESales  QlickSense/ESales_Data/ESales_Stock → $BASE/ESales_Data/ESales_Stock
#           (shortcut "DtLake's files - ESales_Stock" in BIMis's My files)
#   LFR     QlickSense/LFR/Stock               → $BASE/LFR_Data/LFR_Stock
#           (no shortcut: BIMis can read only the Stock folder, not its
#           parents, so it is addressed by drive id + folder id)
#
#   onedrive_pull.sh            pull, write the change reports
#   onedrive_pull.sh --dry-run  show what WOULD change, touch nothing
#
# Report per feed: <feed dir>/.changes/<timestamp>.txt, one line per file:
#   "+ path" new   "* path" modified   "- path" deleted in OneDrive
# Files the sync overwrites or deletes go to <feed dir>/.trash/<timestamp>
# (kept 30 days). A failing feed doesn't stop the next; exit is non-zero if
# any failed. The API's folder watcher (ESALES_STOCK_DIR → esalesWatcher.js)
# loads whatever this pull changed within seconds.
#
# If the login ever expires (password change / MFA), signed in as BIMis:
#   rclone config reconnect spykar_od:
set -uo pipefail

RCLONE=${RCLONE:-$HOME/.local/bin/rclone}
BASE=${ONEDRIVE_BASE:-$HOME/spykar/onedrive}
ESALES_REMOTE=${ESALES_REMOTE:-"spykar_od:DtLake's files - ESales_Stock"}
LFR_REMOTE=${LFR_REMOTE:-"spykar_od,drive_id=b!mCDQ0pRZrk2Ab6cBGZ5eQiEccB39Go5DtNKoDEg4kOdOfqmN8Pj8Sou4cfR2Ku3A,drive_type=business,root_folder_id=01F4V6TQEGC3QZKWLFCVGZIGJ62AID3FYI:"}
stamp=$(date +%Y%m%d-%H%M%S)
failed=0

pull() {   # pull <name> <remote> <feed dir> <subfolder> [rclone args]
  local name=$1 remote=$2 dir=$3 sub=$4; shift 4
  local report="$dir/.changes/$stamp.txt"
  mkdir -p "$dir/.changes"
  # '~$*' = Excel lock files left while someone has the workbook open.
  if ! "$RCLONE" sync "$remote" "$dir/$sub" \
      --exclude '~$*' --backup-dir "$dir/.trash/$stamp" \
      --combined "$report.all" "$@"; then
    echo "$(date '+%F %T') $name: ERROR, sync failed (see rclone lines above)"; failed=1
  fi
  grep -v '^= ' "$report.all" > "$report" 2>/dev/null || true   # '=' lines are unchanged files
  rm -f "$report.all"
  echo "$(date '+%F %T') $name: $(grep -c '^+ ' "$report") new, $(grep -c '^\* ' "$report") modified, $(grep -c '^- ' "$report") deleted → $report"
  cat "$report"
  find "$dir/.trash" -mindepth 1 -maxdepth 1 -mtime +30 -exec rm -rf {} + 2>/dev/null
}

pull ESales "$ESALES_REMOTE" "$BASE/ESales_Data" ESales_Stock "$@"
pull LFR    "$LFR_REMOTE"    "$BASE/LFR_Data"    LFR_Stock    "$@"
exit $failed
