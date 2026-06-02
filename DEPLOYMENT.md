# Spykar IQ — Production Deployment (Ubuntu)

End-to-end runbook for deploying the dashboard on a fresh Ubuntu server.
Stack: **Node 18+**, **PostgreSQL 18**, **Redis**, **PM2**. The ERP (SQL Server)
is a remote read-only source reached over a private IP.

Architecture:

```
Browser ──► Frontend (Next.js, :3000) ──► Backend API (Express, :4000)
                                              │
                          ┌───────────────────┼───────────────────┐
                          ▼                    ▼                   ▼
                   PostgreSQL :5432       Redis :6379       SQL Server :1433
                   (app DB, local)        (cache)           (ERP, private IP)
```

---

## 0. Prerequisites
- Ubuntu 22.04+ with sudo/root
- Outbound network access to the ERP SQL Server private IP on port 1433
- The values you'll need: a strong `PG_PASSWORD`, a long random `JWT_SECRET`,
  the ERP `MSSQL_HOST` private IP, and the IP/domain users will use.

---

## 1. System packages

```bash
# Node 20.x
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs build-essential python3 netcat-openbsd

# PostgreSQL 18 (from the official PGDG repo — Ubuntu's default is older)
sudo apt install -y curl ca-certificates gnupg lsb-release
sudo install -d /usr/share/postgresql-common/pgdg
sudo curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
  | sudo tee /etc/apt/sources.list.d/pgdg.list
sudo apt update
sudo apt install -y postgresql-18 postgresql-contrib-18

# Redis + PM2
sudo apt install -y redis-server
sudo systemctl enable --now redis-server
sudo npm install -g pm2

# Verify
node -v            # >= 18
psql --version     # 18.x
redis-cli ping     # PONG
pg_lsclusters      # 18 main 5432 online
```

> If `pg_lsclusters` shows no cluster: `sudo pg_createcluster 18 main --start && sudo systemctl enable postgresql`

---

## 2. PostgreSQL — database, user, tuning

```bash
sudo -u postgres psql <<'SQL'
CREATE DATABASE spykar_inventory;
CREATE USER spykar_app WITH PASSWORD 'CHANGE_ME_STRONG';
GRANT ALL PRIVILEGES ON DATABASE spykar_inventory TO spykar_app;
ALTER DATABASE spykar_inventory OWNER TO spykar_app;
SQL
```

Tune for the box (example for **38 GB RAM**; scale `shared_buffers` ≈ 25% RAM,
`effective_cache_size` ≈ 65%):

```bash
sudo -u postgres psql <<'SQL'
ALTER SYSTEM SET shared_buffers = '10GB';
ALTER SYSTEM SET effective_cache_size = '24GB';
ALTER SYSTEM SET work_mem = '256MB';
ALTER SYSTEM SET maintenance_work_mem = '2GB';
ALTER SYSTEM SET random_page_cost = 1.1;
ALTER SYSTEM SET effective_io_concurrency = 200;
ALTER SYSTEM SET max_parallel_workers_per_gather = 4;
ALTER SYSTEM SET max_parallel_workers = 8;
ALTER SYSTEM SET max_worker_processes = 12;
SQL
sudo systemctl restart postgresql
```

---

## 3. Clone + environment files

```bash
git clone https://github.com/Ambujkumar909/spykar_v2.git
cd spykar_v2
```

**`spykar-backend/.env`** (key values):
```ini
NODE_ENV=production
PORT=4000
HOST=0.0.0.0
PG_HOST=127.0.0.1
PG_PORT=5432
PG_DATABASE=spykar_inventory
PG_USER=spykar_app
PG_PASSWORD=CHANGE_ME_STRONG          # must match step 2
REDIS_URL=redis://127.0.0.1:6379
MSSQL_HOST=10.x.x.x                    # ERP private IP
MSSQL_PORT=1433
MSSQL_DATABASE=...
MSSQL_USER=...
MSSQL_PASSWORD=...
JWT_SECRET=<long-random-string>
ENABLE_SCHEDULER=true                  # nightly 11pm IST DELTA sync
ALLOWED_ORIGINS=http://<SERVER_IP>:3000   # the frontend origin (browser-facing)
```

**`spykar-frontend/.env.local`** — ⚠️ baked into the build, hit by the
**browser**, so it must be the address users reach (NOT localhost):
```ini
NEXT_PUBLIC_API_URL=http://<SERVER_IP>:4000/api/v1
```

---

## 4. Backend — install, migrate, seed

```bash
cd ~/spykar_v2/spykar-backend
npm install
nc -vz <MSSQL_HOST> 1433        # must say "succeeded" before continuing
npm run db:migrate             # schema + migrations 001–012
node seed_users.js             # creates admin@spykar.com / Admin@123 etc.
```

---

## 5. Master data load (REQUIRED before the first sync)

The sync resolves ERP rows against the `locations` and `skus` masters. Load them
first or the sync resolves nothing.

```bash
cd ~/spykar_v2/spykar-backend
node src/database/load_party_master.js     # stores → locations
node src/database/load_item_master.js      # SKUs → skus  (large; few minutes)

# verify (expect hundreds of locations, ~300K skus)
PGPASSWORD='CHANGE_ME_STRONG' psql -h 127.0.0.1 -U spykar_app -d spykar_inventory \
  -c "SELECT (SELECT count(*) FROM locations) AS locations, (SELECT count(*) FROM skus) AS skus;"
```

---

## 6. Frontend — install + production build

```bash
cd ~/spykar_v2/spykar-frontend
npm install
npm run build          # REQUIRED after any code change or .env.local change
```

---

## 7. Start everything with PM2

```bash
cd ~/spykar_v2
mkdir -p logs
pm2 start ecosystem.config.js
pm2 save
pm2 startup            # run the command it prints (auto-start on reboot)
pm2 status             # spykar-api + spykar-web → online
curl http://127.0.0.1:4000/health   # {"success":true,...}
```

---

## 8. Firewall

```bash
sudo ufw allow 22
sudo ufw allow 3000        # frontend (or 80/443 if using nginx — step 10)
sudo ufw allow 4000        # backend API (only if browser hits it directly)
sudo ufw --force enable
```

---

## 9. Load data — FULL sync

First time (and any full reload). Use the **dashboard Sync button** (spawns a
detached child that survives SSH drops) OR run detached from the CLI:

```bash
cd ~/spykar_v2/spykar-backend
nohup npm run sync:full > ~/fullsync.log 2>&1 &
tail -f ~/fullsync.log     # Ctrl+C stops watching, not the sync
```

Watch for `✅ SYNC COMPLETE`. Verify:
```bash
PGPASSWORD='CHANGE_ME_STRONG' psql -h 127.0.0.1 -U spykar_app -d spykar_inventory -c \
"SELECT (SELECT count(*) FROM inventory_snapshot)  AS snapshot,
        (SELECT count(*) FROM inventory_movements) AS movements,
        (SELECT max(moved_at)::date FROM inventory_movements WHERE movement_type='SALE') AS latest_sale;"
```
Expect ~480K snapshot, ~3.5M movements, a recent latest_sale.

> ⚠️ Never run `npm run sync:full` in a bare foreground terminal — if your SSH
> session drops, the sync dies. Use `nohup … &`, the dashboard button, or the
> nightly scheduler.

Open `http://<SERVER_IP>:3000`, log in (**admin@spykar.com / Admin@123**),
**hard-refresh**, and confirm data shows. **Change the default passwords.**

---

## 10. (Optional) nginx reverse proxy + HTTPS

So users hit one clean URL (`https://dashboard…`) and port 4000 stays internal.
Ask for the config — a single nginx site that serves the frontend and proxies
`/api → :4000`, plus certbot for TLS.

---

## Updating / re-deploying after a code change

```bash
cd ~/spykar_v2
./update.sh            # git pull, install, migrate, rebuild frontend, restart PM2
```
(See `update.sh`.) For a **frontend** change you must rebuild (`npm run build`);
for a **backend** change a `pm2 restart spykar-api` is enough.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `CORS: origin … not allowed` | Add the frontend origin to `ALLOWED_ORIGINS` in backend `.env`, `pm2 restart spykar-api`. |
| `EADDRINUSE :4000` (API crash-loops) | A zombie holds 4000. `fuser -k 4000/tcp` (or `pm2 delete spykar-api` then re-add) before restart. |
| No data on dashboard | Backend down, or CORS, or sync never ran. Check `pm2 status`, `curl /health`, and that a FULL sync completed. |
| Sync: many "lookup miss" / 0 resolved | Master data not loaded — run step 5 first. |
| `socket .s.PGSQL.5432 No such file` | Postgres cluster down/missing: `pg_lsclusters`, then `pg_ctlcluster 18 main start` or `pg_createcluster 18 main --start`. |
| `MaxListenersExceededWarning` during sync | Cosmetic (parallel COPY + retry). Harmless. |
| Frontend shows old API URL | `NEXT_PUBLIC_API_URL` is baked at build — change `.env.local` then `npm run build` again. |

---

## Default login (change immediately)
```
admin@spykar.com   / Admin@123   (SUPER_ADMIN)
manager@spykar.com / Admin@123   (MANAGER)
viewer@spykar.com  / Admin@123   (VIEWER)
```
