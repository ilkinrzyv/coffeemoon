-- ══════════════════════════════════════════════════════════════
--  Streak & Test rejimi sütunları
--  Supabase SQL Editor-də işlət (mövcud bazalar üçün)
-- ══════════════════════════════════════════════════════════════

-- Davamiyyət seriyası (gün-gün gəliş seriyası)
ALTER TABLE employees ADD COLUMN IF NOT EXISTS streak INTEGER DEFAULT 0;

-- Test rejimi işçisi (streak/xp həmişə maksimum göstərilir, XP qazanmır)
ALTER TABLE employees ADD COLUMN IF NOT EXISTS is_test BOOLEAN DEFAULT FALSE;
