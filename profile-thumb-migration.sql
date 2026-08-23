-- ══════════════════════════════════════════════════════════════════════════
--  KOMANDA SİYAHISI ÜÇÜN KİÇİK ŞƏKİL  (F-21)
--  Supabase SQL Editor-də işlət. Data SİLİNMİR, təkrar işlətmək təhlükəsizdir.
-- ══════════════════════════════════════════════════════════════════════════
--
--  PROBLEM
--  ───────
--  `getTeamProfiles` komanda siyahısında HƏR İŞÇİNİN TAM şəklini (base64)
--  qaytarırdı. Ölçüldü: 19 işçi, 9 şəkil → hər profil tabı açılışında 105 KB.
--  Bu, işçi sayı ilə xətti böyüyür (100 nəfərdə ~1 MB) və mobil internetdə
--  hər dəfə yenidən yüklənir.
--
--  HƏLL
--  ────
--  Panel şəkli saxlayanda 48×48 minik də yaradır (~1-2 KB) və siyahı onu
--  daşıyır. Tam şəkil yerində qalır — profil pəncərəsi açılanda göstərilir.
--
--  ⚠️ Bu fayl İŞLƏDİLMƏSƏ də sistem işləyir: kod sütunun yoxluğunu tanıyır,
--     profil miniksiz saxlanılır və siyahı köhnə qaydada tam şəkli daşıyır.
--
--  MÖVCUD ŞƏKİLLƏR: geriyə doldurma AVTOMATİKDİR. İşçi öz kartını açanda
--  panel miniyi yaradıb səssizcə saxlayır. Yəni əl ilə heç nə etmək lazım
--  deyil — günlər ərzində hamısı öz-özünə keçir və aralıqda üzlər itmir.
-- ══════════════════════════════════════════════════════════════════════════

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS photo_thumb TEXT DEFAULT '';


-- ─── YOXLAMA ──────────────────────────────────────────────────────────────
SELECT 'profiles.photo_thumb' AS teleb,
       EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name='profiles' AND column_name='photo_thumb') AS hazirdir;

-- ─── İRƏLİLƏYİŞ (istəyə görə) ─────────────────────────────────────────────
--  Neçə şəkil hələ miniyini gözləyir:
--
--    SELECT COUNT(*) FILTER (WHERE COALESCE(photo_data,'')  <> '') AS sekilli,
--           COUNT(*) FILTER (WHERE COALESCE(photo_thumb,'') <> '') AS minikli
--    FROM profiles;
--
--  «minikli» rəqəmi «şəkilli»yə çatanda keçid tamamlanıb.
