-- ══════════════════════════════════════════════════════
--  İşçi vəzifəsi (Barista / Cashier / Team Leader / Cleaner)
--  Supabase SQL Editor-də işlət. Mövcud məlumata TOXUNMUR.
-- ══════════════════════════════════════════════════════

-- Sütun adı `position`-dur, `role` DEYİL — çünki `role` artıq
-- imtahan suallarında (kassir/barista/umumi) işlədilir.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS position TEXT DEFAULT '';

-- Filial + vəzifə üzrə siyahılama üçün (işçi sayı artdıqca faydalıdır)
CREATE INDEX IF NOT EXISTS idx_employees_position ON employees(position);

-- Yoxlama: kimin vəzifəsi hələ boşdur?
-- SELECT dept, name, COALESCE(NULLIF(position,''),'— təyin edilməyib —') AS vezife
-- FROM employees ORDER BY dept, name;
