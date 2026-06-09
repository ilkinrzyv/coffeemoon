-- ══════════════════════════════════════════════════════════════
--  Menecer cərimələri — menecer əl ilə yazır, işçi e-imza ilə təsdiqləyir
--  QEYD: mövcud `fines` cədvəlindən AYRIDIR (o, avtomatik gecikmə
--  cərimələridir və recalcAllFines onları yenidən hesablayır/silir).
--  Supabase SQL Editor-də işlət.
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS mgr_fines (
  fine_id     TEXT PRIMARY KEY,
  emp_id      TEXT NOT NULL,
  emp_name    TEXT,
  dept        TEXT DEFAULT '',
  amount      NUMERIC(8,2) NOT NULL,
  reason      TEXT DEFAULT '',
  status      TEXT DEFAULT 'pending',   -- pending | acknowledged
  created_by  TEXT DEFAULT '',          -- cəriməni yazan menecer
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  acked_at    TIMESTAMPTZ               -- işçinin təsdiq (elektron imza) vaxtı
);

CREATE INDEX IF NOT EXISTS idx_mgrfines_emp  ON mgr_fines (emp_id, status);
CREATE INDEX IF NOT EXISTS idx_mgrfines_dept ON mgr_fines (dept, created_at);

ALTER TABLE mgr_fines ENABLE ROW LEVEL SECURITY;  -- yalnız Service Role Key giriş əldə edir
