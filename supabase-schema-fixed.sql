-- ══════════════════════════════════════════════════════
--  Coffeemoon — Supabase SQL Sxemi (Düzəldilmiş)
--  Bütün sütun adları snake_case — tırnak problemi yoxdur
-- ══════════════════════════════════════════════════════

DROP TABLE IF EXISTS attendance CASCADE;
DROP TABLE IF EXISTS nahar CASCADE;
DROP TABLE IF EXISTS scan_devices CASCADE;
DROP TABLE IF EXISTS cedvel CASCADE;
DROP TABLE IF EXISTS izin CASCADE;
DROP TABLE IF EXISTS checklist_items CASCADE;
DROP TABLE IF EXISTS checklist_logs CASCADE;
DROP TABLE IF EXISTS mgr_acks CASCADE;
DROP TABLE IF EXISTS products CASCADE;
DROP TABLE IF EXISTS product_logs CASCADE;
DROP TABLE IF EXISTS mgr_schedule CASCADE;
DROP TABLE IF EXISTS late_perms CASCADE;
DROP TABLE IF EXISTS announcements CASCADE;
DROP TABLE IF EXISTS employees CASCADE;
DROP TABLE IF EXISTS settings CASCADE;

-- İşçilər
CREATE TABLE employees (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  dept        TEXT DEFAULT '',
  secret      TEXT UNIQUE,
  device_id   TEXT DEFAULT '',
  message     TEXT DEFAULT '',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Davamiyyət
CREATE TABLE attendance (
  id          BIGSERIAL PRIMARY KEY,
  emp_id      TEXT NOT NULL,
  emp_name    TEXT,
  dept        TEXT,
  timestamp   TIMESTAMPTZ NOT NULL,
  type        TEXT,
  overtime    TEXT DEFAULT '',
  shift_type  TEXT DEFAULT ''
);

-- Nahar
CREATE TABLE nahar (
  nahar_id    TEXT PRIMARY KEY,
  emp_id      TEXT NOT NULL,
  emp_name    TEXT,
  dept        TEXT,
  timestamp   TIMESTAMPTZ NOT NULL,
  type        TEXT
);

-- Scan cihazları
CREATE TABLE scan_devices (
  device_id   TEXT PRIMARY KEY,
  branch      TEXT DEFAULT '',
  status      TEXT DEFAULT 'pending',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  label       TEXT DEFAULT ''
);

-- Cədvəl (həftəlik iş qrafiki)
CREATE TABLE cedvel (
  cedvel_id   TEXT PRIMARY KEY,
  emp_id      TEXT NOT NULL,
  emp_name    TEXT,
  dept        TEXT,
  date_str    TEXT NOT NULL,
  shift_type  TEXT DEFAULT ''
);

-- İzin
CREATE TABLE izin (
  izin_id     TEXT PRIMARY KEY,
  emp_id      TEXT,
  emp_name    TEXT,
  dept        TEXT,
  start_date  TEXT,
  end_date    TEXT,
  type        TEXT DEFAULT 'İzin',
  note        TEXT DEFAULT '',
  status      TEXT DEFAULT 'pending',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Çeklist elementləri
CREATE TABLE checklist_items (
  item_id     TEXT PRIMARY KEY,
  text        TEXT,
  category    TEXT,
  sort_order  INTEGER DEFAULT 0,
  active      BOOLEAN DEFAULT TRUE
);

-- Çeklist logları
CREATE TABLE checklist_logs (
  log_id      TEXT PRIMARY KEY,
  date        TEXT,
  dept        TEXT,
  item_id     TEXT,
  item_text   TEXT,
  checked     BOOLEAN DEFAULT FALSE,
  checked_at  TEXT DEFAULT '',
  mgr_note    TEXT DEFAULT '',
  admin_note  TEXT DEFAULT ''
);

-- Menecer təsdiqləri
CREATE TABLE mgr_acks (
  ack_id          TEXT PRIMARY KEY,
  date            TEXT,
  dept            TEXT,
  global_acked    BOOLEAN DEFAULT FALSE,
  global_acked_at TEXT DEFAULT '',
  branch_acked    BOOLEAN DEFAULT FALSE,
  branch_acked_at TEXT DEFAULT ''
);

-- Məhsullar
CREATE TABLE products (
  product_id  TEXT PRIMARY KEY,
  name        TEXT,
  unit        TEXT DEFAULT 'ədəd',
  active      BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Məhsul logları
CREATE TABLE product_logs (
  log_id        TEXT PRIMARY KEY,
  date_str      TEXT,
  dept          TEXT,
  product_id    TEXT,
  product_name  TEXT,
  incoming      NUMERIC DEFAULT 0,
  wasted        NUMERIC DEFAULT 0,
  saved_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Menecer həftəlik qrafik
CREATE TABLE mgr_schedule (
  sched_id    TEXT PRIMARY KEY,
  dept        TEXT,
  date_str    TEXT,
  shift_type  TEXT DEFAULT ''
);

-- Gec gəliş icazəsi
CREATE TABLE late_perms (
  perm_id         TEXT PRIMARY KEY,
  emp_id          TEXT,
  emp_name        TEXT,
  dept            TEXT,
  date_str        TEXT,
  requested_time  TEXT,
  status          TEXT DEFAULT 'pending',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  approved_at     TIMESTAMPTZ
);

-- Yeniliklər / elanlar
CREATE TABLE announcements (
  id      TEXT PRIMARY KEY,
  title   TEXT,
  body    TEXT,
  type    TEXT DEFAULT 'info',
  pinned  BOOLEAN DEFAULT FALSE,
  date    TIMESTAMPTZ DEFAULT NOW()
);

-- Parametrlər
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT DEFAULT ''
);

-- Default çeklist elementləri
INSERT INTO checklist_items (item_id, text, category, sort_order, active) VALUES
  ('CI-001', 'Açılış hazırlığı (stol, stul, avadanlıq)',    'Açılış',   1, TRUE),
  ('CI-002', 'Kassa balansının yoxlanması',                  'Açılış',   2, TRUE),
  ('CI-003', 'Temperatur jurnalının doldurulması',           'Gigiyena', 3, TRUE),
  ('CI-004', 'Soyuducu / vitrin yoxlaması',                  'Gigiyena', 4, TRUE),
  ('CI-005', 'Stok sayımı və çatışmazlıq qeydi',             'Stok',     5, TRUE),
  ('CI-006', 'Personalın geyim / görünüş yoxlaması',         'Personal', 6, TRUE),
  ('CI-007', 'Müştəri şikayətlərinin nəzərdən keçirilməsi',  'Xidmət',   7, TRUE),
  ('CI-008', 'Günün hesabatının hazırlanması',               'Bağlanış', 8, TRUE),
  ('CI-009', 'Bağlanış yoxlaması (qapı, işıq, avadanlıq)',   'Bağlanış', 9, TRUE);