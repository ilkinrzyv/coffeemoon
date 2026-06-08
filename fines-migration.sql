-- ══════════════════════════════════════════════════════════════
--  Cərimələr (gecikmə cərimələri) — DB-də audit izi
--  Supabase SQL Editor-də işlət
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS fines (
  fine_id    TEXT PRIMARY KEY,
  emp_id     TEXT NOT NULL,
  emp_name   TEXT,
  dept       TEXT,
  date_str   TEXT,
  amount     NUMERIC(8,2) DEFAULT 30,
  late_num   INTEGER,                 -- həmin ayda neçənci gecikmə
  late_mins  INTEGER,                 -- neçə dəqiqə gec
  reason     TEXT DEFAULT '',
  status     TEXT DEFAULT 'unpaid',   -- unpaid | paid | waived
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fines_emp_date ON fines (emp_id, date_str);
CREATE INDEX IF NOT EXISTS idx_fines_status   ON fines (status);
