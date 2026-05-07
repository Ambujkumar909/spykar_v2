-- ============================================================
-- SPYKAR INVENTORY INTELLIGENCE PLATFORM
-- PostgreSQL Schema v1.0
-- Run this file once to initialize the database
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- For fast text search

-- ============================================================
-- ENUMS
-- ============================================================

CREATE TYPE location_type AS ENUM ('WAREHOUSE', 'DISTRIBUTOR', 'COCO', 'FOFO', 'TRANSIT');
CREATE TYPE dispatch_status AS ENUM ('PENDING', 'DISPATCHED', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED', 'PARTIAL');
CREATE TYPE user_role AS ENUM ('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'VIEWER');
CREATE TYPE sync_status AS ENUM ('PENDING', 'RUNNING', 'SUCCESS', 'FAILED');
CREATE TYPE movement_type AS ENUM ('SALE', 'DISPATCH', 'RECEIPT', 'RETURN', 'TRANSFER_OUT', 'TRANSFER_IN', 'ADJUSTMENT');

-- ============================================================
-- MASTER TABLES
-- ============================================================

-- Users & Auth
CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name            VARCHAR(100) NOT NULL,
  email           VARCHAR(150) UNIQUE NOT NULL,
  password_hash   VARCHAR(255) NOT NULL,
  role            user_role NOT NULL DEFAULT 'VIEWER',
  state           VARCHAR(100),
  is_active       BOOLEAN DEFAULT true,
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);

-- Refresh tokens for JWT rotation
CREATE TABLE refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  VARCHAR(255) NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_hash ON refresh_tokens(token_hash);

-- Zones (North, South, East, West, etc.)
CREATE TABLE zones (
  id          SERIAL PRIMARY KEY,
  code        VARCHAR(20) UNIQUE NOT NULL,
  name        VARCHAR(100) NOT NULL,
  is_active   BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Locations master (warehouses, distributors, stores)
CREATE TABLE locations (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code            VARCHAR(50) UNIQUE NOT NULL,       -- e.g. WH-MUM-01, DIST-DEL-042
  name            VARCHAR(200) NOT NULL,
  type            location_type NOT NULL,
  zone_id         INTEGER REFERENCES zones(id),
  city            VARCHAR(100),
  state           VARCHAR(100),
  pincode         VARCHAR(10),
  address         TEXT,
  gstin           VARCHAR(20),
  contact_name    VARCHAR(100),
  contact_phone   VARCHAR(15),
  contact_email   VARCHAR(150),
  credit_limit    NUMERIC(15,2) DEFAULT 0,
  is_active       BOOLEAN DEFAULT true,
  external_id     VARCHAR(100),                     -- ID in source SQL Server
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_locations_type ON locations(type);
CREATE INDEX idx_locations_zone ON locations(zone_id);
CREATE INDEX idx_locations_code ON locations(code);
CREATE INDEX idx_locations_external ON locations(external_id);

-- SKU Master (Product × Color × Size)
CREATE TABLE skus (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sku_code        VARCHAR(100) UNIQUE NOT NULL,      -- e.g. SPY-JN-BLU-32
  product_name    VARCHAR(200) NOT NULL,
  category        VARCHAR(100) DEFAULT 'Jeans',
  sub_category    VARCHAR(100),
  color_code      VARCHAR(20) NOT NULL,
  color_name      VARCHAR(50) NOT NULL,
  size            VARCHAR(10) NOT NULL,              -- 28, 30, 32, 34, 36, 38, 40
  fit_type        VARCHAR(50),                       -- Slim, Regular, Skinny, Bootcut
  fabric          VARCHAR(100),
  mrp             NUMERIC(10,2) NOT NULL,
  cost_price      NUMERIC(10,2),
  barcode         VARCHAR(100),
  hsn_code        VARCHAR(20),
  is_active       BOOLEAN DEFAULT true,
  external_id     VARCHAR(100),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_skus_code ON skus(sku_code);
CREATE INDEX idx_skus_color ON skus(color_code);
CREATE INDEX idx_skus_size ON skus(size);
CREATE INDEX idx_skus_external ON skus(external_id);
CREATE INDEX idx_skus_search ON skus USING gin(product_name gin_trgm_ops);

-- ============================================================
-- INVENTORY TABLES
-- ============================================================

-- Current inventory snapshot per location per SKU
-- This is the "live" inventory state — updated on every delta sync
CREATE TABLE inventory_snapshot (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  location_id       UUID NOT NULL REFERENCES locations(id),
  sku_id            UUID NOT NULL REFERENCES skus(id),
  qty_on_hand       INTEGER NOT NULL DEFAULT 0,       -- physically present
  qty_reserved      INTEGER NOT NULL DEFAULT 0,       -- committed for open orders
  qty_in_transit    INTEGER NOT NULL DEFAULT 0,       -- dispatched, not yet received
  qty_available     INTEGER GENERATED ALWAYS AS      -- computable available stock
                    (qty_on_hand - qty_reserved) STORED,
  safety_stock      INTEGER DEFAULT 0,
  reorder_point     INTEGER DEFAULT 0,
  last_movement_at  TIMESTAMPTZ,
  snapshot_date     DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT uq_inventory_location_sku UNIQUE (location_id, sku_id)
);

CREATE INDEX idx_snapshot_location ON inventory_snapshot(location_id);
CREATE INDEX idx_snapshot_sku ON inventory_snapshot(sku_id);
CREATE INDEX idx_snapshot_date ON inventory_snapshot(snapshot_date);
CREATE INDEX idx_snapshot_qty ON inventory_snapshot(qty_on_hand);
CREATE INDEX idx_snapshot_low ON inventory_snapshot(qty_on_hand) WHERE qty_on_hand <= safety_stock;

-- Inventory movement ledger (every delta change logged here)
CREATE TABLE inventory_movements (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  location_id     UUID NOT NULL REFERENCES locations(id),
  sku_id          UUID NOT NULL REFERENCES skus(id),
  movement_type   movement_type NOT NULL,
  qty_change      INTEGER NOT NULL,                   -- positive or negative
  qty_before      INTEGER NOT NULL,
  qty_after       INTEGER NOT NULL,
  reference_id    UUID,                               -- dispatch_id, sale_id etc.
  reference_type  VARCHAR(50),
  notes           TEXT,
  moved_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  synced_from     VARCHAR(50),                        -- 'SQL_SERVER_SYNC', 'MANUAL', etc.
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_movements_location ON inventory_movements(location_id);
CREATE INDEX idx_movements_sku ON inventory_movements(sku_id);
CREATE INDEX idx_movements_type ON inventory_movements(movement_type);
CREATE INDEX idx_movements_date ON inventory_movements(moved_at DESC);
CREATE INDEX idx_movements_ref ON inventory_movements(reference_id);

-- Stock ageing — tracks how long each unit has been sitting
CREATE TABLE stock_ageing (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  location_id     UUID NOT NULL REFERENCES locations(id),
  sku_id          UUID NOT NULL REFERENCES skus(id),
  qty_0_30        INTEGER DEFAULT 0,    -- units aged 0-30 days
  qty_31_60       INTEGER DEFAULT 0,    -- 31-60 days
  qty_61_90       INTEGER DEFAULT 0,    -- 61-90 days
  qty_91_180      INTEGER DEFAULT 0,    -- 91-180 days
  qty_180_plus    INTEGER DEFAULT 0,    -- 180+ days (dead stock)
  ageing_date     DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT uq_ageing_location_sku_date UNIQUE (location_id, sku_id, ageing_date)
);

CREATE INDEX idx_ageing_location ON stock_ageing(location_id);
CREATE INDEX idx_ageing_dead ON stock_ageing(qty_180_plus) WHERE qty_180_plus > 0;

-- ============================================================
-- DISPATCH TABLES
-- ============================================================

-- Dispatch orders (outbound from warehouse to location)
CREATE TABLE dispatch_orders (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  dispatch_no       VARCHAR(50) UNIQUE NOT NULL,      -- e.g. DISP-2025-000123
  from_location_id  UUID NOT NULL REFERENCES locations(id),
  to_location_id    UUID NOT NULL REFERENCES locations(id),
  status            dispatch_status NOT NULL DEFAULT 'PENDING',
  total_skus        INTEGER DEFAULT 0,
  total_qty         INTEGER DEFAULT 0,
  total_value       NUMERIC(15,2) DEFAULT 0,
  dispatched_at     TIMESTAMPTZ,
  expected_at       TIMESTAMPTZ,
  delivered_at      TIMESTAMPTZ,
  courier_name      VARCHAR(100),
  tracking_no       VARCHAR(100),
  notes             TEXT,
  external_id       VARCHAR(100),
  created_by        UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_dispatch_from ON dispatch_orders(from_location_id);
CREATE INDEX idx_dispatch_to ON dispatch_orders(to_location_id);
CREATE INDEX idx_dispatch_status ON dispatch_orders(status);
CREATE INDEX idx_dispatch_date ON dispatch_orders(dispatched_at DESC);
CREATE INDEX idx_dispatch_external ON dispatch_orders(external_id);

-- Line items for each dispatch
CREATE TABLE dispatch_line_items (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  dispatch_id     UUID NOT NULL REFERENCES dispatch_orders(id) ON DELETE CASCADE,
  sku_id          UUID NOT NULL REFERENCES skus(id),
  qty_ordered     INTEGER NOT NULL,
  qty_dispatched  INTEGER DEFAULT 0,
  qty_received    INTEGER DEFAULT 0,
  unit_cost       NUMERIC(10,2),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_dispatch_items_dispatch ON dispatch_line_items(dispatch_id);
CREATE INDEX idx_dispatch_items_sku ON dispatch_line_items(sku_id);

-- ============================================================
-- SYNC & ETL TABLES
-- ============================================================

-- Tracks every sync run from SQL Server
CREATE TABLE sync_logs (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sync_type         VARCHAR(50) NOT NULL,             -- 'FULL', 'DELTA', 'MANUAL'
  status            sync_status NOT NULL DEFAULT 'PENDING',
  source            VARCHAR(50) DEFAULT 'SQL_SERVER',
  records_fetched   INTEGER DEFAULT 0,
  records_inserted  INTEGER DEFAULT 0,
  records_updated   INTEGER DEFAULT 0,
  records_failed    INTEGER DEFAULT 0,
  error_message     TEXT,
  started_at        TIMESTAMPTZ DEFAULT NOW(),
  completed_at      TIMESTAMPTZ,
  duration_ms       INTEGER
);

CREATE INDEX idx_sync_logs_status ON sync_logs(status);
CREATE INDEX idx_sync_logs_date ON sync_logs(started_at DESC);

-- ============================================================
-- VIEWS (read-optimized for dashboard queries)
-- ============================================================

-- Inventory with full location and SKU details
CREATE OR REPLACE VIEW v_inventory_full AS
SELECT
  i.id,
  l.id           AS location_id,
  l.code         AS location_code,
  l.name         AS location_name,
  l.type         AS location_type,
  z.name         AS zone_name,
  l.city,
  l.state,
  s.id           AS sku_id,
  s.sku_code,
  s.product_name,
  s.color_code,
  s.color_name,
  s.size,
  s.fit_type,
  s.mrp,
  i.qty_on_hand,
  i.qty_reserved,
  i.qty_in_transit,
  i.qty_available,
  i.safety_stock,
  i.reorder_point,
  CASE WHEN i.qty_on_hand <= i.safety_stock THEN true ELSE false END AS is_below_safety,
  i.last_movement_at,
  i.updated_at
FROM inventory_snapshot i
JOIN locations l ON l.id = i.location_id
LEFT JOIN zones z ON z.id = l.zone_id
JOIN skus s ON s.id = i.sku_id
WHERE l.is_active = true AND s.is_active = true;

-- Executive summary view
CREATE OR REPLACE VIEW v_executive_summary AS
SELECT
  l.type                        AS location_type,
  COUNT(DISTINCT l.id)          AS location_count,
  COUNT(DISTINCT s.id)          AS active_skus,
  SUM(i.qty_on_hand)            AS total_stock,
  SUM(i.qty_in_transit)         AS total_in_transit,
  SUM(i.qty_on_hand * s.mrp)   AS total_stock_value,
  COUNT(*) FILTER (WHERE i.qty_on_hand <= i.safety_stock AND i.safety_stock > 0) AS low_stock_alerts
FROM inventory_snapshot i
JOIN locations l ON l.id = i.location_id
JOIN skus s ON s.id = i.sku_id
WHERE l.is_active = true AND s.is_active = true
GROUP BY l.type;

-- Top distributors by stock
CREATE OR REPLACE VIEW v_top_distributors AS
SELECT
  l.id,
  l.code,
  l.name,
  l.city,
  l.state,
  z.name                        AS zone,
  SUM(i.qty_on_hand)            AS total_stock,
  SUM(i.qty_available)          AS available_stock,
  SUM(i.qty_on_hand * s.mrp)   AS stock_value,
  COUNT(DISTINCT i.sku_id)      AS sku_count,
  MAX(i.updated_at)             AS last_updated
FROM inventory_snapshot i
JOIN locations l ON l.id = i.location_id
LEFT JOIN zones z ON z.id = l.zone_id
JOIN skus s ON s.id = i.sku_id
WHERE l.type = 'DISTRIBUTOR' AND l.is_active = true
GROUP BY l.id, l.code, l.name, l.city, l.state, z.name
ORDER BY total_stock DESC;

-- ============================================================
-- INITIAL DATA
-- ============================================================

-- Default zones
INSERT INTO zones (code, name) VALUES
  ('NORTH', 'North India'),
  ('SOUTH', 'South India'),
  ('EAST', 'East India'),
  ('WEST', 'West India'),
  ('CENTRAL', 'Central India');

-- Default super admin (password: Admin@123 — change immediately)
INSERT INTO users (name, email, password_hash, role) VALUES
  ('Super Admin', 'admin@spykar.com',
   '$2b$12$placeholder_change_this_hash_immediately', 'SUPER_ADMIN');

-- ============================================================
-- FUNCTIONS & TRIGGERS
-- ============================================================

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply to tables with updated_at
CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_locations_updated BEFORE UPDATE ON locations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_skus_updated BEFORE UPDATE ON skus
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_inventory_updated BEFORE UPDATE ON inventory_snapshot
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_dispatch_updated BEFORE UPDATE ON dispatch_orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
