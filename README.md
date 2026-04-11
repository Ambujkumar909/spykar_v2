# Spykar IQ — Inventory Intelligence Platform

<p align="center">
  <img src="spykar-frontend/public/spykar-logo.png" alt="Spykar IQ" width="180"/>
</p>

<p align="center">
  <strong>Enterprise-grade AI-powered inventory intelligence for Spykar Jeans</strong><br/>
  Real-time stock visibility · Natural language analytics · Multi-location network management
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Next.js-14-black?logo=next.js" />
  <img src="https://img.shields.io/badge/Node.js-20-green?logo=node.js" />
  <img src="https://img.shields.io/badge/PostgreSQL-16-blue?logo=postgresql" />
  <img src="https://img.shields.io/badge/Gemini-2.5%20Flash-orange?logo=google" />
  <img src="https://img.shields.io/badge/License-Proprietary-red" />
</p>

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Features](#features)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Prerequisites](#prerequisites)
- [Installation & Setup](#installation--setup)
- [Environment Variables](#environment-variables)
- [Running the Application](#running-the-application)
- [AI Chatbot — How It Works](#ai-chatbot--how-it-works)
- [Database Schema](#database-schema)
- [API Reference](#api-reference)
- [ETL & Data Sync](#etl--data-sync)
- [Deployment](#deployment)
- [Security](#security)
- [License](#license)

---

## Overview

**Spykar IQ** is a full-stack, production-grade inventory intelligence platform built exclusively for **Spykar Jeans**. It provides real-time visibility across the entire supply chain — from warehouses and distributors to COCO (Company-Owned, Company-Operated) and FOFO (Franchise-Owned, Franchise-Operated) retail stores.

The centrepiece is an **AI-powered natural language chatbot** that allows business users to query complex inventory data in plain English — no SQL knowledge required. Powered by Google Gemini 2.5 Flash, the chatbot converts conversational questions into optimised PostgreSQL queries, executes them against live data, and returns rich analytical answers with auto-generated data tables.

**Example queries the AI handles:**
- *"What is the return of size 32 jeans in July 2025?"*
- *"Show top 5 colours sold during Diwali 2025"*
- *"Total sales by colour on 1 May 2025"*
- *"Which stores had the highest returns last month?"*
- *"Give me sales analysis for last 30 days by city"*

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        SPYKAR IQ PLATFORM                       │
├────────────────────┬────────────────────┬───────────────────────┤
│   FRONTEND         │   BACKEND API      │   DATA LAYER          │
│   Next.js 14       │   Node.js/Express  │   PostgreSQL 16       │
│   React 18         │   REST API         │   Redis (cache)       │
│   White+Red Theme  │   JWT Auth         │   MS SQL (source ERP) │
│   AI Chatbot UI    │   Gemini AI        │   ETL Scheduler       │
│   Drag-to-resize   │   Rate limiting    │   Nightly sync        │
└────────────────────┴────────────────────┴───────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              │     AI QUERY PIPELINE         │
              │  1. NL → SQL (Gemini)         │
              │  2. SQL Validation & Safety   │
              │  3. PostgreSQL Execution      │
              │  4. Auto-breakdown generation │
              │  5. Insight synthesis         │
              │  6. Rich table + text output  │
              └───────────────────────────────┘
```

---

## Features

### 🤖 AI-Powered Natural Language Chatbot
- Converts plain English questions to optimised PostgreSQL queries via **Google Gemini 2.5 Flash**
- **Festival date intelligence** — understands "5 days of Holi 2025", "Diwali week", "festive season"
- **Relative date parsing** — "last month", "last 30 days", "this quarter", "FY 2025"
- **Auto-breakdown** — single-aggregate queries automatically generate top-10 store breakdowns
- **Self-healing SQL** — on execution failure, Gemini regenerates a corrected query automatically
- **3-pass JSON repair** — handles truncated/malformed Gemini output gracefully
- **Fallback models** — cascades through `gemini-2.5-flash` → `gemini-2.5-flash-lite` → `gemini-2.5-pro`
- **Exponential backoff** on rate limits with multi-model retry

### 📊 Smart Data Tables
- **200+ row support** with 5-row preview + expandable drawer
- **Sticky headers** on expanded view with smooth scroll
- **Smart number formatting** — ₹12.0 Cr, ₹89.08 L, 41,655 units (IST-aware dates)
- ₹ prefix auto-detected on revenue/value/mrp columns
- ISO timestamps auto-converted to readable IST dates
- Row numbers, alternating row colours, hover highlighting

### 📈 Dashboard Modules
| Module | Description |
|---|---|
| **Overview** | KPI cards — total stock, active locations, low-stock alerts, in-transit units |
| **Sales Analytics** | Revenue trends, top SKUs, colour/size performance, store rankings |
| **Network** | Zone-wise health, fill rates, COCO vs FOFO comparison |
| **Locations** | Per-store stock levels, reorder alerts, ageing breakdown |
| **Movements** | Real-time inventory movement feed with filters |
| **Users** | Admin user management with role-based access |
| **SKU Analytics** | Product-level deep dives, colour/size matrix |

### 🔐 Authentication & Security
- **JWT access tokens** (15-minute expiry) + **refresh tokens** (7-day)
- bcrypt password hashing (cost factor 12)
- Rate limiting on all API endpoints
- SQL injection prevention — whitelist SELECT-only, block DDL/DML
- CORS restricted to known origins

### 🏭 ETL & Data Sync
- Nightly automated sync from **MS SQL Server (ERP)** to PostgreSQL
- Cron-based scheduler (configurable via `.env`)
- Incremental sync with conflict resolution
- Sync logs and health monitoring endpoint

---

## Tech Stack

| Layer | Technology | Version |
|---|---|---|
| Frontend Framework | Next.js | 14.x |
| UI Library | React | 18.x |
| Styling | Inline CSS-in-JS | — |
| Backend Framework | Express.js | 4.x |
| Runtime | Node.js | 20.x |
| Primary Database | PostgreSQL | 16.x |
| Cache | Redis | 7.x |
| Source ERP DB | Microsoft SQL Server | 2019 |
| AI Model | Google Gemini 2.5 Flash | Latest |
| Authentication | JWT (jsonwebtoken) | — |
| Password Hashing | bcryptjs | — |
| ORM / Query | node-postgres (pg) | — |
| Scheduling | node-cron | — |
| Logging | Winston | — |
| Icons | Lucide React | — |
| Containerisation | Docker + Docker Compose | — |

---

## Project Structure

```
spykar-project/
├── spykar-backend/                  # Node.js REST API
│   ├── src/
│   │   ├── app.js                   # Express app setup, middleware, routes
│   │   ├── server.js                # HTTP server entry point
│   │   ├── config/
│   │   │   ├── database.js          # PostgreSQL connection pool
│   │   │   └── logger.js            # Winston logger config
│   │   ├── controllers/
│   │   │   ├── ai.controller.js     # 🤖 AI chatbot — Gemini, SQL gen, breakdown
│   │   │   ├── auth.controller.js   # Login, refresh token, logout
│   │   │   ├── inventory.controller.js  # Stock snapshots, movements
│   │   │   ├── locations.controller.js  # Location management
│   │   │   └── ...
│   │   ├── middleware/
│   │   │   ├── auth.js              # JWT verification middleware
│   │   │   ├── errorHandler.js      # Global error handler + AppError class
│   │   │   └── rateLimiter.js       # Express rate limiting
│   │   ├── routes/
│   │   │   ├── ai.routes.js         # /api/ai/* endpoints
│   │   │   ├── auth.routes.js       # /api/auth/* endpoints
│   │   │   └── ...
│   │   ├── jobs/
│   │   │   └── etlSync.js           # Nightly MS SQL → PostgreSQL ETL job
│   │   └── scripts/                 # DB migration scripts
│   ├── .env                         # ⚠️ NOT committed — see .env.example
│   ├── package.json
│   ├── Dockerfile
│   └── docker-compose.yml
│
├── spykar-frontend/                 # Next.js frontend
│   ├── pages/
│   │   ├── _app.js                  # Global layout, auth guard, title
│   │   ├── _document.js             # Favicon, meta tags
│   │   ├── login.js                 # Login page (white+red theme)
│   │   ├── index.js                 # Overview dashboard
│   │   ├── sales.js                 # Sales analytics
│   │   ├── network.js               # Network health
│   │   ├── locations.js             # Location management
│   │   ├── users.js                 # User management
│   │   └── ...
│   ├── components/
│   │   ├── AiChatbot.js             # 🤖 Premium AI chatbot UI (drag-resize)
│   │   ├── layout/
│   │   │   ├── Sidebar.js           # Navigation sidebar with Spykar logo
│   │   │   └── Header.js            # Top header bar
│   │   └── ui/                      # Reusable UI components
│   ├── lib/
│   │   └── services.js              # API service layer (axios)
│   ├── public/
│   │   ├── spykar-logo.png          # Official Spykar logo
│   │   └── favicon.png              # Spykar favicon
│   ├── styles/
│   │   └── globals.css              # Global CSS (white+red theme)
│   └── package.json
│
└── README.md
```

---

## Prerequisites

Before you begin, ensure you have the following installed:

- **Node.js** v20.x or higher — [nodejs.org](https://nodejs.org)
- **PostgreSQL** v16.x — [postgresql.org](https://www.postgresql.org)
- **Redis** v7.x — [redis.io](https://redis.io)
- **Git** — [git-scm.com](https://git-scm.com)
- A **Google Gemini API key** — [aistudio.google.com](https://aistudio.google.com/app/apikey)
- *(Optional)* **Docker** + **Docker Compose** for containerised deployment

---

## Installation & Setup

### 1. Clone the Repository

```bash
git clone https://github.com/Ambujkumar909/spykar-inventory.git
cd spykar-inventory
```

> ⚠️ **This repository is proprietary.** Cloning is permitted only for authorised Spykar team members. See [LICENSE](./LICENSE).

---

### 2. Backend Setup

```bash
cd spykar-backend

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit .env with your credentials (see Environment Variables section)
nano .env
```

#### Database Setup

```bash
# Create PostgreSQL database and user
psql -U postgres

CREATE DATABASE spykar_inventory;
CREATE USER spykar_app WITH PASSWORD 'your_secure_password';
GRANT ALL PRIVILEGES ON DATABASE spykar_inventory TO spykar_app;
\q

# Run migrations (creates all tables)
psql -U spykar_app -d spykar_inventory -f src/scripts/001_create_tables.sql
psql -U spykar_app -d spykar_inventory -f src/scripts/002_seed_data.sql
```

---

### 3. Frontend Setup

```bash
cd ../spykar-frontend

# Install dependencies
npm install
```

---

## Environment Variables

### Backend — `spykar-backend/.env`

Create this file from `.env.example`. **Never commit `.env` to version control.**

```env
# ── Server ─────────────────────────────────────────────────────────
NODE_ENV=development                  # development | production
PORT=4001                             # API server port
HOST=0.0.0.0
LOG_LEVEL=info                        # error | warn | info | debug

# ── CORS ───────────────────────────────────────────────────────────
ALLOWED_ORIGINS=http://localhost:3000

# ── PostgreSQL ─────────────────────────────────────────────────────
PG_HOST=localhost
PG_PORT=5432
PG_DATABASE=spykar_inventory
PG_USER=spykar_app
PG_PASSWORD=your_pg_password
PG_POOL_MAX=20
PG_SSL=false                          # Set true in production

# ── Redis ──────────────────────────────────────────────────────────
REDIS_URL=redis://localhost:6379
REDIS_PASSWORD=                       # Leave blank if no auth

# ── JWT Authentication ─────────────────────────────────────────────
# Generate with: openssl rand -hex 64
JWT_SECRET=generate_a_64_byte_hex_secret_here
JWT_EXPIRY=15m
JWT_REFRESH_EXPIRY=7d

# ── MS SQL Server (Source ERP) ─────────────────────────────────────
MSSQL_HOST=your_erp_server_ip
MSSQL_PORT=1433
MSSQL_DATABASE=STOREDB
MSSQL_USER=your_mssql_user
MSSQL_PASSWORD=your_mssql_password
MSSQL_ENCRYPT=false

# ── ETL Scheduler ──────────────────────────────────────────────────
ENABLE_SCHEDULER=true
SYNC_CRON=30 21 * * *                 # Every day at 9:30 PM IST

# ── Google Gemini AI ───────────────────────────────────────────────
GEMINI_API_KEY=your_gemini_api_key    # From aistudio.google.com
GEMINI_MODEL=gemini-2.5-flash
```

### Frontend — `spykar-frontend/.env.local`

```env
NEXT_PUBLIC_API_URL=http://localhost:4001/api
```

---

## Running the Application

### Development Mode

**Terminal 1 — Backend:**
```bash
cd spykar-backend
npm run dev
# API running at http://localhost:4001
```

**Terminal 2 — Frontend:**
```bash
cd spykar-frontend
npm run dev
# Frontend running at http://localhost:3000
```

### Production Mode

```bash
# Backend
cd spykar-backend
npm start

# Frontend
cd spykar-frontend
npm run build
npm start
```

### Docker Compose (Recommended for Production)

```bash
cd spykar-backend
docker-compose up -d
```

This starts PostgreSQL, Redis, and the API server in containers.

---

## AI Chatbot — How It Works

The AI chatbot follows a **6-step pipeline** for every query:

```
User Question
     │
     ▼
┌─────────────────────────────────────────────┐
│  STEP 1: SQL Generation                     │
│  Gemini 2.5 Flash + Schema Context          │
│  → Converts NL question to PostgreSQL       │
│  → Festival dates, relative dates resolved  │
│  → QUERY TYPE RULES: by colour / by date    │
└─────────────────────┬───────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────┐
│  STEP 2: SQL Validation & Execution         │
│  → SELECT-only whitelist enforced           │
│  → DDL/DML blocked (INSERT/UPDATE/DROP)     │
│  → pg numeric strings coerced to numbers   │
│  → Self-heal on failure (Gemini regenerates)│
└─────────────────────┬───────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────┐
│  STEP 2.5: Auto-Breakdown (single results)  │
│  → If query returns 1 row (aggregate)       │
│  → Auto-generates top-10 store breakdown    │
│  → Runs breakdown SQL in background         │
└─────────────────────┬───────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────┐
│  STEP 3: Insight Generation                 │
│  → Gemini synthesises 4-5 sentence analysis │
│  → References top/bottom performers         │
│  → Indian number format (₹ Cr / L)          │
│  → Truncation detection + fallback summary  │
└─────────────────────┬───────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────┐
│  STEP 4: Audit Log                          │
│  → Non-blocking INSERT to ai_query_log      │
└─────────────────────┬───────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────┐
│  STEP 5: Response                           │
│  → answer (human text)                     │
│  → rows (breakdown table — up to 200)       │
│  → explanation (what the query does)        │
└─────────────────────────────────────────────┘
```

### Date Intelligence Examples

| Query | Resolved To |
|---|---|
| `5 days of Holi 2025` | Mar 10 – Mar 14, 2025 |
| `during Diwali 2025` | Oct 18 – Oct 22, 2025 |
| `festive season 2025` | Sep 1 – Nov 30, 2025 |
| `last month` | Full previous calendar month |
| `FY 2025` | Apr 1, 2025 – Mar 31, 2026 |
| `last 30 days` | Today − 30 days → today |

### Query Type Intelligence

| User Says | SQL Generated |
|---|---|
| `by colour` | `GROUP BY s.color_name` |
| `by date / daily` | `GROUP BY DATE(moved_at AT TIME ZONE 'Asia/Kolkata')` |
| `top N` | `ORDER BY metric DESC LIMIT N` |
| `how was sales` | Multi-row daily breakdown |
| `total / how many` | Single aggregate |

---

## Database Schema

### Core Tables

```sql
-- Inventory snapshot (current stock per location+SKU)
inventory_snapshot (
  location_id, sku_id,
  qty_on_hand, qty_reserved, qty_in_transit, qty_available,
  safety_stock, reorder_point, updated_at
)

-- All stock movements (SALE, RETURN, RECEIPT, DISPATCH, TRANSFER, ADJUSTMENT)
inventory_movements (
  id, location_id, sku_id,
  movement_type ENUM[SALE,DISPATCH,RECEIPT,RETURN,TRANSFER_OUT,TRANSFER_IN,ADJUSTMENT],
  qty_change INT,   -- NEGATIVE for SALE/TRANSFER_OUT, POSITIVE for all others
  moved_at TIMESTAMPTZ
)

-- Product master
skus (
  id, sku_code, product_name,
  color_code, color_name, size, fit_type,
  mrp, is_active
)

-- Location master (Warehouse / Distributor / COCO / FOFO)
locations (
  id, code, name, type ENUM[WAREHOUSE,DISTRIBUTOR,COCO,FOFO],
  zone_id, city, state, is_active
)

-- Dispatch orders
dispatch_orders (
  id, dispatch_no, from_location_id, to_location_id,
  status, total_qty, total_value,
  dispatched_at, expected_at, delivered_at
)

-- Stock ageing buckets
stock_ageing (
  location_id, sku_id,
  qty_0_30, qty_31_60, qty_61_90, qty_91_180, qty_180_plus,
  ageing_date
)

-- AI query audit log
ai_query_log (
  id, user_id, question, generated_sql,
  row_count, answer, created_at
)
```

**Key rule:** `SALE` has **negative** `qty_change`. Always use `ABS(qty_change)` or `SUM(ABS(...))` for sales volumes.

---

## API Reference

### Authentication

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/auth/login` | Login with email + password, returns JWT |
| `POST` | `/api/auth/refresh` | Refresh access token |
| `POST` | `/api/auth/logout` | Invalidate refresh token |

### AI Chatbot

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/ai/query` | Submit natural language query |
| `GET` | `/api/ai/suggestions` | Get suggested queries by category |
| `GET` | `/api/ai/history` | Get user's past 20 queries |

**POST `/api/ai/query` — Request:**
```json
{
  "question": "Show total sales by colour during Diwali 2025"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "question": "Show total sales by colour during Diwali 2025",
    "answer": "During Diwali 2025 (Oct 18–22), total sales were 1.23 L units generating ₹38.4 Cr in revenue...",
    "rows": [
      { "color_name": "DARK BLUE", "units_sold": 18420, "revenue": 5234000 },
      ...
    ],
    "rowCount": 47,
    "explanation": "Sales by colour during Diwali 2025 (Oct 18-22)"
  }
}
```

### Inventory

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/inventory/snapshot` | Current stock levels (filterable) |
| `GET` | `/api/inventory/movements` | Movement history with filters |
| `GET` | `/api/inventory/alerts` | Low stock + reorder alerts |
| `GET` | `/api/locations` | All locations with stock summary |
| `GET` | `/api/network/health` | Zone-wise network health metrics |

All endpoints require `Authorization: Bearer <token>` header.

---

## ETL & Data Sync

The platform syncs inventory data nightly from the source **Microsoft SQL Server ERP** to the analytics **PostgreSQL** database.

### Sync Schedule

Configured via `SYNC_CRON` in `.env`:
```
30 21 * * *   →  Every day at 9:30 PM IST
```

### Manual Trigger

```bash
# Via API (admin only)
curl -X POST http://localhost:4001/api/sync/trigger \
  -H "Authorization: Bearer <admin_token>"
```

### Sync Process

1. Connect to MS SQL Server (source ERP)
2. Fetch delta records (new movements since last sync)
3. Upsert into PostgreSQL `inventory_movements`
4. Recalculate `inventory_snapshot` aggregates
5. Refresh `stock_ageing` buckets
6. Log sync completion + row counts

---

## Deployment

### Production Checklist

- [ ] Set `NODE_ENV=production`
- [ ] Set `PG_SSL=true` and configure SSL certificates
- [ ] Use strong random `JWT_SECRET` (`openssl rand -hex 64`)
- [ ] Restrict `ALLOWED_ORIGINS` to production domain only
- [ ] Enable Redis password authentication
- [ ] Set up PostgreSQL connection pooling (PgBouncer recommended)
- [ ] Configure reverse proxy (Nginx) with HTTPS
- [ ] Set up log rotation and monitoring (PM2 / systemd)
- [ ] Enable database backups (daily pg_dump)

### Nginx Configuration (example)

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;

    location /api/ {
        proxy_pass http://localhost:4001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location / {
        proxy_pass http://localhost:3000;
    }
}
```

---

## Security

This platform implements multiple layers of security:

| Layer | Mechanism |
|---|---|
| **Authentication** | JWT with 15-minute access token expiry |
| **Password storage** | bcrypt with cost factor 12 |
| **SQL safety** | SELECT-only whitelist; DDL/DML regex block |
| **Rate limiting** | Per-IP limits on all API endpoints |
| **CORS** | Restricted to explicitly listed origins |
| **Input validation** | All API inputs validated and sanitised |
| **Secrets management** | All credentials in `.env`, never committed |
| **AI safety** | Gemini output sanitised before DB execution |

---

## License

This software is proprietary and confidential.  
See [LICENSE](./LICENSE) for full terms.

**Copyright © 2025 Ambuj Kumar / Spykar Jeans. All Rights Reserved.**

Unauthorised copying, distribution, modification, or use of this software,  
via any medium, is strictly prohibited without written permission from the author.

---

<p align="center">
  Built with ❤️ for Spykar Jeans · <strong>Spykar IQ v1.0</strong>
</p>
