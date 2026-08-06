-- ══════════════════════════════════════════════════════
--  Maaş ayının BAĞLANMASI (snapshot)
--  Supabase SQL Editor-də işlət. Mövcud məlumata TOXUNMUR.
-- ══════════════════════════════════════════════════════
--  PROBLEM: `getSalaryReport` hər açılanda sıfırdan hesablayırdı. Yəni sentyabrda
--  Barista dərəcəsini 20→22 etsən, ARTIQ ÖDƏNİLMİŞ iyul hesabatı da 22 göstərirdi.
--  Eyni şey sonradan yazılan cərimə/avansa, cədvəl düzəlişinə, `recalcAllFines`-a aiddir.
--  Mübahisə çıxanda "biz hansı rəqəmlə ödəmişik?" sualının cavabı yox idi.
--
--  HƏLL: admin ayı BAĞLAYIR — həmin andakı rəqəmlər olduğu kimi saxlanılır və
--  hesabat bundan sonra o ay üçün snapshot-u qaytarır. Ay yenidən AÇILA bilər
--  (səhv düzəlişi üçün) — onda yenidən canlı hesablanır.

CREATE TABLE IF NOT EXISTS salary_periods (
  period     TEXT PRIMARY KEY,          -- 'YYYY-MM'
  closed_at  TIMESTAMPTZ DEFAULT NOW(),
  closed_by  TEXT DEFAULT 'admin',
  config     JSONB,                     -- bağlanan andakı SALARY_CONFIG (dərəcələr və s.)
  rows       JSONB,                     -- işçi-işçi hesablanmış sətirlər
  totals     JSONB                      -- yekunlar
);

ALTER TABLE salary_periods ENABLE ROW LEVEL SECURITY;  -- yalnız Service Role Key giriş əldə edir

-- Yoxlama: hansı aylar bağlıdır?
-- SELECT period, closed_at, closed_by,
--        (totals->>'cemi') AS verilen_cemi,
--        jsonb_array_length(rows) AS isci_sayi
-- FROM salary_periods ORDER BY period DESC;

-- Ayı əl ilə açmaq lazım olsa (panel də bunu edir):
-- DELETE FROM salary_periods WHERE period = '2026-08';
