#!/bin/bash
# ─── Lock Postgres (18/main) to the app account only ─────────────────────────
# After this, the only login that works is spykar_app with the password from
# the backend .env, to the spykar_inventory database, from this machine.
# Everything else is refused, including the default "postgres" superuser.
#
# Run:   sudo bash deploy/db_lockdown.sh   (applied on biserver 23 Oct 2026)
# Undo:  sudo bash deploy/db_lockdown.sh --undo
# If the app account can't connect afterwards, the old file is put back automatically.
set -euo pipefail
HBA=/etc/postgresql/18/main/pg_hba.conf
ENV=/home/deploy/spykar/spykar_v2/spykar-backend/.env
reload() { systemctl reload postgresql@18-main 2>/dev/null || pg_ctlcluster 18 main reload; sleep 1; }

if [ "$(id -u)" != 0 ]; then echo "Run with sudo."; exit 1; fi

if [ "${1:-}" = "--undo" ]; then
  LAST=$(ls -1t "$HBA".bak.* 2>/dev/null | head -1 || true)
  [ -n "$LAST" ] || { echo "No backup found next to $HBA"; exit 1; }
  cp -p "$LAST" "$HBA"; reload; echo "Restored $LAST"; exit 0
fi

PASS=$(grep -E '^PG_PASSWORD=' "$ENV" | head -1 | cut -d= -f2- | sed -E 's/^["'\'']//; s/["'\'']$//')
[ -n "$PASS" ] || { echo "PG_PASSWORD not found in $ENV"; exit 1; }

TS=$(date +%Y%m%d_%H%M%S)
cp -p "$HBA" "$HBA.bak.$TS"
echo "Backup: $HBA.bak.$TS"

cat > "$HBA" <<'EOF'
# Locked by db_lockdown.sh: only the app account, with its password, to its database.
# Everything else (including the postgres superuser) is refused.
# Undo: sudo bash <repo>/deploy/db_lockdown.sh --undo
# TYPE  DATABASE          USER        ADDRESS        METHOD
host    spykar_inventory  spykar_app  127.0.0.1/32   scram-sha-256
host    spykar_inventory  spykar_app  ::1/128        scram-sha-256
local   all               all                        reject
host    all               all         0.0.0.0/0      reject
host    all               all         ::/0           reject
EOF
chown postgres:postgres "$HBA"; chmod 640 "$HBA"
reload

if PGPASSWORD="$PASS" psql -h 127.0.0.1 -U spykar_app -d spykar_inventory -Atc 'SELECT 1' >/dev/null 2>&1; then
  echo "✓ app account (spykar_app) connects"
else
  echo "✗ app account could not connect — putting the old file back"
  cp -p "$HBA.bak.$TS" "$HBA"; reload; exit 1
fi
if sudo -u postgres psql -Atc 'SELECT 1' >/dev/null 2>&1; then echo "✗ postgres user still gets in"; else echo "✓ postgres user refused"; fi
if PGPASSWORD="$PASS" psql -h 127.0.0.1 -U spykar_app -d postgres -Atc 'SELECT 1' >/dev/null 2>&1; then echo "✗ other databases still open"; else echo "✓ other databases refused"; fi
if psql -h 127.0.0.1 -U spykar_app -d spykar_inventory -w -Atc 'SELECT 1' >/dev/null 2>&1; then echo "✗ works without a password"; else echo "✓ password required"; fi
echo "Done."
