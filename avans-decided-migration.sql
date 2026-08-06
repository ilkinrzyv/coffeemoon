-- ══════════════════════════════════════════════════════
--  Avansın QƏRAR tarixi (təsdiq/ödəniş günü)
--  Supabase SQL Editor-də işlət. Mövcud məlumata TOXUNMUR.
-- ══════════════════════════════════════════════════════
--  PROBLEM: maaş hesabatı avansı `date_str` (TƏLƏB tarixi) ilə aya bağlayırdı.
--  31 iyulda istənən, 2 avqustda təsdiqlənən avans iyula düşürdü — iyul maaşı
--  isə artıq verilmişdi → tutulma səssizcə itirdi.
--
--  HƏLL: qərar günü ayrıca saxlanılır və hesabat avansı HƏMİN aya yazır.
--  Tip TEXT-dir (TIMESTAMPTZ deyil) — sistemin qalan hissəsi kimi Baku yerli
--  gününü 'YYYY-MM-DD' saxlayır, belədə UTC sürüşməsi ay sərhədini pozmur.

ALTER TABLE avans ADD COLUMN IF NOT EXISTS decided_ymd TEXT;

COMMENT ON COLUMN avans.decided_ymd IS
  'Avansın təsdiq/ödəniş günü (Baku, YYYY-MM-DD). Maaş hesabatı tutulmanı bu aya yazır. NULL → date_str işlədilir (köhnə sətirlər).';

-- Aylıq hesabatın sorğusu üçün
CREATE INDEX IF NOT EXISTS idx_avans_decided ON avans (decided_ymd);

-- ── KÖHNƏ SƏTİRLƏR ──
-- Qəsdən BOŞ qalır: keçmiş avansların həqiqi təsdiq günü məlum deyil.
-- decided_ymd NULL olanda hesabat əvvəlki kimi date_str işlədir → keçmiş ayların
-- rəqəmləri DƏYİŞMİR. Yalnız bundan sonrakı qərarlar yeni qaydaya düşür.
--
-- Yoxlama: hansı avanslarda qərar günü var?
-- SELECT date_str AS teleb, decided_ymd AS qerar, status, emp_name, amount
-- FROM avans ORDER BY date_str DESC LIMIT 20;
