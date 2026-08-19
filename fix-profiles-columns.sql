-- ══════════════════════════════════════════════════════════════════════════
--  DÜZƏLİŞ: profiles cədvəlinə bəzək sütunları
--  YENİ layihədə (jpanhbrulpqpyihyyxpj) SQL Editor-də işlət.
-- ══════════════════════════════════════════════════════════════════════════
--  Səbəb: köhnə bazada işçilər öz kartlarını özəlləşdirib (tema, çərçivə,
--  banner, aura). Bu 4 sütun ilk sxemə düşməmişdi — onlarsız köçürmə
--  həmin seçimləri itirərdi.
--
--  Təhlükəsizdir: `IF NOT EXISTS` var, təkrar işlətmək olar, data silmir.
-- ══════════════════════════════════════════════════════════════════════════

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS card_theme   TEXT DEFAULT 'glass';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS frame_style  TEXT DEFAULT 'none';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS banner_style TEXT DEFAULT 'none';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS glow_effect  TEXT DEFAULT 'none';

-- Yoxlama: 4 sətir qayıtmalıdır
SELECT column_name
FROM information_schema.columns
WHERE table_name = 'profiles'
  AND column_name IN ('card_theme', 'frame_style', 'banner_style', 'glow_effect')
ORDER BY column_name;
