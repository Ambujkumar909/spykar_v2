# Spykar Inventory Intelligence API

Production-grade Node.js + Express backend for Spykar Jeans inventory management platform.

## Architecture

```
SQL Server (ERP) ──ETL──▶ PostgreSQL ──▶ Express API ──▶ React Dashboard
                                Redis (cache)    Claude AI (NL queries)
```

## Tech Stack

| Layer       | Technology                        |
|-------------|-----------------------------------|
| Runtime     | Node.js 20 LTS                    |
| Framework   | Express 4                         |
| Database    | PostgreSQL 16                     |
| Cache       | Redis 7                           |
| Auth        | JWT (access + refresh rotation)   |
| ETL Source  | SQL Server (mssql driver)         |
| AI Engine   | Anthropic Claude (claude-sonnet-4)|
| Scheduler   | node-cron                         |
| Logging     | Winston                           |

## Quick Start

### 1. Prerequisites
- Node.js 20+
- PostgreSQL 16
- Redis 7
- Access to Spykar SQL Server (read-only)

### 2. Setup

```bash
# Clone and install
cd spykar-backend
npm install

# Configure environment
cp .env.example .env
# Edit .env with your actual values

# Initialize database
psql -U spykar_app -d spykar_inventory -f src/database/schema.sql

# Start development server
npm run dev
```

### 3. Docker (Recommended for Production)

```bash
# Start everything (Postgres + Redis + API)
docker-compose up -d

# View logs
docker-compose logs -f api

# Run manual sync
docker-compose exec api npm run sync:manual
```

## API Endpoints

### Auth
| Method | Endpoint               | Description         |
|--------|------------------------|---------------------|
| POST   | /api/v1/auth/login     | Login               |
| POST   | /api/v1/auth/refresh   | Refresh token       |
| POST   | /api/v1/auth/logout    | Logout              |
| GET    | /api/v1/auth/me        | Current user        |

### Inventory
| Method | Endpoint                              | Description                      |
|--------|---------------------------------------|----------------------------------|
| GET    | /api/v1/inventory/executive-summary   | Top-level KPIs                   |
| GET    | /api/v1/inventory/snapshot            | Full inventory with filters      |
| GET    | /api/v1/inventory/snapshot/export     | CSV export                       |
| GET    | /api/v1/inventory/alerts              | Low stock alerts                 |
| GET    | /api/v1/inventory/movements           | Movement ledger                  |
| GET    | /api/v1/inventory/ageing              | Stock ageing report              |
| POST   | /api/v1/inventory/adjust              | Manual adjustment (Admin)        |

### Distributors
| Method | Endpoint                          | Description                        |
|--------|-----------------------------------|------------------------------------|
| GET    | /api/v1/distributors              | List all distributors              |
| GET    | /api/v1/distributors/top          | Top N by size/color/metric         |
| GET    | /api/v1/distributors/comparison   | Side-by-side comparison            |
| GET    | /api/v1/distributors/:id          | Single distributor                 |
| GET    | /api/v1/distributors/:id/inventory| Distributor inventory              |
| GET    | /api/v1/distributors/:id/ageing   | Distributor stock ageing           |

### SKUs
| Method | Endpoint                             | Description               |
|--------|--------------------------------------|---------------------------|
| GET    | /api/v1/skus/matrix                  | Size × Color heatmap data |
| GET    | /api/v1/skus/sizes                   | All sizes with stock      |
| GET    | /api/v1/skus/colors                  | All colors with stock     |
| GET    | /api/v1/skus/top-moving              | Fastest moving SKUs       |
| GET    | /api/v1/skus/slow-moving             | Dead/slow stock           |

### Analytics
| Method | Endpoint                             | Description               |
|--------|--------------------------------------|---------------------------|
| GET    | /api/v1/analytics/network-overview   | Network totals            |
| GET    | /api/v1/analytics/stock-trend        | Daily trend chart data    |
| GET    | /api/v1/analytics/size-distribution  | Size breakdown            |
| GET    | /api/v1/analytics/color-distribution | Color breakdown           |
| GET    | /api/v1/analytics/zone-heatmap       | Zone-wise stock heatmap   |
| GET    | /api/v1/analytics/fill-rate          | Dispatch fill rate        |

### AI Query
| Method | Endpoint                         | Description                       |
|--------|----------------------------------|-----------------------------------|
| POST   | /api/v1/ai/query                 | Natural language inventory query  |
| GET    | /api/v1/ai/suggested-queries     | Pre-built query suggestions       |
| GET    | /api/v1/ai/history               | User query history                |

### Dispatch
| Method | Endpoint                         | Description               |
|--------|----------------------------------|---------------------------|
| GET    | /api/v1/dispatch                 | List dispatches           |
| GET    | /api/v1/dispatch/in-transit      | All in-transit shipments  |
| GET    | /api/v1/dispatch/summary         | Status summary            |
| POST   | /api/v1/dispatch                 | Create dispatch           |
| PATCH  | /api/v1/dispatch/:id/status      | Update dispatch status    |

### Sync (Admin)
| Method | Endpoint              | Description            |
|--------|-----------------------|------------------------|
| GET    | /api/v1/sync/status   | Last sync status       |
| GET    | /api/v1/sync/logs     | Sync history           |
| POST   | /api/v1/sync/trigger  | Manual sync trigger    |

## Query Examples

### Top 5 distributors for size 34
```
GET /api/v1/distributors/top?n=5&size=34&metric=qty_on_hand
```

### Inventory snapshot for COCO stores only
```
GET /api/v1/inventory/snapshot?location_type=COCO&sort_by=qty_on_hand
```

### Size × Color matrix for North zone
```
GET /api/v1/skus/matrix?location_type=DISTRIBUTOR&zone_id=1
```

### AI Natural Language Query
```json
POST /api/v1/ai/query
{
  "question": "Which distributor in Mumbai has the least stock of size 32 blue jeans?"
}
```

## ETL Business Logic

Stock calculation per location per SKU:

```
qty_on_hand = Σ(receipts) - Σ(sales) - Σ(dispatches) + Σ(returns)
qty_available = qty_on_hand - qty_reserved
qty_in_transit = Σ(dispatched but not yet received)
```

The ETL engine:
1. Reads delta changes from SQL Server since last sync
2. Inserts movement records into `inventory_movements`
3. Rebuilds `inventory_snapshot` from the movements ledger
4. Updates `stock_ageing` for dead stock analysis
5. Invalidates all Redis caches

## User Roles

| Role        | Permissions                                      |
|-------------|--------------------------------------------------|
| SUPER_ADMIN | Full access + user management                    |
| ADMIN       | Full access including sync trigger               |
| MANAGER     | Read + create dispatches + AI queries            |
| VIEWER      | Read only                                        |

## SQL Server Setup Required

Create a read-only user and grant SELECT on these tables:
- `dbo.LocationMaster`
- `dbo.ItemMaster`
- `dbo.SalesTrans`
- `dbo.DispatchHeader` + `dbo.DispatchDetails`
- `dbo.GoodsReceipt` + `dbo.GoodsReceiptDetails`
- `dbo.SalesReturn` + `dbo.SalesReturnDetails`

> **Note**: Adapt table/column names in `src/services/syncEngine.js` to match your actual SQL Server schema.

## Health Checks

```bash
# Basic health
curl http://localhost:4000/health

# Deep health (DB + Redis)
curl http://localhost:4000/health/deep
```
