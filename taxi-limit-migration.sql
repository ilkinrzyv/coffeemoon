-- ══════════════════════════════════════════════════════
--  İşçi üzrə aylıq taksi limiti
--  Supabase SQL Editor-də işlət. Mövcud məlumata TOXUNMUR.
-- ══════════════════════════════════════════════════════

-- NULL = ümumi limit işlədilir (Maaşlar → Dərəcələr bölməsində, defolt 13).
-- Dəyər verilsə həmin işçi üçün fərdi limit olur.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS taxi_limit INTEGER;

COMMENT ON COLUMN employees.taxi_limit IS
  'Aylıq taksili smen limiti. NULL → SALARY_CONFIG.taxiMonthlyLimit (defolt 13).';

-- Yoxlama: kimin fərdi limiti var?
-- SELECT dept, name, COALESCE(taxi_limit::text, '— ümumi limit —') AS limit
-- FROM employees WHERE dept IN ('Ağ Şəhər','Gənclik') ORDER BY dept, name;
