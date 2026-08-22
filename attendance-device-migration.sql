-- ══════════════════════════════════════════════════════════════════
--  DAVAMİYYƏT QEYDİNƏ CİHAZ İZİ
--  Supabase SQL Editor-də işlət
-- ══════════════════════════════════════════════════════════════════
--  NİYƏ:
--  Qeydi HANSI kioskun yazdığı heç yerdə saxlanmırdı. Yəni «dostum məni
--  işə saldı» halında heç bir iz qalmırdı.
--
--  Bu sütun fırıldağın qarşısını ALMIR — könüllü şərik olan iki nəfəri
--  proqram dayandıra bilmir. Etdiyi şey SÜBUT yaratmaqdır: nümunə görünən
--  olanda davranış dəyişir.
--
--  Sütun dolandan sonra bunları soruşmaq olar:
--    · eyni cihaz bir neçə işçinin adından giriş yazırmı;
--    · bir işçinin girişləri hər dəfə fərqli cihazdan gəlirmi;
--    · bir kiosk qısa müddətdə anormal çox qeyd yazırmı.
--
--  Kod tərəfi artıq hazırdır və bu sütun OLMADAN da işləyir (`insertAttendance`
--  sütunsuz təkrarlayır və konsola xəbərdarlıq yazır). Bu skriptdən sonra
--  xəbərdarlıq kəsilir və iz yığılmağa başlayır.
-- ══════════════════════════════════════════════════════════════════


-- ─── PART 1: Sütunu əlavə et ────────────────────────────────────────
--  Köhnə sətirlərdə NULL qalır — bu normaldır, o qeydlər sütun yaranmazdan
--  əvvəl yazılıb.
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS device_id TEXT;

-- Sorğular «bu cihaz kimləri qeyd edib» şəklində olacaq
CREATE INDEX IF NOT EXISTS idx_attendance_device
  ON attendance (tenant_id, device_id, timestamp);


-- ─── PART 2: Yoxlama — sütun yarandımı? ─────────────────────────────
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'attendance' AND column_name = 'device_id';


-- ═══════════════════════════════════════════════════════════════════
--  AUDİT SORĞULARI (sütun dolduqdan sonra, bir neçə gün keçəndə)
-- ═══════════════════════════════════════════════════════════════════

-- (a) Bir cihaz neçə fərqli işçinin adından qeyd yazıb?
--     Kiosk üçün bu rəqəm YÜKSƏK olmalıdır (normal). Anormal hal aşağıdadır.
SELECT device_id, COUNT(DISTINCT emp_id) AS isci_sayi, COUNT(*) AS qeyd_sayi
FROM attendance
WHERE device_id IS NOT NULL
  AND timestamp > NOW() - INTERVAL '30 days'
GROUP BY device_id
ORDER BY isci_sayi DESC;


-- (b) ⚠️ ƏSAS SORĞU: bir işçi neçə fərqli cihazdan qeyd olunub?
--     Normal işçi həmişə öz filialının kioskundan keçir. Siyahının başındakılar
--     (2+ cihaz) baxılmalıdır — filial dəyişikliyi ola bilər, başqa şey də.
SELECT emp_name, emp_id, COUNT(DISTINCT device_id) AS cihaz_sayi,
       STRING_AGG(DISTINCT device_id, ', ') AS cihazlar
FROM attendance
WHERE device_id IS NOT NULL
  AND timestamp > NOW() - INTERVAL '30 days'
GROUP BY emp_name, emp_id
HAVING COUNT(DISTINCT device_id) > 1
ORDER BY cihaz_sayi DESC;


-- (c) Eyni cihazda 60 saniyə ərzində bir-birinin ardınca yazılan girişlər.
--     Növbə dəyişikliyində normaldır; sistemli təkrarlanırsa baxmağa dəyər.
SELECT device_id, emp_name, timestamp,
       timestamp - LAG(timestamp) OVER (PARTITION BY device_id ORDER BY timestamp) AS onceki_ile_ferq
FROM attendance
WHERE device_id IS NOT NULL AND type = 'GƏLİŞ'
  AND timestamp > NOW() - INTERVAL '7 days'
ORDER BY device_id, timestamp;
