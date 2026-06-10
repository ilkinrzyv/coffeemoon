-- ══════════════════════════════════════════════════════════════
--  Sistem (gecikmə) cərimələrinə işçi imzası
--  Supabase SQL Editor-də işlət
-- ══════════════════════════════════════════════════════════════

ALTER TABLE fines ADD COLUMN IF NOT EXISTS acked    BOOLEAN DEFAULT FALSE;
ALTER TABLE fines ADD COLUMN IF NOT EXISTS acked_at TIMESTAMPTZ;

-- Qeyd: recalcAllFines mövcud sətirləri yalnız yeniləyir (late_num/late_mins),
-- acked/acked_at sütunlarına toxunmur → imza qorunur.
