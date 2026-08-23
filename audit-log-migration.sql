-- ══════════════════════════════════════════════════════════════════════════
--  HADİSƏ JURNALI + AYIN YENİDƏN AÇILMASI  (audit_log, F-16)
--  Supabase SQL Editor-də işlət. Data SİLİNMİR, təkrar işlətmək təhlükəsizdir.
-- ══════════════════════════════════════════════════════════════════════════
--
--  NİYƏ LAZIM OLDU
--  ───────────────
--  1. «Kim nə vaxt nəyi dəyişdi» sualının cavabı yalnız `xp_audit_log`-da vardı.
--     Cərimənin silinməsi, ayın açılması, açarın yenilənməsi, maaş dərəcəsinin
--     dəyişməsi, işçinin filialının dəyişməsi — hamısı izsiz idi. İşçi «mən bunu
--     imzalamamışam» desə, sistemin deyəcək sözü yox idi.
--
--  2. F-16: `reopenSalaryMonth` `salary_periods` sətrini SİLİRDİ. Yəni «bu ay
--     bağlananda rəqəmlər bunlar idi» sənədi geri dönməz itirdi — halbuki ayın
--     bağlanmasının bütün mənası elə odur.
--
--  ⚠️ Bu fayl İŞLƏDİLMƏSƏ də sistem işləyir: kod hər iki halı tanıyır
--     (jurnal yazılmır, ay isə köhnə qaydada silinir) və konsola xəbərdarlıq düşür.
-- ══════════════════════════════════════════════════════════════════════════


-- ─── PART 1: hadisə jurnalı ───────────────────────────────────────────────
--  Sətir `tdb.js`-dəki yazmadan DOĞUR, funksiyanın yadına düşməsindən yox —
--  yəni yeni API funksiyası heç nə etmədən jurnala düşür (izahı: audit.js).
--
--  `detail` sütununda AÇAR/SECRET YOXDUR: `audit.js` sorğunun öz açarı ilə
--  üst-üstə düşən hər dəyəri `***` ilə əvəz edir, uzun sətirləri kəsir.
CREATE TABLE IF NOT EXISTS audit_log (
  tenant_id  TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  log_id     TEXT NOT NULL,
  ts         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor_role TEXT NOT NULL DEFAULT '',         -- admin | manager | exec | trainer | ops | employee | public
  actor_name TEXT NOT NULL DEFAULT '',         -- «menecer (Elmlər)» — açar DEYİL
  action     TEXT NOT NULL DEFAULT '',         -- API funksiyasının adı
  target     TEXT NOT NULL DEFAULT '',         -- «fines:delete, employees:update»
  detail     TEXT NOT NULL DEFAULT '',         -- redaktə edilmiş arqumentlər
  before     JSONB,                            -- yalnız vacib yerlərdə (ayın snapshot-u)
  ok         BOOLEAN NOT NULL DEFAULT TRUE,    -- uğursuz cəhd də yazılır
  PRIMARY KEY (tenant_id, log_id)
);

CREATE INDEX IF NOT EXISTS idx_audit_ts     ON audit_log (tenant_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log (tenant_id, action, ts DESC);


-- ─── PART 2: F-16 — ay yenidən açılanda snapshot qalsın ───────────────────
ALTER TABLE salary_periods ADD COLUMN IF NOT EXISTS reopened_at TIMESTAMPTZ;
ALTER TABLE salary_periods ADD COLUMN IF NOT EXISTS reopened_by TEXT;

-- «Bağlı» sualı artıq `reopened_at IS NULL` ilə cavablanır.
CREATE INDEX IF NOT EXISTS idx_salary_open
  ON salary_periods (tenant_id, period) WHERE reopened_at IS NULL;


-- ─── PART 3: YOXLAMA ──────────────────────────────────────────────────────
--  Hər üç sətir `hazirdir = true` olmalıdır.
SELECT 'audit_log cədvəli' AS teleb,
       to_regclass('public.audit_log') IS NOT NULL AS hazirdir
UNION ALL
SELECT 'salary_periods.reopened_at',
       EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name='salary_periods' AND column_name='reopened_at')
UNION ALL
SELECT 'salary_periods.reopened_by',
       EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name='salary_periods' AND column_name='reopened_by');


-- ─── PART 4 (sonradan): jurnalın böyüməsi ─────────────────────────────────
--  Avtomatik təmizləmə QOYULMADI — nə qədər saxlamaq lazım olduğu hüquqi
--  qərardır, kod qərarı deyil. Nə qədər yer tutduğunu belə görə bilərsən:
--
--    SELECT tenant_id, COUNT(*) AS setir,
--           pg_size_pretty(pg_total_relation_size('audit_log')) AS olcu
--    FROM audit_log GROUP BY tenant_id;
--
--  Bir ildən köhnəni silmək lazım gələndə (ƏVVƏLCƏ yuxarıdakı sorğu ilə bax):
--
--    DELETE FROM audit_log WHERE ts < NOW() - INTERVAL '1 year';
