-- ══════════════════════════════════════════════════════════════
--  Push Bildiriş Abunəlikləri
--  Supabase SQL Editor-də işlət
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         BIGSERIAL   PRIMARY KEY,
  emp_id     TEXT        NOT NULL,
  endpoint   TEXT        NOT NULL UNIQUE,
  p256dh     TEXT        NOT NULL,
  auth       TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indeks: işçiyə görə sürətli axtarış
CREATE INDEX IF NOT EXISTS idx_push_subs_emp_id ON push_subscriptions(emp_id);

-- Köhnə abunəlikləri avtomatik sil (30 gündən köhnə)
-- Bunun üçün pg_cron lazımdır; əl ilə silmək üçün:
-- DELETE FROM push_subscriptions WHERE created_at < NOW() - INTERVAL '30 days';

-- RLS (Row Level Security) — Service Role Key keçir, bu şərt yalnız müştəri bağlantısı üçün
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

-- Service role hər şeyi edə bilər (artıq belədir, amma aydınlıq üçün)
-- Heç bir public policy yoxdur → yalnız service key giriş əldə edir
