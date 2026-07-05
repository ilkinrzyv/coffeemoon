-- ══════════════════════════════════════════════════════════════════
--  ORPHAN CLEANUP — işçi siyahısında OLMAYAN (əvvəllər silinmiş) işçilərin
--  Supabase-də qalmış bütün datasını təmizləyir.
--
--  Kaskad silmə (API.removeEmployee) əlavə olunmazdan əvvəl silinən işçilərin
--  uşaq cədvəllərində (attendance, nahar, ...) datası "sahibsiz" qalmışdı.
--  Bu skript həmin sahibsiz sətirləri tapıb silir.
--
--  ⚠️ Supabase SQL Editor-də işlət. ADDIM-ADDIM:
--    1) ƏVVƏLCƏ PART 1 (kimlərin datası silinəcək) — yoxla.
--    2) SONRA  PART 2 (nə qədər sətir) — yoxla.
--    3) Razısansa PART 3-ü (DELETE) işlət.
--
--  Qeyd: is_test işçiləri employees cədvəlində real sətirdir → SİLİNMİR.
--        ops_issues.emp_id = '' (filial/kateqoriya problemi) → SİLİNMİR.
-- ══════════════════════════════════════════════════════════════════


-- ─── PART 1: Hansı "kabus" işçilərin datası var? (heç nə silmir) ─────
SELECT emp_id, MAX(emp_name) AS ad, COUNT(*) AS qeyd_sayi
FROM (
  SELECT emp_id, emp_name FROM attendance
  UNION ALL SELECT emp_id, emp_name FROM nahar
  UNION ALL SELECT emp_id, emp_name FROM cedvel
  UNION ALL SELECT emp_id, emp_name FROM izin
  UNION ALL SELECT emp_id, emp_name FROM late_perms
  UNION ALL SELECT emp_id, emp_name FROM avans
  UNION ALL SELECT emp_id, emp_name FROM fines
  UNION ALL SELECT emp_id, emp_name FROM mgr_fines
  UNION ALL SELECT emp_id, emp_name FROM xp_audit_log
  UNION ALL SELECT emp_id, emp_name FROM trainer_exams
  UNION ALL SELECT emp_id, emp_name FROM trainer_logs
  UNION ALL SELECT emp_id, emp_name FROM ops_emp_notes
  UNION ALL SELECT emp_id, emp_name FROM ops_issues
) a
WHERE emp_id <> '' AND emp_id NOT IN (SELECT id FROM employees)
GROUP BY emp_id
ORDER BY qeyd_sayi DESC;


-- ─── PART 2: Hər cədvəldə neçə sahibsiz sətir var? (heç nə silmir) ───
SELECT t AS cedvel, cnt AS silinecek_setir FROM (
  SELECT 'attendance'         AS t, COUNT(*) AS cnt FROM attendance         WHERE emp_id <> '' AND emp_id NOT IN (SELECT id FROM employees)
  UNION ALL SELECT 'nahar',              COUNT(*) FROM nahar              WHERE emp_id <> '' AND emp_id NOT IN (SELECT id FROM employees)
  UNION ALL SELECT 'cedvel',             COUNT(*) FROM cedvel             WHERE emp_id <> '' AND emp_id NOT IN (SELECT id FROM employees)
  UNION ALL SELECT 'izin',               COUNT(*) FROM izin               WHERE emp_id <> '' AND emp_id NOT IN (SELECT id FROM employees)
  UNION ALL SELECT 'late_perms',         COUNT(*) FROM late_perms         WHERE emp_id <> '' AND emp_id NOT IN (SELECT id FROM employees)
  UNION ALL SELECT 'avans',              COUNT(*) FROM avans              WHERE emp_id <> '' AND emp_id NOT IN (SELECT id FROM employees)
  UNION ALL SELECT 'fines',              COUNT(*) FROM fines              WHERE emp_id <> '' AND emp_id NOT IN (SELECT id FROM employees)
  UNION ALL SELECT 'mgr_fines',          COUNT(*) FROM mgr_fines          WHERE emp_id <> '' AND emp_id NOT IN (SELECT id FROM employees)
  UNION ALL SELECT 'xp_audit_log',       COUNT(*) FROM xp_audit_log       WHERE emp_id <> '' AND emp_id NOT IN (SELECT id FROM employees)
  UNION ALL SELECT 'trainer_exams',      COUNT(*) FROM trainer_exams      WHERE emp_id <> '' AND emp_id NOT IN (SELECT id FROM employees)
  UNION ALL SELECT 'trainer_logs',       COUNT(*) FROM trainer_logs       WHERE emp_id <> '' AND emp_id NOT IN (SELECT id FROM employees)
  UNION ALL SELECT 'profiles',           COUNT(*) FROM profiles           WHERE emp_id <> '' AND emp_id NOT IN (SELECT id FROM employees)
  UNION ALL SELECT 'push_subscriptions', COUNT(*) FROM push_subscriptions WHERE emp_id <> '' AND emp_id NOT IN (SELECT id FROM employees)
  UNION ALL SELECT 'ops_emp_notes',      COUNT(*) FROM ops_emp_notes      WHERE emp_id <> '' AND emp_id NOT IN (SELECT id FROM employees)
  UNION ALL SELECT 'ops_issues',         COUNT(*) FROM ops_issues         WHERE emp_id <> '' AND emp_id NOT IN (SELECT id FROM employees)
  UNION ALL SELECT 'reactions',          COUNT(*) FROM reactions          WHERE from_emp_id NOT IN (SELECT id FROM employees) OR to_emp_id NOT IN (SELECT id FROM employees)
) x
WHERE cnt > 0
ORDER BY cnt DESC;


-- ─── PART 3: SİLMƏ (atomik — hamısı birlikdə) ───────────────────────
--  PART 1 və 2-ni yoxlayandan SONRA bu bloku işlət.
BEGIN;
DELETE FROM attendance         WHERE emp_id <> '' AND emp_id NOT IN (SELECT id FROM employees);
DELETE FROM nahar              WHERE emp_id <> '' AND emp_id NOT IN (SELECT id FROM employees);
DELETE FROM cedvel             WHERE emp_id <> '' AND emp_id NOT IN (SELECT id FROM employees);
DELETE FROM izin               WHERE emp_id <> '' AND emp_id NOT IN (SELECT id FROM employees);
DELETE FROM late_perms         WHERE emp_id <> '' AND emp_id NOT IN (SELECT id FROM employees);
DELETE FROM avans              WHERE emp_id <> '' AND emp_id NOT IN (SELECT id FROM employees);
DELETE FROM fines              WHERE emp_id <> '' AND emp_id NOT IN (SELECT id FROM employees);
DELETE FROM mgr_fines          WHERE emp_id <> '' AND emp_id NOT IN (SELECT id FROM employees);
DELETE FROM xp_audit_log       WHERE emp_id <> '' AND emp_id NOT IN (SELECT id FROM employees);
DELETE FROM trainer_exams      WHERE emp_id <> '' AND emp_id NOT IN (SELECT id FROM employees);
DELETE FROM trainer_logs       WHERE emp_id <> '' AND emp_id NOT IN (SELECT id FROM employees);
DELETE FROM profiles           WHERE emp_id <> '' AND emp_id NOT IN (SELECT id FROM employees);
DELETE FROM push_subscriptions WHERE emp_id <> '' AND emp_id NOT IN (SELECT id FROM employees);
DELETE FROM ops_emp_notes      WHERE emp_id <> '' AND emp_id NOT IN (SELECT id FROM employees);
DELETE FROM ops_issues         WHERE emp_id <> '' AND emp_id NOT IN (SELECT id FROM employees);
DELETE FROM reactions          WHERE from_emp_id NOT IN (SELECT id FROM employees) OR to_emp_id NOT IN (SELECT id FROM employees);
COMMIT;
