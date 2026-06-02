#!/usr/bin/env bash
# ─── Spykar IQ — re-deploy / update script ────────────────────────────────────
# Pulls latest code, installs deps, runs DB migrations, rebuilds the frontend,
# and restarts both PM2 processes. Run from the repo root on the PROD server:
#
#   ./update.sh
#
# Safe to re-run. Does NOT run a data sync (use the dashboard button or the
# nightly scheduler for that).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$ROOT/spykar-backend"
FRONTEND="$ROOT/spykar-frontend"

echo "▶  Pulling latest code…"
cd "$ROOT"
git pull --ff-only

echo "▶  Backend: install deps…"
cd "$BACKEND"
npm install --no-audit --no-fund

echo "▶  Backend: run DB migrations (idempotent — skips applied ones)…"
npm run db:migrate

echo "▶  Frontend: install deps…"
cd "$FRONTEND"
npm install --no-audit --no-fund

echo "▶  Frontend: production build…"
npm run build

echo "▶  Restarting PM2 processes…"
cd "$ROOT"
if pm2 describe spykar-api >/dev/null 2>&1; then
  pm2 reload ecosystem.config.js
else
  pm2 start ecosystem.config.js
fi
pm2 save

echo "✅  Update complete."
pm2 status
echo
echo "Health check:"
curl -fsS http://127.0.0.1:4000/health && echo
