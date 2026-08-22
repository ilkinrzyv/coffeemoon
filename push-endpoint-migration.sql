-- ══════════════════════════════════════════════════════════════════
--  PUSH ABUNƏLİKLƏRİ — ÇATIŞMAYAN UNİKAL İNDEKS
--  Supabase SQL Editor-də işlət
-- ══════════════════════════════════════════════════════════════════
--  PROBLEM (2026-08-21 auditi, F-06):
--
--  Kod abunəliyi belə yazır:
--      db().from('push_subscriptions').upsert(row, { onConflict: 'endpoint' })
--
--  `tdb.js` münaqişə hədəfinə müştərini əlavə edir (bu, QƏSDƏNDİR — ilkin
--  açarlar artıq `(tenant_id, …)` şəklindədir):
--      ON CONFLICT (tenant_id, endpoint)
--
--  Amma bazada belə unikal indeks YOX idi — yalnız `(endpoint)` üzrə qlobal
--  indeks və `(tenant_id, id)` ilkin açarı vardı. Postgres bu halda:
--      42P10: there is no unique or exclusion constraint matching
--             the ON CONFLICT specification
--  qaytarır. Kod isə `error`-u oxumadan `{ ok: true }` deyirdi →
--  HEÇ BİR yeni push abunəliyi yazılmırdı, panel isə «abunə olundu» göstərirdi.
--
--  Bu skript çatışmayan indeksi yaradır. Kod tərəfi artıq düzəldilib
--  (`savePushSubscription`) və indeks olmadan da işləyir — sadəcə ehtiyat
--  yolla (sil+yaz) və konsola xəbərdarlıq yazaraq. Bu skriptdən sonra
--  sürətli yol (upsert) işə düşür və xəbərdarlıq kəsilir.
-- ══════════════════════════════════════════════════════════════════


-- ─── PART 1: Yoxlama — təkrar sətir varmı? (heç nə dəyişmir) ─────────
--  Nəticə BOŞ gəlməlidir. `(endpoint)` üzrə qlobal unikal indeks onsuz da
--  təkrara imkan vermir, ona görə burada təmizlik lazım olmamalıdır.
--  Nə isə çıxsa, PART 2-ni işlətməzdən əvvəl artıqları sil.
SELECT tenant_id, endpoint, COUNT(*) AS tekrar_sayi
FROM push_subscriptions
GROUP BY tenant_id, endpoint
HAVING COUNT(*) > 1;


-- ─── PART 2: Çatışmayan indeksi yarat ───────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS idx_push_tenant_endpoint
  ON push_subscriptions (tenant_id, endpoint);


-- ─── PART 3 (könüllü): yoxla — indeks yarandımı? ────────────────────
SELECT indexname
FROM pg_indexes
WHERE tablename = 'push_subscriptions'
ORDER BY indexname;
--  Gözlənilən: idx_push_endpoint_global · idx_push_subs_emp · idx_push_tenant_endpoint


-- ─── PART 4 (könüllü): abunəlik sayı ────────────────────────────────
--  Miqrasiyadan sonra işçilər tətbiqi bir dəfə açanda abunəlik yenidən
--  yazılır. Bu rəqəmin günlər ərzində artdığını görməlisən.
SELECT tenant_id, COUNT(*) AS abunelik_sayi
FROM push_subscriptions
GROUP BY tenant_id
ORDER BY abunelik_sayi DESC;
