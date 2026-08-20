-- ══════════════════════════════════════════════════════════════
--  İNTİZAM TƏNBEHİ (töhmət) — AR Əmək Məcəlləsi
--  Supabase SQL Editor-də işlət
-- ══════════════════════════════════════════════════════════════
--  NİYƏ AYRI CƏDVƏL DEYİL:
--  Töhmət eyni hadisədən (gecikmə) doğur, eyni işçiyə aiddir, eyni
--  şəkildə e-imza ilə təsdiqlənir və eyni panellərdə göstərilir.
--  `fines` cədvəlinə iki sütun əlavə etmək bütün mövcud mexanizmi
--  (imza, admin siyahısı, silmə, işçi kartı) olduğu kimi işlədir.
--
--  TƏHLÜKƏSİZLİK: töhmətdə `amount = 0` olur → maaş hesabatındakı
--  cəm dəyişmir, hətta bir sorğu `kind` süzgəcini unutsa belə.
-- ══════════════════════════════════════════════════════════════

-- Qeydin növü:
--   'fine'    — pul cəriməsi
--   'tohmet'  — töhmət              (ƏM 186.2)
--   'siddetli'— şiddətli töhmət     (ƏM 186.2)
--   'sonuncu' — sonuncu xəbərdarlıq (ƏM 186.2)
ALTER TABLE fines ADD COLUMN IF NOT EXISTS kind TEXT DEFAULT 'fine';

-- İntizam tənbehi verilən gündən 6 ay qüvvədə olur (ƏM 190.1).
-- Bu tarixdən sonra işçi kartında göstərilmir.
ALTER TABLE fines ADD COLUMN IF NOT EXISTS expires_ymd TEXT;

-- Tənbeh vaxtından əvvəl götürülə bilər (ƏM 190) — kim və nə vaxt götürüb.
ALTER TABLE fines ADD COLUMN IF NOT EXISTS lifted_at TIMESTAMPTZ;
ALTER TABLE fines ADD COLUMN IF NOT EXISTS lifted_by TEXT;

-- Mövcud sətirlərin hamısı pul cəriməsidir
UPDATE fines SET kind = 'fine' WHERE kind IS NULL;

CREATE INDEX IF NOT EXISTS idx_fines_kind ON fines (tenant_id, kind, expires_ymd);

-- ── YOXLAMA ───────────────────────────────────────────────────
-- İşlətdikdən sonra bunu çalışdır, hamısı 'fine' görünməlidir:
--   SELECT kind, COUNT(*) FROM fines GROUP BY kind;
