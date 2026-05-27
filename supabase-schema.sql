-- ══════════════════════════════════════════════════════
--  Coffeemoon — Supabase SQL Sxemi
--  Supabase Dashboard → SQL Editor → bu faylı yapışdır
-- ══════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS employees (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  dept      TEXT DEFAULT '',
  secret    TEXT UNIQUE,
  "deviceId" TEXT DEFAULT '',
  message   TEXT DEFAULT '',
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS attendance (
  id        BIGSERIAL PRIMARY KEY,
  "empId"   TEXT NOT NULL,
  "empName" TEXT,
  dept      TEXT,
  timestamp TIMESTAMPTZ NOT NULL,
  type      TEXT,
  overtime  TEXT DEFAULT '',
  "shiftType" TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS nahar (
  "naharId" TEXT PRIMARY KEY,
  "empId"   TEXT NOT NULL,
  "empName" TEXT,
  dept      TEXT,
  timestamp TIMESTAMPTZ NOT NULL,
  type      TEXT
);

CREATE TABLE IF NOT EXISTS "scanDevices" (
  "deviceId" TEXT PRIMARY KEY,
  branch    TEXT DEFAULT '',
  status    TEXT DEFAULT 'pending',
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  label     TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS cedvel (
  "cedvelId" TEXT PRIMARY KEY,
  "empId"    TEXT NOT NULL,
  "empName"  TEXT,
  dept       TEXT,
  "dateStr"  TEXT NOT NULL,
  "shiftType" TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS izin (
  "izinId"    TEXT PRIMARY KEY,
  "empId"     TEXT,
  "empName"   TEXT,
  dept        TEXT,
  "startDate" TEXT,
  "endDate"   TEXT,
  type        TEXT DEFAULT 'İzin',
  note        TEXT DEFAULT '',
  status      TEXT DEFAULT 'pending',
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "checklistItems" (
  "itemId"    TEXT PRIMARY KEY,
  text        TEXT,
  category    TEXT,
  "sortOrder" INTEGER DEFAULT 0,
  active      BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS "checklistLogs" (
  "logId"     TEXT PRIMARY KEY,
  date        TEXT,
  dept        TEXT,
  "itemId"    TEXT,
  "itemText"  TEXT,
  checked     BOOLEAN DEFAULT FALSE,
  "checkedAt" TEXT DEFAULT '',
  "mgrNote"   TEXT DEFAULT '',
  "adminNote" TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS "mgrAcks" (
  "ackId"         TEXT PRIMARY KEY,
  date            TEXT,
  dept            TEXT,
  "globalAcked"   BOOLEAN DEFAULT FALSE,
  "globalAckedAt" TEXT DEFAULT '',
  "branchAcked"   BOOLEAN DEFAULT FALSE,
  "branchAckedAt" TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS products (
  "productId" TEXT PRIMARY KEY,
  name        TEXT,
  unit        TEXT DEFAULT 'ədəd',
  active      BOOLEAN DEFAULT TRUE,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "productLogs" (
  "logId"       TEXT PRIMARY KEY,
  "dateStr"     TEXT,
  dept          TEXT,
  "productId"   TEXT,
  "productName" TEXT,
  incoming      NUMERIC DEFAULT 0,
  wasted        NUMERIC DEFAULT 0,
  "savedAt"     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "mgrSchedule" (
  "schedId"   TEXT PRIMARY KEY,
  dept        TEXT,
  "dateStr"   TEXT,
  "shiftType" TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS "latePerms" (
  "permId"        TEXT PRIMARY KEY,
  "empId"         TEXT,
  "empName"       TEXT,
  dept            TEXT,
  "dateStr"       TEXT,
  "requestedTime" TEXT,
  status          TEXT DEFAULT 'pending',
  "createdAt"     TIMESTAMPTZ DEFAULT NOW(),
  "approvedAt"    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS announcements (
  id     TEXT PRIMARY KEY,
  title  TEXT,
  body   TEXT,
  type   TEXT DEFAULT 'info',
  pinned BOOLEAN DEFAULT FALSE,
  date   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT DEFAULT ''
);

-- ── Default çeklist elementləri ────────────────────────────────
INSERT INTO "checklistItems" ("itemId", text, category, "sortOrder", active) VALUES
  ('CI-001', 'Açılış hazırlığı (stol, stul, avadanlıq)',    'Açılış',   1, TRUE),
  ('CI-002', 'Kassa balansının yoxlanması',                  'Açılış',   2, TRUE),
  ('CI-003', 'Temperatur jurnalının doldurulması',           'Gigiyena', 3, TRUE),
  ('CI-004', 'Soyuducu / vitrin yoxlaması',                  'Gigiyena', 4, TRUE),
  ('CI-005', 'Stok sayımı və çatışmazlıq qeydi',             'Stok',     5, TRUE),
  ('CI-006', 'Personalın geyim / görünüş yoxlaması',         'Personal', 6, TRUE),
  ('CI-007', 'Müştəri şikayətlərinin nəzərdən keçirilməsi',  'Xidmət',   7, TRUE),
  ('CI-008', 'Günün hesabatının hazırlanması',               'Bağlanış', 8, TRUE),
  ('CI-009', 'Bağlanış yoxlaması (qapı, işıq, avadanlıq)',   'Bağlanış', 9, TRUE)
ON CONFLICT ("itemId") DO NOTHING;
