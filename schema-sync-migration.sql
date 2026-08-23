-- ══════════════════════════════════════════════════════════════════════════
--  SXEM UZLAŞDIRMASI  (F-10 + F-11)
--  Mövcud v3 bazasını `schema-v3-multitenant.sql` faylındakı KANONİK sxemə
--  gətirir. Supabase SQL Editor-də işlət — ADDIM-ADDIM.
--
--  Data SİLİNMİR (yeganə istisna: PART 3-dəki duplikat cədvəl sətirləri,
--  onlar da onsuz da səhvdir və biri saxlanılır).
--  Təkrar işlətmək təhlükəsizdir — hər addım `IF NOT EXISTS` ilədir.
-- ══════════════════════════════════════════════════════════════════════════
--
--  NİYƏ LAZIM OLDU
--  ───────────────
--  Sxem iki mənbədə yaşayırdı: canlı baza (`*-migration.sql` faylları əl ilə
--  işlədilirdi) və `schema-v3-multitenant.sql` (yeni müştəri buradan doğulur).
--  İkisi ayrıldı:
--
--   F-10  `tohmet-migration.sql` sxemə köçürülməmişdi → YENİ müştəridə
--         `fines.kind` / `expires_ymd` / `lifted_at` / `lifted_by` yox idi.
--         Kodda ehtiyat yol var (sütun yoxdursa cərimə sütunsuz yazılır), yəni
--         xəta GÖRÜNMÜR — intizam tənbehi sadəcə heç vaxt işləmir.
--
--   F-11  `uq_cedvel_emp_date` indeksi TENANT-SIZ idi — `(emp_id, date_str)`.
--         Bir müştərili dünyada düzgün idi; çox-müştərilidə isə A müştərisinin
--         işçisi B müştərisinin eyni ID-li işçisinin gününü bloklayır.
--         (Eyni ID nə üçün mümkündür: F-12 — köhnə ID generatoru vaxt möhürünün
--         yalnız son 5 simvolunu saxlayırdı, yəni 16 saat 47 dəqiqədən bir
--         təkrarlanırdı. İndi `U.newId` kəsilməmiş vaxt + crypto quyruq verir.)
-- ══════════════════════════════════════════════════════════════════════════


-- ─── PART 0: indi vəziyyət NECƏDİR? (heç nə dəyişmir) ─────────────────────
--  Bu sorğunu əvvəlcə işlət — hansı addımların lazım olduğunu göstərir.
SELECT 'fines.kind'            AS teleb, to_regclass('public.fines')      IS NOT NULL AS cedvel_var,
       EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name='fines' AND column_name='kind')           AS hazirdir
UNION ALL
SELECT 'mgr_fines.kind',       to_regclass('public.mgr_fines') IS NOT NULL,
       EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name='mgr_fines' AND column_name='kind')
UNION ALL
SELECT 'uq_cedvel_emp_date (tenant_id daxil)', TRUE,
       EXISTS (SELECT 1 FROM pg_indexes
               WHERE indexname='uq_cedvel_emp_date' AND indexdef LIKE '%tenant_id%');


-- ══════════════════════════════════════════════════════════════════════════
--  PART 1 — F-10: intizam tənbehi sütunları (AR ƏM 186.2 / 190.1)
-- ══════════════════════════════════════════════════════════════════════════
--  Töhmətdə `amount = 0` olur → maaş hesabatındakı cəm dəyişmir, hətta bir
--  sorğu `kind` süzgəcini unutsa belə.
--
--    'fine'     — pul cəriməsi
--    'tohmet'   — töhmət
--    'siddetli' — şiddətli töhmət
--    'sonuncu'  — sonuncu xəbərdarlıq

ALTER TABLE fines ADD COLUMN IF NOT EXISTS kind        TEXT DEFAULT 'fine';
ALTER TABLE fines ADD COLUMN IF NOT EXISTS expires_ymd TEXT;
ALTER TABLE fines ADD COLUMN IF NOT EXISTS lifted_at   TIMESTAMPTZ;
ALTER TABLE fines ADD COLUMN IF NOT EXISTS lifted_by   TEXT;
UPDATE fines SET kind = 'fine' WHERE kind IS NULL;
CREATE INDEX IF NOT EXISTS idx_fines_kind ON fines (tenant_id, kind, expires_ymd);

-- Cərimə tavanı (ƏM 175 → 20%) dolubsa menecer yalnız tənbeh yaza bilir →
-- eyni sütunlar `mgr_fines`-də də lazımdır.
ALTER TABLE mgr_fines ADD COLUMN IF NOT EXISTS kind        TEXT DEFAULT 'fine';
ALTER TABLE mgr_fines ADD COLUMN IF NOT EXISTS expires_ymd TEXT;
ALTER TABLE mgr_fines ADD COLUMN IF NOT EXISTS lifted_at   TIMESTAMPTZ;
ALTER TABLE mgr_fines ADD COLUMN IF NOT EXISTS lifted_by   TEXT;
UPDATE mgr_fines SET kind = 'fine' WHERE kind IS NULL;
CREATE INDEX IF NOT EXISTS idx_mgrfines_kind ON mgr_fines (tenant_id, kind, expires_ymd);


-- ══════════════════════════════════════════════════════════════════════════
--  PART 2 — F-11 (ÖNİZLƏMƏ): duplikat cədvəl sətirləri varmı?
-- ══════════════════════════════════════════════════════════════════════════
--  Heç nə dəyişmir. Boş nəticə = PART 3-də silinəcək heç nə yoxdur.
SELECT tenant_id, dept, emp_id, MAX(emp_name) AS ad, date_str, COUNT(*) AS tekrar_sayi
FROM cedvel
GROUP BY tenant_id, dept, emp_id, date_str
HAVING COUNT(*) > 1
ORDER BY tekrar_sayi DESC, tenant_id, dept;


-- ══════════════════════════════════════════════════════════════════════════
--  PART 3 — F-11: duplikatları təmizlə
-- ══════════════════════════════════════════════════════════════════════════
--  Hər (tenant_id, emp_id, date_str) üçün ƏN SONUNCU `cedvel_id` qalır.
--  Bu, oxuma tərəfi ilə EYNİ qaydadır: `getEmployeeShift` da
--  `.order('cedvel_id', desc).limit(1)` edir → görünən dəyər dəyişmir.
DELETE FROM cedvel a
USING cedvel b
WHERE a.tenant_id = b.tenant_id
  AND a.emp_id    = b.emp_id
  AND a.date_str  = b.date_str
  AND a.cedvel_id < b.cedvel_id;


-- ══════════════════════════════════════════════════════════════════════════
--  PART 4 — F-11: indeksi tenant-a bağla
-- ══════════════════════════════════════════════════════════════════════════
--  Köhnə (tenant-sız) indeks silinir və eyni adla yenidən — tenant_id ilə —
--  yaradılır. Ad eyni saxlanılır ki, iki mənbə (baza ↔ schema-v3) uzlaşsın.
DROP INDEX IF EXISTS uq_cedvel_emp_date;
CREATE UNIQUE INDEX uq_cedvel_emp_date ON cedvel (tenant_id, emp_id, date_str);

-- `idx_cedvel_emp_date` artıq lazım deyil: yuxarıdakı unikal indeks eyni
-- sütunlarla başlayır və Postgres onu axtarış üçün də işlədir.
DROP INDEX IF EXISTS idx_cedvel_emp_date;


-- ══════════════════════════════════════════════════════════════════════════
--  PART 5 — YOXLAMA
-- ══════════════════════════════════════════════════════════════════════════
--  Üç sətir də `hazirdir = true` olmalıdır.
SELECT 'fines.kind' AS teleb,
       EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name='fines' AND column_name='kind') AS hazirdir
UNION ALL
SELECT 'mgr_fines.kind',
       EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name='mgr_fines' AND column_name='kind')
UNION ALL
SELECT 'uq_cedvel_emp_date (tenant_id daxil)',
       EXISTS (SELECT 1 FROM pg_indexes
               WHERE indexname='uq_cedvel_emp_date' AND indexdef LIKE '%tenant_id%');

--  Qalan duplikat: 0 olmalıdır.
SELECT COUNT(*) AS qalan_duplikat FROM (
  SELECT tenant_id, emp_id, date_str FROM cedvel
  GROUP BY tenant_id, emp_id, date_str HAVING COUNT(*) > 1
) x;
