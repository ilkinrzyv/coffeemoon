-- ══════════════════════════════════════════════════════════════════
--  KİOSKUN GÖRÜNƏN IP-si
--  Supabase SQL Editor-də işlət
-- ══════════════════════════════════════════════════════════════════
--  NİYƏ (2026-08-22 hadisəsi):
--  Filialın WiFi IP-si əl ilə yazılırdı. O rəqəm `api.ipify.org`-un gördüyü
--  ünvan idi; yoxlama isə serverin (Railway) gördüyü ünvanla müqayisə edir.
--  Eyni statik WiFi üçün bu ikisi fərqli çıxdı → bütün filialda giriş dayandı
--  və rəqəmi tapmaq üçün fiziki olaraq filiala getmək lazım gəldi.
--
--  HƏLL: kiosk özü müntəzəm siqnal göndərir, server həmin sorğunun GƏLDİYİ
--  ünvanı buraya yazır. Yəni filialın cari IP-si həmişə göz önündədir və
--  admin panelində bir kliklə siyahıya əlavə olunur — axtarmaq lazım deyil.
--
--  ⚠️ BU DƏYƏR AVTOMATİK QƏBUL EDİLMİR — yalnız TƏKLİFDİR.
--  Səbəb: cihaz ID-si QR kodun içindədir (`CMQR:<cihazID>:<pəncərə>`), yəni
--  QR fotosu olan hər kəsdə cihaz ID-si də var. Avtomatik qəbul etsəydik,
--  həmin adam evdən bir sorğu ilə filialın IP-sini özününkü ilə əvəz edib
--  girə bilərdi. Təsdiq insandadır — qorumanın mənası elə budur.
-- ══════════════════════════════════════════════════════════════════


-- ─── PART 1: Sütunları əlavə et ─────────────────────────────────────
ALTER TABLE scan_devices ADD COLUMN IF NOT EXISTS last_ip   TEXT;
ALTER TABLE scan_devices ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ;


-- ─── PART 2: Yoxlama ────────────────────────────────────────────────
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'scan_devices' AND column_name IN ('last_ip', 'last_seen')
ORDER BY column_name;


-- ─── PART 3: Kiosklar bir neçə dəqiqə işlədikdən sonra ──────────────
--  Hər filialın kioskunun harada göründuyu. `wifi_ips` ilə tutuşdur —
--  fərqlidirsə admin panelində «Siyahıya əlavə et» düyməsi çıxacaq.
SELECT d.branch,
       d.device_id,
       d.last_ip,
       d.last_seen,
       b.wifi_ips AS icazeli_siyahi
FROM scan_devices d
LEFT JOIN branches b
       ON b.tenant_id = d.tenant_id AND b.name = d.branch
WHERE d.status = 'active'
ORDER BY d.branch;
