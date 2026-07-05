-- ══════════════════════════════════════════════════════════════════
--  CƏDVƏL DUPLİKAT FİKSİ
--
--  Problem: cedvel cədvəlində (emp_id, date_str) üzrə unikallıq yox idi.
--  Sürətli/təkrar saxlamalarda (delete+insert atom olmadığı üçün) eyni
--  işçi+gün üçün BİRDƏN ÇOX sətir yarana bilirdi. İşçi tərəfdəki oxuma
--  (.single()) təkrar sətirdə null qaytarırdı → işçi cədvəlini GÖRMÜRDÜ,
--  smen məntiqi ("sistemə düşmür") pozulurdu. Menecer görünüşü (.single()
--  işlətmirdi) düzgün görürdü — buna görə asimmetriya.
--
--  Kod tərəfi artıq düzəldilib (getEmployeeShift + getCedvel təkrara dözümlü).
--  Bu skript mövcud duplikatları təmizləyir və təkrarı DB səviyyəsində bloklayır.
--
--  ⚠️ Supabase SQL Editor-də ADDIM-ADDIM işlət.
-- ══════════════════════════════════════════════════════════════════


-- ─── PART 1: Duplikatlar hansı filial/işçilərdədir? (heç nə dəyişmir) ─
SELECT dept, emp_id, MAX(emp_name) AS ad, date_str, COUNT(*) AS tekrar_sayi
FROM cedvel
GROUP BY dept, emp_id, date_str
HAVING COUNT(*) > 1
ORDER BY tekrar_sayi DESC, dept;


-- ─── PART 2: Duplikatları təmizlə — hər (emp_id,date_str) üçün ən YENİ
--            (ən böyük cedvel_id) sətri saxla, qalanını sil ─────────────
DELETE FROM cedvel a
USING cedvel b
WHERE a.emp_id   = b.emp_id
  AND a.date_str = b.date_str
  AND a.cedvel_id < b.cedvel_id;


-- ─── PART 3: Bir daha duplikat yaranmasın — UNİKAL indeks ────────────
--  Bundan sonra eyni işçi+gün üçün 2-ci sətir insert edilməyə çalışsa
--  DB xəta verəcək (səssiz korrupsiya əvəzinə açıq xəta).
CREATE UNIQUE INDEX IF NOT EXISTS uq_cedvel_emp_date ON cedvel (emp_id, date_str);


-- ─── PART 4 (könüllü): yoxla — artıq duplikat qalmayıb ───────────────
SELECT COUNT(*) AS qalan_duplikat FROM (
  SELECT emp_id, date_str FROM cedvel GROUP BY emp_id, date_str HAVING COUNT(*) > 1
) x;
