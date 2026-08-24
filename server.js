'use strict';
// Saat qurşağını sabitlə — bütün streak/XP/gecikmə məntiqi serverin yerli saatına güvənir.
// Railway env-də TZ varsa ona hörmət edir; yoxdursa Asia/Baku-ya düşür (lokal/itən env üçün qoruyucu).
process.env.TZ = process.env.TZ || 'Asia/Baku';
require('dotenv').config();
const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const U        = require('./utils');
const webpush  = require('web-push');

// ── Çox-müştərili qat ─────────────────────────────────────────────
//  T   — müştəri konteksti, parametrlər, filiallar, açarlar (tenant.js)
//  db  — avto-scope edən DB klienti (tdb.js). Xam `sb` BURADA İŞLƏDİLMİR:
//        hər sorğuya tenant filtri özü qoşulur, kontekst yoxdursa xəta atır.
//  raw — yalnız `tenants`/`auth_keys` üçün (platforma əməliyyatları).
const T = require('./tenant');
const { db, raw: sb } = require('./tdb');

const app  = express();
const PORT = process.env.PORT || 3000;

// API təhlükəsizlik qatı — icazə cədvəli auth.js-dədir.
const auth = require('./auth');

// Nahar limiti (dəqiqə): yalnız gec qayıdış bildirişi + nahar jurnalı üçün (XP ilə bağlı deyil — nahar XP-si ləğv edilib).
// Sabit deyil — hər müştəri paneldən təyin edir (`DISCIPLINE_CONFIG.lunchMaxMins`).
// Funksiya kimidir, çünki dəyər müştəri kontekstindən asılıdır; modul yüklənəndə oxuna bilməz.
const lunchMax = () => U.getDisciplineConfig().lunchMaxMins;

// ── VAPID konfiqurasiyası ─────────────────────────────────────────
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_EMAIL || 'mailto:admin@coffeemoon.az',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
} else {
  console.warn('⚠️  VAPID açarları tapılmadı — push bildirişlər deaktivdir.');
}

// ── Push köməkçi funksiya ─────────────────────────────────────────
async function sendPushToEmployee(empId, title, body, extra = {}) {
  if (!process.env.VAPID_PUBLIC_KEY) return;
  try {
    // db() — xam `sb` DEYİL. Səbəb: `emp_id` dəyərləri müştərilər arasında
    // toqquşur ('EXEC', 'TRAINER', 'MGR-<Filial>' hər müştəridə eynidir), ona
    // görə filtrsiz sorğu bir müştərinin bildirişini hamıya göndərirdi.
    const { data: subs } = await db()
      .from('push_subscriptions')
      .select('*')
      .eq('emp_id', String(empId));
    if (!subs?.length) return;

    const payload = JSON.stringify({
      title,
      body,
      icon:  '/icon-192.png',
      badge: '/icon-192.png',
      tag:   extra.tag  || 'coffeemoon',
      url:   extra.url  || '/mycode',
      requireInteraction: extra.requireInteraction || false,
    });

    await Promise.allSettled(
      subs.map(sub => webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload
      ).catch(async err => {
        // 410 Gone = abunəlik artıq etibarsızdır, sil
        if (err.statusCode === 410) {
          await db().from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
        }
      }))
    );
  } catch (e) {
    console.error('[Push]', e.message);
  }
}

// Manager-ə push göndər (dept adına görə)
async function sendPushToManager(dept, title, body, extra = {}) {
  if (!process.env.VAPID_PUBLIC_KEY) return;
  const mgrId = 'MGR-' + dept.replace(/\s+/g, '');
  await sendPushToEmployee(mgrId, title, body, extra);
}

// İcraçıya push göndər
async function sendPushToExec(title, body, extra = {}) {
  if (!process.env.VAPID_PUBLIC_KEY) return;
  await sendPushToEmployee('EXEC', title, body, extra);
}

// Trainerə (təlim meneceri) push göndər
async function sendPushToTrainer(title, body, extra = {}) {
  if (!process.env.VAPID_PUBLIC_KEY) return;
  await sendPushToEmployee('TRAINER', title, body, extra);
}

// Bütün aktiv işçilərə push göndər (elan üçün). Qaytarır: { sent, total }
async function sendPushToAll(title, body, extra = {}) {
  if (!process.env.VAPID_PUBLIC_KEY) { console.warn('[Push-all] VAPID açarı yoxdur — göndərilmədi'); return { sent: 0, total: 0 }; }
  try {
    const { data: subs, error } = await db().from('push_subscriptions').select('*');
    if (error) { console.error('[Push-all] abunəlik sorğusu xətası:', error.message); return { sent: 0, total: 0 }; }
    if (!subs?.length) { console.warn('[Push-all] heç bir abunəlik tapılmadı — push göndərilmədi'); return { sent: 0, total: 0 }; }
    const payload = JSON.stringify({
      title, body, icon: '/icon-192.png', badge: '/icon-192.png',
      tag: extra.tag || 'coffeemoon-announce', url: extra.url || '/mycode',
    });
    const results = await Promise.allSettled(
      subs.map(async sub => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payload
          );
          return true;
        } catch (err) {
          // 410 Gone = abunəlik etibarsızdır, sil
          if (err.statusCode === 410) {
            await db().from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
          }
          console.warn(`[Push-all] abunəlik xətası (status ${err.statusCode || '?'}): ${String(err.body || err.message || '').slice(0, 120)}`);
          return false;
        }
      })
    );
    const sent = results.filter(r => r.status === 'fulfilled' && r.value === true).length;
    console.log(`[Push-all] "${title}" → ${sent}/${subs.length} cihaza göndərildi`);
    return { sent, total: subs.length };
  } catch (e) {
    console.error('[Push-all]', e.message);
    return { sent: 0, total: 0 };
  }
}

// Cədvəldə smen yazılmayıbsa smenin neçə saat olduğunu təxmin edir.
// ƏVVƏL: `(dept === 'Ağ Şəhər' || dept === 'Gənclik') ? 9 : 8` — filial adları
// koda mıxlanmışdı. İNDİ: filialın öz konfiqurasiyasındakı səhər smeninin
// müddəti götürülür (o da yoxdursa 8 saat).
function fallbackShiftHours(dept) {
  const si = U.getShiftInfo(dept, 'sehersm');
  return (si && si.durH) || 8;
}

// ── Bağlanmamış smenlər ──────────────────────────────────────────
//  ⛔ SİLİNDİ: hər gecə 04:00-da avtomatik bağlama.
//  Səbəb: çıxış saatını UYDURURDU (gəliş + smen müddəti) — yəni işçi çıxış
//  etməsə də sanki vaxtında getmiş kimi yazılırdı və heç bir izi qalmırdı.
//  İndi açıq smen açıq qalır, işçi səhər GİRƏ BİLMİR və admin real saatı
//  yazıb təsdiqləyir (`getOpenShifts` / `closeOpenShift`).
//
//  Smenin gözlənilən bitmə vaxtı — adminə TƏKLİF kimi göstərilir,
//  o istəsə dəyişir. Avtomatik yazılmır.
function expectedShiftEnd(gelisDate, dept, shiftType) {
  const si   = shiftType ? U.getShiftInfo(dept, shiftType) : null;
  const reqH = si ? si.durH : fallbackShiftHours(dept);
  return new Date(gelisDate.getTime() + reqH * 3600000);
}

// ══════════════════════════════════════════════════════════════════
//  ƏKS-PROKSİ VƏ REAL IP
// ══════════════════════════════════════════════════════════════════
//  Railway tətbiqi əks-proksi arxasındadır — real IP `X-Forwarded-For`-dadır.
//
//  NİYƏ `true` YOX, `1`: `true` desək Express başlıqdakı ƏN SOLDAKI dəyəri
//  götürür, onu isə müştərinin özü yaza bilər → IP saxtalaşdırılardı və WiFi
//  qoruması mənasız qalardı. `1` "yalnız ən yaxın proksiyə (Railway edge)
//  etibar et" deməkdir; həmin proksinin özünün əlavə etdiyi dəyər alınır.
//
//  Zəncirdə əlavə proksi varsa (məs. Cloudflare) `TRUST_PROXY=2` ilə artırılır.
const TRUST_PROXY = (() => {
  const raw = process.env.TRUST_PROXY;
  if (raw === undefined || raw === '') return 1;
  const n = Number(raw);
  return Number.isFinite(n) ? n : raw;      // 'loopback' kimi adlar da qəbul olunur
})();
app.set('trust proxy', TRUST_PROXY);

// IPv4-uyğunlaşdırılmış IPv6 (`::ffff:1.2.3.4`) adi IPv4-ə çevrilir — əks halda
// filialın qeydə alınmış `1.2.3.4` IP-si heç vaxt uyğun gəlməzdi.
function normalizeIp(ip) {
  let s = String(ip || '').trim();
  if (!s) return '';
  if (s.startsWith('::ffff:')) s = s.slice(7);
  if (s === '::1') return '127.0.0.1';
  return s;
}
function requestIp(req) {
  return normalizeIp(req.ip || (req.socket && req.socket.remoteAddress) || '');
}

// ── Təhlükəsizlik başlıqları ──────────────────────────────────────
//  Referrer-Policy XÜSUSİLƏ vacibdir: panel açarı URL-dədir, səhifə isə
//  xarici resurslar yükləyir (Google Fonts, cdnjs). Referrer açıq qalsa
//  hər belə sorğu AÇARI kənar servisə göndərərdi.
//
//  QEYD: `camera` QƏSDƏN məhdudlaşdırılmır — işçi kartı QR oxumaq üçün
//  kameradan istifadə edir. CSP də QƏSDƏN qoyulmayıb: panellər inline
//  skript/stil və üç ayrı CDN işlədir, kor-koranə CSP hamısını sındırardı.
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), payment=()');
  next();
});

// Cavabları gzip ilə sıxır (HTML/JSON yükünü azaldır, səhifə daha tez açılır).
// Paket quraşdırılmayıbsa server yenə də normal işləyir — sadəcə sıxılma olmur.
try { app.use(require('compression')()); }
catch (_) { console.warn('⚠️  compression paketi yoxdur — sürət üçün `npm install compression` işlət.'); }

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ══════════════════════════════════════════════════════════════════
//  SƏHIFƏ MARŞRUTLARI
// ══════════════════════════════════════════════════════════════════

function readTemplate(name) {
  return fs.readFileSync(path.join(__dirname, 'public', name), 'utf8');
}

// Şablon dəyərləri təhlükəsiz yerləşdirilir — izahı və qaçış qaydaları tpl.js-də.
const { htmlEscape, replaceVars } = require('./tpl');
const auditlog = require('./audit');
//  Versiya TƏK MƏNBƏDƏN — package.json. Əvvəl altlıqlarda `1.0.1` hardcode idi
//  və package.json artıq `3.0.0` olduğu üçün YALAN göstərirdi. İndi görünmür,
//  amma `<footer data-v>` atributunda qalır: PWA köhnə nüsxəni keşləyəndə
//  «hansı versiyadasan» sualının cavabı lazım olur (bu, real hadisə olub).
const APP_VERSION = require('./package.json').version;

// ── Brend rəngi ──────────────────────────────────────────────────
//  Panellərin hamısı `--primary` CSS dəyişənindən istifadə edir. Müştərinin
//  rəngini hər faylda əl ilə dəyişmək əvəzinə `:root` blokunun SONUNA
//  elan siyahısı yeridirik — sonrakı elan əvvəlkini üstələyir.
//
//  Nə üçün <style> teqi yox, elan siyahısı? Çünki şablon dəyərləri HTML-escape
//  olunur (apostrof tələsinə qarşı). `--primary:#e11d48;` sətrində escape
//  olunası simvol yoxdur, ona görə təhlükəsiz keçir və ayrıca "xam yerləşdirmə"
//  mexanizmi açmağa ehtiyaq qalmır.
function hexToRgb(hex) {
  let h = String(hex || '').trim().replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
const clamp255 = (n) => Math.max(0, Math.min(255, Math.round(n)));
const toHex = (rgb) => '#' + rgb.map(n => clamp255(n).toString(16).padStart(2, '0')).join('');

// Rəngdən törəmə çalarlar: tünd (hover/gradient) və şəffaf (fon).
function brandCssVars(color) {
  const rgb = hexToRgb(color);
  if (!rgb) return '';                       // yanlış dəyər → panelin öz rəngi qalır
  const dark = rgb.map(n => n * 0.78);
  return [
    `--primary:${toHex(rgb)}`,
    `--primary-dark:${toHex(dark)}`,
    `--primary-light:rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.08)`,
    `--primary-rgb:${rgb[0]},${rgb[1]},${rgb[2]}`,
  ].join(';') + ';';
}

// ── Terminologiya ────────────────────────────────────────────────
//  Sistem kofeşop lüğəti ilə yazılıb. Mağaza/ofis/restoran üçün bəzi sözlər
//  uyğun gəlmir, ona görə müştəri onları dəyişə bilir.
//  Dəyişdirilməyən sözlər GÖNDƏRİLMİR — belədə brauzerdəki `terms.js` boş
//  siyahı görüb heç nə etmir (defolt müştərilər üçün sıfır risk).
const DEFAULT_TERMS = {
  'Filial':  'Filial',
  'Nahar':   'Nahar',
  'Avans':   'Avans',
  'Smen':    'Smen',
  'İşçi':    'İşçi',
  'İdarəçi': 'İdarəçi',
  'İzin':    'İzin',
  'Cərimə':  'Cərimə',
  'Çeklist': 'Çeklist',
  'Maaş':    'Maaş',
};

// Yalnız HƏQİQƏTƏN dəyişdirilmiş sözləri qaytarır.
function termOverrides() {
  const t = T.currentTenant();
  const custom = (t && t.brand && t.brand.terms) || {};
  const out = {};
  for (const key of Object.keys(DEFAULT_TERMS)) {
    const v = String(custom[key] || '').trim();
    if (v && v.toLowerCase() !== key.toLowerCase()) out[key] = v;
  }
  return out;
}

// Hər panel şablonuna müştərinin brendi əlavə olunur (başlıq, rəng, ikon, footer).
function brandVars() {
  const b = T.brand();
  const t = T.currentTenant();
  return {
    brandName:  b.name,
    brandIcon:  b.icon,
    brandColor: b.themeColor,
    brandBg:    b.bgColor,
    vendorName: T.VENDOR_NAME,
    appVersion: APP_VERSION,
    brandCss:   brandCssVars(b.themeColor),
    brandTerms: JSON.stringify(termOverrides()),
    tenantId:   (t && t.tenant_id) || '',
  };
}


// ══════════════════════════════════════════════════════════════════
//  AÇILIŞ EKRANI (splash)
// ══════════════════════════════════════════════════════════════════
//  Panel açılanda qısa marka anı: «Powered by IR SYSTEMS» görünür, nişanın
//  üstündən işıq zolağı keçir, sonra örtük pərdə kimi yuxarı qalxır.
//
//  Vaxt cədvəli (cəmi 1.30 san):
//    0.00 → 0.30   nişan yumşaq görünür        (irsIn)
//    0.26 → 0.88   işıq zolağı soldan sağa     (irsShine)
//    0.80 → 1.30   örtük yuxarı qalxır         (irsCurtain)
//  Zolaq bitməmiş pərdə başlayır — bu, QƏSDƏNDİR: aralıq boşluq qalsa
//  animasiya iki ayrı hərəkət kimi görünür, üst-üstə düşəndə tək axın olur.
//
//  ⚠️ ƏSAS QAYDA: bu, AÇILIŞA VAXT ƏLAVƏ ETMİR. Panellər onsuz da
//  «Yüklənir…» göstərir; örtük həmin boş vaxtın ÜSTÜNƏ qoyulmur, onu
//  ÖRTÜR. Animasiya oynayarkən sorğular artıq gedir.
//
//  Niyə server tərəfdə yerləşdirilir:
//    · Şablonda olsaydı 7 faylda təkrarlanardı və biri geridə qalardı
//      (bu layihədə dəfələrlə baş verən dreyf).
//    · `<body>`-dən dərhal sonra gəldiyi üçün ilk kadrda görünür —
//      JS gözlənilmir, «ağ sıçrayış» olmur.
//
//  Örtük MÜŞTƏRİNİN rəngindədir (brend), yazı isə satıcınındır: müştəri
//  öz tətbiqini görür, altında bizim imza qalır.
//
//  Fail-safe: JS ümumiyyətlə işləməsə belə örtük `opacity:0` ilə qalır və
//  `pointer-events:none` olduğu üçün heç nəyi bloklamır.
//
//  ⚠️ «HƏRƏKƏTİ AZALT» — İLK YAZILIŞDA SƏHV EDİLDİ.
//  Animasiyanı 0.01 saniyəyə endirmişdim; nəticədə örtük heç tərpənmədən
//  bir anlıq görünüb yox olurdu — istifadəçi bunu «mobildə animasiya
//  işləmir» kimi gördü. Səbəb: iOS-da «Hərəkəti azalt», Android-də isə
//  batareya qənaəti bu parametri açır, yəni bu, NADİR hal deyil.
//  Qayda odur ki, «hərəkəti azalt» BÜTÜN keçidi silmək demək deyil —
//  BÖYÜK hərəkəti silmək deməkdir. İndi miqyas yoxdur, yalnız yumşaq
//  şəffaflıq keçidi var və müddət demək olar ki eynidir.
//
//  ⚠️ İKİNCİ TƏLƏ — «animationend» hadisəsini ADLA yoxlamaq.
//  Əvvəlki yazılışda dinləyici `animationName==='irsThrough'` axtarırdı,
//  amma kiçik ekranda ad `irsThroughSm`, «hərəkəti azalt»da isə `irsFade`
//  olurdu — yəni hər iki halda örtüyü animasiya yox, EHTİYAT TAYMERİ
//  götürürdü. Görünüşdə bilinmirdi (örtük artıq şəffaf idi), amma ekranda
//  lazımsız qat qalırdı. İndi ad yox, HƏDƏF yoxlanır: `v.target===e`.
//  Kök elementdə yalnız çıxış animasiyası olduğu üçün bu, effekti
//  dəyişdirsək də sınmır.
//
//  Taymer animasiyanın SONUNDAN sonra gəlməlidir: 1.30 san + ehtiyat.
const SPLASH_MS = 1900;          // təhlükəsizlik taymeri — hər halda götürülür

function splashBlock() {
  const rgb  = hexToRgb(T.brand().themeColor) || [91, 94, 244];
  const base = toHex(rgb);
  const deep = toHex(rgb.map(n => n * 0.72));
  //  Böyük hərfə çevirmə CSS-dədir, JS-də YOX: `'i'.toUpperCase()` azərbaycanca
  //  «İ» yox, «I» verir. `text-transform` isə `<html lang="az">` qaydasına baxır.
  const ad   = htmlEscape(T.VENDOR_NAME);
  //  Zolaq nişandan SONRA gəlir və `z-index:2`-dir ki, işıq yazının
  //  ÜSTÜNDƏN keçsin — metal loqolardakı parıltı effekti budur.
  return `<div id="irSplash" aria-hidden="true"><div class="irs-bg"></div>` +
    `<div class="irs-mark"><span class="irs-pw">Powered by</span><span class="irs-nm">${ad}</span></div>` +
    `<div class="irs-shine"></div></div>` +
    `<style>#irSplash{position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;` +
    `pointer-events:none;overflow:hidden;will-change:transform,opacity;` +
    `animation:irsCurtain .50s cubic-bezier(.76,0,.24,1) .80s forwards}` +
    `#irSplash .irs-bg{position:absolute;inset:0;background:linear-gradient(160deg,${base} 0%,${deep} 100%)}` +
    `#irSplash .irs-mark{position:relative;text-align:center;color:#fff;` +
    `font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;animation:irsIn .30s ease-out both}` +
    `#irSplash .irs-pw{display:block;font-size:11px;font-weight:600;letter-spacing:.24em;` +
    `text-transform:uppercase;opacity:.62;margin-bottom:5px}` +
    `#irSplash .irs-nm{display:block;font-size:27px;font-weight:700;letter-spacing:.05em;text-transform:uppercase}` +
    `#irSplash .irs-shine{position:absolute;inset:0;z-index:2;transform:translateX(-100%);` +
    `will-change:transform;background:linear-gradient(105deg,transparent 38%,` +
    `rgba(255,255,255,.42) 50%,transparent 62%);` +
    `animation:irsShine .62s cubic-bezier(.4,0,.3,1) .26s forwards}` +
    `@keyframes irsShine{to{transform:translateX(100%)}}` +
    `@keyframes irsCurtain{to{transform:translateY(-101%)}}` +
    `@keyframes irsIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}` +
    `@keyframes irsFade{to{opacity:0}}` +
    `@keyframes irsInSoft{from{opacity:0}to{opacity:1}}` +
    // «Hərəkəti azalt»: sürüşmə də, qalxma da söndürülür — yalnız yumşaq
    // şəffaflıq keçidi qalır. Zolaq `display:none`-dur, yoxsa ekranın
    // eninə hərəkət edən ən böyük detal məhz o olardı.
    `@media(prefers-reduced-motion:reduce){` +
    `#irSplash{animation:irsFade .34s ease-in .52s forwards}` +
    `#irSplash .irs-shine{display:none}` +
    `#irSplash .irs-mark{animation:irsInSoft .24s ease-out both}}</style>` +
    `<script>(function(){var e=document.getElementById('irSplash');if(!e)return;var g=false;` +
    `function go(){if(g)return;g=true;if(e.parentNode)e.parentNode.removeChild(e);}` +
    `e.addEventListener('animationend',function(v){if(v.target===e)go();});` +
    `setTimeout(go,${SPLASH_MS});})();<\/script>`;
}

//  Örtüyü `<body>`-dən dərhal sonra yerləşdirir. Quruluş gözlənilməz olsa
//  səhifəyə TOXUNMUR — açılış effekti üçün panel sındırmağa dəyməz.
function withSplash(html) {
  const m = /<body[^>]*>/i.exec(html);
  if (!m) return html;
  const i = m.index + m[0].length;
  return html.slice(0, i) + splashBlock() + html.slice(i);
}

// ── Səhifə marşrutları üçün müştəri konteksti ─────────────────────
//  Panel URL-i açarı daşıyır (?key= / ?secret=). Açar həm KİM olduğunu, həm də
//  HANSI MÜŞTƏRİ olduğunu bildirir — ona görə subdomain məcburi deyil, mövcud
//  linklər və quraşdırılmış PWA-lar olduğu kimi işləyir.
//
//  `roles` — bu səhifəyə hansı rollar buraxılır.
//  `fn(req, res, rec)` yalnız açar etibarlı olduqda və müştəri aktivdirsə işləyir.
function denied(res, msg) {
  res.status(403).send(
    `<h2 style="color:#b91c1c;font-family:system-ui,sans-serif;padding:2rem">${htmlEscape(msg)}</h2>`
  );
}

function tenantPage(roles, fn) {
  return async (req, res) => {
    const key = String(req.query.key || req.query.secret || '');
    if (!key) return denied(res, 'İcazəsiz giriş.');
    let rec;
    try { rec = await T.resolveKey(key); }
    catch (e) { console.error('[Page] açar həlli:', e.message); return denied(res, 'Sistem xətası.'); }

    if (!rec || !roles.includes(rec.role)) return denied(res, 'İcazəsiz giriş.');

    const usable = T.tenantUsable(rec.tenantId);
    if (!usable.ok) return denied(res, usable.reason);

    return T.run({ tenantId: rec.tenantId, role: rec.role, branchId: rec.branchId }, async () => {
      try { await fn(req, res, rec); }
      catch (e) { console.error('[Page]', e.message); if (!res.headersSent) denied(res, 'Sistem xətası.'); }
    });
  };
}

// VAPID açıq açarı — frontend abunəlik üçün istifadə edir
app.get('/vapid-public-key', (_, res) =>
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || '' })
);

// PWA manifesti — brend müştəridən gəlir (əvvəl "Coffeemoon" hardcode idi).
function sendManifest(res, { title, short, desc, startUrl, bg, theme }) {
  const b = T.brand();
  res.setHeader('Content-Type', 'application/manifest+json');
  res.json({
    name: `${b.name} · ${title}`,
    short_name: short,
    description: desc,
    start_url: startUrl,
    display: 'standalone',
    background_color: bg || b.bgColor,
    theme_color: theme || b.themeColor,
    orientation: 'portrait',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  });
}

const scriptUrlOf = (req) => `${req.protocol}://${req.get('host')}`;

// ── AÇARSIZ SƏHIFƏLƏR ─────────────────────────────────────────────
//  `/scan` (kiosk) və `/exam` (işçi imtahanı) açar daşımır. Onlar hansı
//  müştəriyə aid olduğunu `?t=<slug>` ilə bildirir; səhifə bunu yadda saxlayır
//  və sonrakı API çağırışlarında `X-CM-Tenant` başlığı kimi göndərir.
//  DİQQƏT: bu göstərici YALNIZ 'public' səviyyəli funksiyalarda qəbul olunur —
//  açardan gələn müştərini heç vaxt üstələyə bilmir (aşağıda dispatcher-ə bax).
function tenantFromHint(req) {
  const hint = String(req.get('X-CM-Tenant') || req.query.t || '').trim();
  if (!hint) return null;
  if (T.getTenant(hint)) return hint;                 // birbaşa tenant_id
  const bySlug = T.allTenants().find(x => x.slug === hint);
  return bySlug ? bySlug.tenant_id : null;
}

// Açarsız səhifəni müştəri kontekstində göstərir (brend üçün).
function hintedPage(file, extraVars) {
  return (req, res) => {
    const tid = tenantFromHint(req);
    if (!tid) return denied(res, 'Ünvan natamamdır — hesab göstərilməyib.');
    const usable = T.tenantUsable(tid);
    if (!usable.ok) return denied(res, usable.reason);
    T.run({ tenantId: tid, role: 'public', branchId: null }, () => {
      res.send(replaceVars(readTemplate(file), {
        ...brandVars(),
        ...(extraVars ? extraVars(req) : {}),
        tenantHint: tid,
        scriptUrl: scriptUrlOf(req),
      }));
    });
  };
}

app.get('/scan', hintedPage('passpage.html'));

// ── İMTAHAN ───────────────────────────────────────────────────────
//  F-08: səhifə ƏVVƏL açarsız idi (`/exam?t=<slug>`) və işçi siyahıdan ÖZÜNÜ
//  seçirdi — yəni kim olduğunu SÖYLƏYİRDİ, sübut etmirdi. İndi işçinin öz
//  kart açarı (`secret`) ilə açılır, eynilə `/mycode` kimi: kimlik serverdə
//  həll olunur, səhifə heç kimin adından danışa bilmir.
//  Link işçinin öz kartındakı «İmtahan» düyməsindən gəlir.
app.get('/exam', tenantPage(['employee'], (req, res) => {
  const { secret = '' } = req.query;
  res.send(replaceVars(readTemplate('exam.html'), {
    ...brandVars(), secret, scriptUrl: scriptUrlOf(req),
  }));
}));

// ── İŞÇİ KARTI ────────────────────────────────────────────────────
app.get('/mycode', tenantPage(['employee'], (req, res) => {
  const { secret = '', name = 'İşçi' } = req.query;
  res.send(withSplash(replaceVars(readTemplate('mycode.html'), {
    ...brandVars(), secret, empName: name, scriptUrl: scriptUrlOf(req),
  })));
}));

app.get('/mycode-manifest', tenantPage(['employee'], (req, res) => {
  const { secret = '', name = 'İşçi' } = req.query;
  sendManifest(res, {
    title: name, short: name, desc: 'İşçi qeydiyyat kartı',
    startUrl: `/mycode?secret=${encodeURIComponent(secret)}&name=${encodeURIComponent(name)}`,
  });
}));

// ── MENECER ───────────────────────────────────────────────────────
app.get('/checklist', tenantPage(['manager'], (req, res, rec) => {
  const b = T.branchBySlug(rec.branchId);
  res.send(withSplash(replaceVars(readTemplate('checklist.html'), {
    ...brandVars(), branchKey: req.query.key, dept: (b && b.name) || '',
    scriptUrl: scriptUrlOf(req),
  })));
}));

app.get('/manager', tenantPage(['manager'], (req, res, rec) => {
  const b = T.branchBySlug(rec.branchId);
  res.send(withSplash(replaceVars(readTemplate('manager.html'), {
    ...brandVars(), branchKey: req.query.key, dept: (b && b.name) || '',
    scriptUrl: scriptUrlOf(req),
  })));
}));

app.get('/manager-manifest', tenantPage(['manager'], (req, res, rec) => {
  const b = T.branchBySlug(rec.branchId);
  const dept = (b && b.name) || 'Menecer';
  sendManifest(res, {
    title: dept, short: dept, desc: 'Menecer paneli',
    startUrl: `/manager?key=${encodeURIComponent(req.query.key || '')}`,
  });
}));

// ── ADMİN ─────────────────────────────────────────────────────────
app.get('/admin', tenantPage(['admin'], (req, res) => {
  res.send(withSplash(replaceVars(readTemplate('admin.html'), {
    ...brandVars(), adminKey: req.query.key, scriptUrl: scriptUrlOf(req),
  })));
}));

// ── TRAINER ───────────────────────────────────────────────────────
app.get('/trainer', tenantPage(['trainer'], (req, res) => {
  res.send(withSplash(replaceVars(readTemplate('trainer.html'), {
    ...brandVars(),
    trainerKey:  req.query.key,
    trainerName: U.getSetting('TRAINER_NAME') || 'Treninq Meneceri',
    scriptUrl:   scriptUrlOf(req),
  })));
}));

app.get('/trainer-manifest', tenantPage(['trainer'], (req, res) => {
  sendManifest(res, {
    title: 'Training', short: 'Training', desc: 'Təlim meneceri paneli',
    startUrl: `/trainer?key=${encodeURIComponent(req.query.key || '')}`,
    bg: '#f0f4f8', theme: '#0d9488',
  });
}));

// ── İCRAÇI ────────────────────────────────────────────────────────
app.get('/icraci', tenantPage(['exec'], (req, res) => {
  res.send(withSplash(replaceVars(readTemplate('icraci.html'), {
    ...brandVars(),
    execKey:   req.query.key,
    execName:  U.getSetting('EXEC_NAME') || 'İcraçı',
    scriptUrl: scriptUrlOf(req),
  })));
}));

app.get('/icraci-manifest', tenantPage(['exec'], (req, res) => {
  sendManifest(res, {
    title: 'İcraçı', short: 'İcraçı', desc: 'İcraçı paneli',
    startUrl: `/icraci?key=${encodeURIComponent(req.query.key || '')}`,
    bg: '#f1f5f9', theme: '#0d9488',
  });
}));

// ── ƏMƏLİYYAT (OPS) ───────────────────────────────────────────────
app.get('/ops', tenantPage(['ops'], (req, res) => {
  res.send(withSplash(replaceVars(readTemplate('ops.html'), {
    ...brandVars(),
    opsKey:    req.query.key,
    opsName:   U.getSetting('OPS_NAME') || 'Əməliyyat meneceri',
    scriptUrl: scriptUrlOf(req),
  })));
}));

app.get('/ops-manifest', tenantPage(['ops'], (req, res) => {
  sendManifest(res, {
    title: 'Əməliyyat', short: 'Əməliyyat', desc: 'Əməliyyat meneceri paneli',
    startUrl: `/ops?key=${encodeURIComponent(req.query.key || '')}`,
    bg: '#0b1020', theme: '#6366f1',
  });
}));

// ── PLATFORMA PANELİ ──────────────────────────────────────────────
//  Bu, MÜŞTƏRİ paneli deyil — platformanın sahibinindir (sən).
//  Müştəri kontekstindən KƏNARDA işləyir: bütün müştəriləri görür.
//  Ona görə `tenantPage()` işlədilmir — orada tenant konteksti qurulur.
app.get('/platform', (req, res) => {
  const key = String(req.query.key || '');
  if (!T.PLATFORM_KEY) {
    return denied(res, 'Platforma paneli bağlıdır — serverdə PLATFORM_KEY təyin edilməyib.');
  }
  if (key !== T.PLATFORM_KEY) return denied(res, 'İcazəsiz giriş.');
  res.send(replaceVars(readTemplate('platform.html'), {
    platformKey: key,
    scriptUrl:   scriptUrlOf(req),
  }));
});

// ── KÖK ───────────────────────────────────────────────────────────
//  ƏVVƏL: `/` → `/admin?key=${ADMIN_KEY}` yönləndirirdi, yəni saytı açan
//  HƏR KƏS admin açarını URL-də görürdü. Çox-müştərili sistemdə bu ölümcül
//  olardı. İndi kök sadəcə neytral səhifədir.
app.get('/', (_req, res) => {
  res.type('html').send(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
     <title>${htmlEscape(T.VENDOR_NAME)}</title>
     <div style="font-family:system-ui,sans-serif;display:flex;height:90vh;align-items:center;justify-content:center;text-align:center;color:#334155">
       <div><div style="font-size:2rem;margin-bottom:.4rem">👋</div>
       <div style="font-weight:600">Panelinizə giriş linki ilə daxil olun.</div>
       <div style="font-size:.85rem;color:#94a3b8;margin-top:.3rem">Linkiniz yoxdursa idarəçinizlə əlaqə saxlayın.</div></div>
     </div>`
  );
});

// ══════════════════════════════════════════════════════════════════
//  API MARŞRUTU
// ══════════════════════════════════════════════════════════════════
//  Hər sorğuda ardıcıllıq:
//    1. Açarı həll et → { tenantId, role }
//    2. Müştəri aktivdirmi? (dayandırılıbsa buraxma)
//    3. Rol bu funksiyanı çağıra bilirmi?
//    4. Funksiyanı MÜŞTƏRİ KONTEKSTİNDƏ işlət → bütün DB sorğuları avtomatik
//       həmin müştəri ilə məhdudlaşır (tdb.js)

// ── SÜRƏT LİMİTİ ──────────────────────────────────────────────────
//  Əvvəl layihədə heç bir limit yox idi: 10 000 variantlı PIN-i və panel
//  açarlarını istənilən sürətlə sınamaq olurdu.
//
//  Sayğacın özü `ratelimit.js`-dədir (yeridilə bilən `now` ilə — `test-ratelimit.js`
//  onu saat gözləmədən, dəqiq sərhədlərlə yoxlayır). Burada yalnız HƏDLƏR var.
//
//  ⚠️ HƏDLƏRİ SEÇƏRKƏN ƏSAS FAKT: BİR FİLİAL = BİR IP.
//  Kiosk və bütün işçi telefonları eyni NAT arxasındadır, yəni hədd bir nəfərə
//  yox, bütöv filiala tətbiq olunur. Ona görə rəqəmlər səxavətlidir — məqsəd
//  brute-force-u əlverişsiz etməkdir, növbə vaxtı işi dayandırmaq yox.
const { hit: rateHit, peek: ratePeek, ENABLED: RATE_LIMIT } = require('./ratelimit');
const RATE = {
  apiPerMin:    600,        // IP başına ümumi büdcə (panel yüklənməsi ~20-40 sorğudur)
  publicPerMin:  60,        // açarsız çağırışlar (imtahan, kiosk qeydiyyatı)
  pinFails:      30,        // 10 dəqiqədə neçə SƏHV PIN
  pinWindowMs: 600_000,
};

//  Açarsız `checkScanDevice` üçün hədlər (F-19). Real filialda eyni anda
//  1-2 cihaz təsdiq gözləyir; 20 səxavətli tavandır, spam isə minlərlə olardı.
const PENDING_DEVICE_LIMIT = 20;
const DEVICE_TG_PER_HOUR   = 5;

//  Yalnız UĞURSUZ PIN cəhdləri sayılır. Səbəb: uğurlu giriş normal iş axınıdır,
//  onu saymaq növbə vaxtı bütün filialı bloklayardı. Brute-force isə demək olar
//  həmişə uğursuz olur — yəni limit hücuma dəyir, istifadəçiyə dəymir.
function tooMany(res, r, label) {
  res.setHeader('Retry-After', String(r.retryAfter || 60));
  return res.status(429).json({ error: `Çox sayda sorğu. ${r.retryAfter} saniyə sonra yenidən cəhd edin.`, limit: label });
}

app.post('/api/:fn', async (req, res) => {
  const fn   = req.params.fn;
  const args = Array.isArray(req.body?.args) ? req.body.args : [];
  const ip   = requestIp(req);
  try {
    // 1) Ümumi büdcə — ƏN ƏVVƏL. Naməlum funksiya adları da bura düşməlidir,
    //    əks halda uydurma adlarla sorğu yağdırıb limiti keçmək olardı.
    const burst = rateHit('api', ip, RATE.apiPerMin, 60_000);
    if (!burst.ok) return tooMany(res, burst, 'api');

    const handler = API[fn];
    if (!handler) return res.status(404).json({ error: 'Funksiya tapılmadı: ' + fn });

    const rec   = await T.resolveKey(req.get('X-CM-Key') || '');
    const level = auth.API_POLICY[fn];

    // 2) Etibarlı açarı olmayan çağırışlar üçün daha dar büdcə.
    //    Açar sınamaq da bura düşür: hər səhv açar `rec === null` verir.
    if (!rec) {
      const pub = rateHit('pub', ip, RATE.publicPerMin, 60_000);
      if (!pub.ok) return tooMany(res, pub, 'public');
    }

    // 3) PIN brute-force qapısı — SORĞUDAN ƏVVƏL yoxlanılır.
    //    429 yox, adi cavab qaytarılır ki, kiosk ekranında aydın mətn görünsün
    //    («Sistem xətası» əvəzinə səbəb yazılsın).
    if (fn === 'validateAndLog') {
      const g = ratePeek('pin', ip, RATE.pinFails, RATE.pinWindowMs);
      if (!g.ok) {
        console.warn(`[RateLimit] PIN bloku — IP ${ip}, ${g.retryAfter} san qalıb`);
        return res.json({ valid: false, reason: `Çox sayda uğursuz cəhd. ${Math.ceil(g.retryAfter / 60)} dəqiqə sonra yenidən yoxlayın.` });
      }
    }

    // Müştərini tap: əvvəl açardan, yoxdursa yalnız 'public' funksiyalar üçün
    // səhifənin göstəricisindən. Göstərici açarı ÜSTƏLƏYƏ BİLMİR.
    let tenantId = rec && rec.tenantId;
    if (!tenantId && level === 'public') tenantId = tenantFromHint(req);

    if (rec && rec.role === 'platform') {
      // Platforma açarı müştəri kontekstindən kənardır — yalnız platform API-ləri.
      const acc = auth.apiAccess(fn, rec);
      if (!acc.ok) return res.status(403).json({ error: 'İcazəsiz.' });
      const result = await handler(...args);
      return res.json(result ?? null);
    }

    if (!tenantId) return res.status(401).json({ error: 'Hesab təyin edilmədi. Linki yenidən açın.' });

    const usable = T.tenantUsable(tenantId);
    if (!usable.ok) return res.status(402).json({ error: usable.reason });

    const acc = auth.apiAccess(fn, rec);
    if (!acc.ok) {
      if (auth.AUTH_ENFORCE) {
        // İcazəsiz cəhd jurnalda qalmalıdır — açar sınayan adamı yalnız bu göstərir.
        try {
          await T.run({ tenantId, role: (rec && rec.role) || 'public', branchId: (rec && rec.branchId) || null },
            () => writeAuditLog({ fn, rec, args, callerKey: req.get('X-CM-Key') || '',
                                  result: null, writes: [], denied: true }));
        } catch (le) { console.warn('[Audit]', fn, le.message); }
        return res.status(403).json({ error: 'İcazəsiz.' });
      }
      console.warn(`[AUTH] ${fn} — tələb: ${acc.level}, gələn rol: ${acc.role || 'yox'} (log-only)`);
    }

    //  `writes` QƏSDƏN burada yaradılır və kontekstə ötürülür: `tdb.js` içəridə
    //  ona əlavə edir, biz isə `T.run` bitəndən SONRA oxuyuruq. Kontekstin
    //  içindən oxumaq olmazdı — ALS store yalnız `run` müddətində yaşayır.
    const ctx = {
      tenantId,
      role:     (rec && rec.role)     || 'public',
      branchId: (rec && rec.branchId) || null,
      // Serverin gördüyü IP — `checkWifiIp` MƏHZ bunu oxuyur.
      // Müştərinin göndərdiyi IP arqumenti artıq qərara təsir etmir.
      clientIp: ip,
      writes:   [],
    };
    const result = await T.run(ctx, () => handler(...args));

    // Səhv PIN sayğacı — yalnız həqiqətən yanlış/vaxtı keçmiş kod sayılır.
    // İş qaydası ilə rədd (istirahət günü, açıq smen, WiFi) BURAYA DÜŞMÜR:
    // onlar real işçidir, cəza almamalıdırlar.
    if (fn === 'validateAndLog' && result && result.badPin) {
      const h = rateHit('pin', ip, RATE.pinFails, RATE.pinWindowMs);
      if (!h.ok) console.warn(`[RateLimit] PIN həddi doldu — IP ${ip}`);
    }

    // Hadisə jurnalı — cavabdan əvvəl, ayrıca kontekstdə (öz yazması
    // `ctx.writes`-a düşməsin deyə). Xətası udulur.
    try {
      await T.run(
        { tenantId, role: ctx.role, branchId: ctx.branchId },
        () => writeAuditLog({ fn, rec, args, callerKey: req.get('X-CM-Key') || '', result, writes: ctx.writes })
      );
    } catch (le) { console.warn('[Audit]', fn, le.message); }

    res.json(result ?? null);
  } catch (e) {
    // Xam `e.message` MÜŞTƏRİYƏ QAYTARILMIR: Supabase xətaları cədvəl/sütun
    // adlarını və sorğu quruluşunu açır. Tam mətn yalnız serverin logundadır;
    // `ref` ilə istifadəçinin gördüyü xəta log sətri ilə uzlaşdırılır.
    const ref = Date.now().toString(36).slice(-4).toUpperCase() +
                Math.floor(Math.random() * 1296).toString(36).toUpperCase().padStart(2, '0');
    console.error(`[API] ${fn} #${ref}:`, e.stack || e.message);
    res.status(500).json({ error: 'Sistem xətası baş verdi. Yenidən cəhd edin.', ref });
  }
});

// ══════════════════════════════════════════════════════════════════
//  KÖMƏKÇI
// ══════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════
//  SİL + YAZ  —  ATOMİK OLMAYAN ƏMƏLİYYATIN GERİ QAYTARILMASI (F-17)
// ══════════════════════════════════════════════════════════════════
//  Beş yerdə eyni naxış vardı: əvvəlcə `DELETE`, sonra `INSERT`.
//  `INSERT` sınsa (unikal indeks toqquşması, şəbəkə kəsilməsi, Supabase
//  timeout) köhnə sətirlər ARTIQ SİLİNMİŞ qalırdı və funksiya sadəcə
//  «Saxlama xətası» qaytarırdı. Menecer həftəlik cədvəli saxlayır, xəta
//  görür, səhifəni yeniləyir — cədvəl BOŞDUR.
//
//  Ən təmiz həll Postgres tranzaksiyasıdır (RPC), amma o, ayrıca SQL
//  funksiyası və miqrasiya tələb edir. Burada tətbiq qatında geri qaytarma
//  seçildi: silinən sətirlər yaddaşda saxlanılır və insert sınsa geri yazılır.
//
//  ⚠️ Bu, tranzaksiya DEYİL — iki sorğu arasında paralel yazma olsa nəticə
//  yenə qarışa bilər. Amma real ssenarini (insert sınır, data itir) bağlayır
//  və heç bir sxem dəyişikliyi tələb etmir.
//
//  `filtr` HƏM oxumaya, HƏM silməyə eyni şəkildə tətbiq olunur — ikisinin
//  ayrılması ən təhlükəli səhv olardı (bir dəst oxuyub başqasını silmək).
async function replaceRows(table, filtr, yeniSetirler, etiket) {
  const kohne = await filtr(db().from(table).select('*'));
  if (kohne.error) return { ok: false, reason: 'Oxuma xətası: ' + kohne.error.message };

  const del = await filtr(db().from(table).delete());
  if (del.error) return { ok: false, reason: 'Silmə xətası: ' + del.error.message };

  if (!yeniSetirler || !yeniSetirler.length) return { ok: true, restored: false };

  const ins = await db().from(table).insert(yeniSetirler);
  if (!ins.error) return { ok: true, restored: false };

  // ── Geri qaytarma ──
  const geri = (kohne.data || []).length
    ? await db().from(table).insert(kohne.data)
    : { error: null };
  if (geri.error) {
    // İkiqat uğursuzluq — data həqiqətən itdi. Bunu SUSDURMAQ olmaz.
    console.error(`[${etiket || table}] KRİTİK: insert sındı, geri qaytarma da sındı. ` +
                  `Silinən ${(kohne.data || []).length} sətir itdi. ` +
                  `insert: ${ins.error.message} | geri: ${geri.error.message}`);
    return { ok: false, restored: false,
             reason: 'Saxlama xətası: ' + ins.error.message + ' — köhnə data GERİ QAYTARILA BİLMƏDİ, idarəçiyə müraciət edin.' };
  }
  console.warn(`[${etiket || table}] insert sındı, köhnə ${(kohne.data || []).length} sətir geri yazıldı: ${ins.error.message}`);
  return { ok: false, restored: true,
           reason: 'Saxlama xətası: ' + ins.error.message + ' — əvvəlki məlumat qorundu, yenidən cəhd edin.' };
}

// ══════════════════════════════════════════════════════════════════
//  HADİSƏ JURNALI
// ══════════════════════════════════════════════════════════════════
//  Dispatcher hər sorğunun SONUNDA bunu çağırır. Sətir yalnız sorğu
//  həqiqətən nəsə YAZIBSA yaranır — oxuma sorğuları jurnala düşmür.
//  Bunu funksiyaların özü yox, `tdb.js` bilir (izahı: audit.js).
//
//  ⚠️ Jurnal HEÇ VAXT əsas əməliyyatı sındırmır: cədvəl hələ yaradılmayıbsa
//  (audit-log-migration.sql işlədilməyib) və ya yazma sınsa — yalnız konsola
//  bir dəfə xəbərdarlıq düşür. İstifadəçi bunu hiss etmir.
let _auditWarned = false;

//  Oxuyan funksiyalar — adına görə. Bu heuristika YALNIZ «rədd edilmiş cəhdi
//  yazaqmı?» sualına təsir edir: səhv təxmin ya artıq bir sətir yazdırır
//  (zərərsiz), ya da bir rəddi qaçırır (əvvəlki vəziyyət).
const OXUYAN_AD = /^(get|list|check|fetch|compute|peek|has)/;

async function writeAuditLog({ fn, rec, args, callerKey, result, writes, denied }) {
  if (auditlog.SKIP.has(fn)) return;                   // öz cədvəli iz olanlar

  const ugurlu = !denied && !(result && typeof result === 'object' &&
                   (result.success === false || result.valid === false || result.ok === false));

  //  Üç halda yazırıq:
  //    1. sorğu həqiqətən nəsə YAZDI;
  //    2. dispatcher onu İCAZƏSİZ saydı (403) — funksiyanın adından asılı
  //       olmayaraq, çünki açar sınayan adamı məhz bu göstərir;
  //    3. dəyişdirən funksiya özü RƏDD etdi (başqa filialın sətri, bağlı
  //       imtahan…). Burada yazma yoxdur, amma «kim nəyi etməyə çalışdı»
  //       izin ən vacib hissəsidir — F-13/F-14 kimi cəhdlər belə görünür.
  const yazdi = auditlog.hasRealWrite(writes);
  if (!yazdi && !denied && !(!ugurlu && !OXUYAN_AD.test(fn))) return;

  const { error } = await db().from('audit_log').insert({
    log_id:     U.newId('AL-'),
    ts:         new Date().toISOString(),
    actor_role: (rec && rec.role) || 'public',
    actor_name: actorLabel(rec),
    action:     fn,
    target:     denied ? '(icazəsiz)' : (auditlog.formatWrites(writes) || '(yazma yoxdur — rədd)'),
    detail:     auditlog.summarize(args, callerKey),
    ok:         ugurlu,
  });
  if (error && !_auditWarned) {
    _auditWarned = true;
    console.warn('[Audit] jurnal yazılmadı — audit-log-migration.sql işlədilib? ' + error.message);
  }
}

//  Vacib əməliyyatlar üçün ƏLAVƏ sətir — `before` sahəsi ilə.
//  Dispatcher-in avtomatik sətri «kim, nə vaxt, hansı funksiya» deyir, amma
//  «əvvəl NƏ İDİ» sualına cavab verə bilmir: o dəyəri yalnız funksiyanın özü
//  bilir. Ona görə bu, əl ilə çağırılır — həqiqətən əvəz olunmaz sənəd
//  itəndə (məsələn ayın snapshot-u).
async function auditDetail(action, target, before) {
  try {
    const { error } = await db().from('audit_log').insert({
      log_id:     U.newId('AL-'),
      ts:         new Date().toISOString(),
      actor_role: T.role() || 'system',
      actor_name: actorLabel({ role: T.role(), branchId: T.branchId() }),
      action:     String(action || ''),
      target:     String(target || ''),
      detail:     '',
      before:     before == null ? null : before,
      ok:         true,
    });
    if (error && !_auditWarned) {
      _auditWarned = true;
      console.warn('[Audit] jurnal yazılmadı — audit-log-migration.sql işlədilib? ' + error.message);
    }
  } catch (e) { console.warn('[Audit]', action, e.message); }
}

// Jurnalda «kim» sütunu. Açarın ÖZÜ heç vaxt yazılmır (bax audit.js — redaktə).
function actorLabel(rec) {
  if (!rec) return 'naməlum';
  if (rec.role === 'manager') {
    const b = T.branchBySlug(rec.branchId);
    return `menecer (${(b && b.name) || rec.branchId || '?'})`;
  }
  if (rec.role === 'employee') return 'işçi';
  return rec.role;
}

function sbErr(label, error) {
  if (error) console.error(`[SB] ${label}:`, error.message);
}

// ── Rol açarları ─────────────────────────────────────────────────
//  ƏVVƏL açarlar `settings`-də saxlanılırdı (TRAINER_KEY, EXEC_KEY, OPS_KEY) —
//  yəni bir sistem = bir açar. İNDİ `auth_keys` cədvəlindədir və hər müştərinin
//  öz dəsti var. `roleKey()` cari müştərinin həmin rol üçün aktiv açarını verir.
//  'self' funksiyalar öz açarlarını bununla yoxlayır.
function roleKey(r) {
  const tid = T.tenantIdOrNull();
  return (tid && T.findKey(tid, r, null)) || '';
}
const execAuth    = (k) => !!k && roleKey('exec')    === k;
const trainerAuth = (k) => !!k && roleKey('trainer') === k;

// Filial idarəçisinin adı — `branches.mgr_name` (əvvəl `MGR_NAME_<slug>` parametri)
function mgrNameOf(dept) {
  const b = T.branchByName(dept);
  return (b && b.mgr_name) || '';
}

// Sistem (avtomatik gecikmə) cəriməsini menecer cəriməsi ilə ortaq formata gətirir:
// Yazan = "Sistem", səbəb = niyə yazıldığı (gecikmə məlumatı).
// Menecer cəriməsi/tənbehi üçün növ məlumatı (sistem sətrində bunu normSystemFine edir).
// `kind` sütunu hələ yoxdursa sətir pul cəriməsi sayılır.
function novMelumat(r) {
  const kind = r.kind || 'fine';
  return {
    kind,
    kindName:   U.TOHMET_NAMES[kind] || 'Cərimə',
    isTohmet:   U.isTohmet(kind),
    aktiv:      U.isTohmet(kind) ? U.tohmetAktiv(r) : null,
    expiresYmd: r.expires_ymd || '',
    liftedAt:   r.lifted_at || '',
  };
}

function normSystemFine(r) {
  const reason = (r.reason && String(r.reason).trim())
    ? r.reason
    : `Gecikmə${r.late_num ? ` — bu ay ${r.late_num}-ci gecikmə` : ''}${r.late_mins ? `, ${r.late_mins} dəq gec` : ''}`;
  // `kind` sütunu hələ yoxdursa (migrasiya işlədilməyib) sətir pul cəriməsidir
  const kind = r.kind || 'fine';
  return {
    kind,
    kindName:  U.TOHMET_NAMES[kind] || 'Cərimə',
    isTohmet:  U.isTohmet(kind),
    // Tənbeh hələ qüvvədədirmi (ƏM 190.1 — 6 ay)
    aktiv:     U.isTohmet(kind) ? U.tohmetAktiv(r) : null,
    expiresYmd: r.expires_ymd || '',
    liftedAt:   r.lifted_at || '',
    fineId:    r.fine_id,
    empId:     r.emp_id,
    empName:   r.emp_name,
    amount:    r.amount,
    reason,
    status:    r.acked ? 'acknowledged' : 'pending',   // imza statusu (ödəniş statusu ayrıdır)
    // Maaşdan tutulma statusu: unpaid | paid | waived. Panel bunu göstərir ki,
    // admin cəriməni silməzdən əvvəl onun artıq tutulub-tutulmadığını görsün.
    payStatus: r.status || 'unpaid',
    dateStr:   r.date_str || '',
    createdBy: 'Sistem',
    createdAt: r.created_at || (r.date_str ? r.date_str + 'T00:00:00.000Z' : ''),
    ackedAt:   r.acked_at || '',
    source:    'system',
  };
}
// "Açıq" cərimə = hələ imzalanmayıb (hər iki mənbə üçün)
function fineIsOpen(f) {
  return f.status !== 'acknowledged';
}

// ── XP MÜHƏRRİKİ ─────────────────────────────────────────────────
// getXPMultiplier utils.js-də (tək mənbə — recalcAllXP də eyni formulu işlədir).

//  F-24: ƏVVƏL sadə oxu-dəyiş-yaz idi:
//      oxu xp → hesabla → yaz
//  İki XP hadisəsi eyni anda gəlsə (gəliş + milestone bonusu, yaxud imtahan
//  bitişi ilə üst-üstə düşsə) ikisi də EYNİ köhnə dəyəri oxuyur və biri
//  digərinin üstündən yazır — işçi bir mükafatı itirir. Sakit itki: nə xəta
//  var, nə də loq.
//
//  Postgres `xp = xp + n` bir sorğuda edərdi, amma PostgREST bunu birbaşa
//  dəstəkləmir (RPC funksiyası lazımdır → miqrasiya + ayrıca fayl).
//  Ona görə OPTİMİST KİLİD: yazma yalnız dəyər hələ də oxuduğumuz kimidirsə
//  keçir (`.eq('xp', current)`). Başqası qabaqlayıbsa `count = 0` gəlir və
//  döngə yenidən oxuyur. Bu, F-17-dəki yanaşma ilə eynidir — sxemə toxunmadan.
//
//  ⚠️ TƏK BAŞINA OPTİMİST KİLİD BƏS ETMƏDİ — testdə 5 paralel mükafatdan biri
//  4 cəhddən sonra da yazıla bilmədi (hamısı eyni anda oxuyub eyni anda
//  yazmağa çalışır). Ona görə iki qat var:
//    1. PROSES DAXİLİNDƏ növbə — eyni işçinin XP yazmaları ardıcıllaşır.
//       Railway-də bir nüsxə işlədiyi üçün real yarışı BÜSBÜTÜN aradan qaldırır.
//    2. Optimist kilid — birdən çox nüsxə işləsə (gələcəkdə) yenə qoruyur.
const XP_CEHD = 6;
const _xpNovbe = new Map();          // empId → son əməliyyatın vədi

//  Eyni işçi üçün əməliyyatları bir-birinin ardınca düzür.
//  Əvvəlki sınsa da növbə dayanmır (`.then(fn, fn)`).
function xpNovbede(empId, fn) {
  const evvelki = _xpNovbe.get(empId) || Promise.resolve();
  const indiki  = evvelki.then(fn, fn);
  const zencir  = indiki.catch(() => {});
  _xpNovbe.set(empId, zencir);
  // Növbə boşalanda xəritədən çıxar — yoxsa Map işçi sayı qədər böyüyür.
  zencir.then(() => { if (_xpNovbe.get(empId) === zencir) _xpNovbe.delete(empId); });
  return indiki;
}

async function awardXP(empId, baseAmount, streak) {
  return xpNovbede(String(empId), () => awardXPCore(empId, baseAmount, streak));
}

async function awardXPCore(empId, baseAmount, streak) {
  const gained = Math.round(baseAmount * U.getXPMultiplier(streak || 0));
  if (!gained) return 0;

  for (let cehd = 1; cehd <= XP_CEHD; cehd++) {
    const { data: emp } = await db().from('employees').select('xp').eq('id', empId).single();
    if (!emp) return 0;
    const current = Number(emp.xp) || 0;

    //  `xp` NULL ola bilər (miqrasiyadan əvvəlki sətir). SQL-də `= 0` NULL-a
    //  uyğun GƏLMİR, ona görə şərt ayrıca qurulur.
    let q = db().from('employees').update({ xp: current + gained }, { count: 'exact' }).eq('id', empId);
    q = (emp.xp === null || emp.xp === undefined) ? q.is('xp', null) : q.eq('xp', current);

    const { error, count } = await q;
    if (error) { sbErr('awardXP', error); return 0; }
    if (count === 1) return gained;
    // count === 0 → aradan başqası yazıb; yenidən oxu.
  }

  //  Bura düşmək praktiki olaraq mümkün deyil (4 dəfə dalbadal qabaqlanmaq).
  //  Susmuruq: XP itibsə, bunu görmək lazımdır.
  console.warn(`[XP] ${empId}: ${XP_CEHD} cəhddən sonra yazıla bilmədi (${gained} bal itdi)`);
  return 0;
}

// ══════════════════════════════════════════════════════════════════
//  API FUNKSİYALARI
// ══════════════════════════════════════════════════════════════════
const API = {};

// ── İŞÇİLƏR ─────────────────────────────────────────────────────

// `position` sütunu positions-migration.sql işlədilməyibsə hələ mövcud olmaya bilər.
// Deploy miqrasiyadan ƏVVƏL baş verə bilər — o aralıqda işçi əlavə etmək dayanmasın deyə
// əməliyyat sütunsuz təkrarlanır. Miqrasiya işlədiləndən sonra bu yol heç işə düşmür.
function positionColMissing(err) {
  const m = String((err && err.message) || '').toLowerCase();
  return m.includes('position') && (m.includes('column') || m.includes('schema') || m.includes('find'));
}

API.getEmployees = async () => {
  const { data, error } = await db().from('employees').select('*').order('name');
  sbErr('getEmployees', error);
  const emps = data || [];
  const result = emps.map(emp => ({
    id:       emp.id,
    name:     emp.name,
    dept:     emp.dept,
    position: emp.position || '',
    taxiLimit: (emp.taxi_limit === null || emp.taxi_limit === undefined) ? '' : emp.taxi_limit,
    secret:   emp.secret,
    message:  emp.message || '',
    is_test:  !!emp.is_test,
    streak:   emp.streak || 0,
    xp:       emp.xp || 0,
  }));
  return result.sort((a, b) => b.streak - a.streak);
};

// Mövcud vəzifə siyahısı — frontend onu koddan yox, buradan alır (tək mənbə)
API.getPositions = async () => U.POSITIONS;

// secret-siz işçi siyahısı — açarı olmayan səhifələr üçün (/exam) və trainer paneli.
// getEmployees admin-ə məxsusdur, çünki login açarını (secret) qaytarır.
API.getEmployeesLite = async () => {
  let { data, error } = await db().from('employees').select('id,name,dept,position,is_test').order('name');
  if (error && positionColMissing(error)) {
    ({ data, error } = await db().from('employees').select('id,name,dept,is_test').order('name'));
  }
  sbErr('getEmployeesLite', error);
  return (data || []).map(emp => ({
    id:       emp.id,
    name:     emp.name,
    dept:     emp.dept,
    position: emp.position || '',
    is_test:  !!emp.is_test,
  }));
};

API.addEmployee = async (name, dept, position) => {
  if (!name || !dept) return { success: false, reason: 'Ad və Filial tələb olunur.' };
  if (!U.DEPTS.includes(dept)) return { success: false, reason: 'Belə filial yoxdur: ' + dept };
  if (position && !U.isValidPosition(position)) return { success: false, reason: 'Belə vəzifə yoxdur: ' + position };

  // İşçi limiti (abunəlik planı) — 0 = limitsiz
  const t = T.currentTenant();
  if (t && t.max_employees > 0) {
    const { count } = await db().from('employees').select('id', { count: 'exact', head: true });
    if ((count || 0) >= t.max_employees) {
      return { success: false, reason: `Planınızda ən çox ${t.max_employees} işçi ola bilər.` };
    }
  }

  const id = U.newId('E');
  // Secret BÜTÜN platforma üzrə unikal olmalıdır — işçi /mycode?secret=… ilə
  // girəndə hansı müştəriyə aid olduğu yalnız bu dəyərdən tapılır. Ona görə
  // əvvəlki 8 simvol 16-ya qaldırıldı (toqquşma və təxmin riski).
  const secret = T.randomKey('E', 17);   // 'E' + 17 simvol = 85 bit (crypto.randomBytes)

  let { error } = await db().from('employees').insert({ id, name, dept, secret, position: position || '' });
  if (error && positionColMissing(error)) {
    ({ error } = await db().from('employees').insert({ id, name, dept, secret }));
  }
  sbErr('addEmployee', error);
  if (!error) T.cacheEmployeeSecret(secret, T.tenantId());
  return { success: !error };
};

// İşçini VƏ ona bağlı BÜTÜN datanı sil (davamiyyət, nahar, cədvəl, izin, XP, imtahan, profil, reaksiya, cərimə, ops qeydləri...).
// Diqqətli sıra: əvvəlcə uşaq cədvəllər, ən sonda işçi qeydi — belədə xəta olsa "sahibsiz" (orphan) sətir qalmır.
API.removeEmployee = async (id) => {
  if (!id) return { success: false, reason: 'İşçi ID tapılmadı.' };

  // İşçi həqiqətən varmı? (boş/yanlış id ilə səhvən silinmə olmasın)
  const { data: emp } = await db().from('employees').select('id,name,secret').eq('id', id).single();
  if (!emp) return { success: false, reason: 'İşçi tapılmadı.' };

  // emp_id sütunu ilə işçiyə bağlı bütün cədvəllər
  const empTables = [
    'attendance', 'nahar', 'cedvel', 'izin', 'late_perms', 'avans',
    'fines', 'mgr_fines', 'xp_audit_log', 'trainer_exams', 'trainer_logs',
    'profiles', 'push_subscriptions', 'ops_emp_notes', 'ops_issues',
  ];

  const failed = [];
  await Promise.all(empTables.map(async (t) => {
    const { error } = await db().from(t).delete().eq('emp_id', id);
    if (error) { sbErr('removeEmployee:' + t, error); failed.push(t); }
  }));

  // Reaksiyalar — həm göndərən, həm alan tərəf
  const { error: rFrom } = await db().from('reactions').delete().eq('from_emp_id', id);
  if (rFrom) { sbErr('removeEmployee:reactions_from', rFrom); failed.push('reactions'); }
  const { error: rTo } = await db().from('reactions').delete().eq('to_emp_id', id);
  if (rTo) { sbErr('removeEmployee:reactions_to', rTo); failed.push('reactions'); }

  // Bir hissə silinmədisə — işçini SAXLA, orphan yaratma, xəta qaytar (yenidən cəhd təmiz olsun).
  if (failed.length) {
    return { success: false, reason: 'Bəzi məlumatlar silinmədi: ' + [...new Set(failed)].join(', ') + '. İşçi silinmədi, yenidən cəhd edin.' };
  }

  // Ən sonda işçinin özünü sil
  const { error } = await db().from('employees').delete().eq('id', id);
  if (error) { sbErr('removeEmployee:employees', error); return { success: false, reason: 'İşçi qeydi silinmədi.' }; }
  T.forgetEmployeeSecret(emp.secret);   // açar keşindən də çıxsın (girişi dərhal bağlansın)
  return { success: true };
};

// Bütün işçilərin streakını yenidən hesabla (admin funksiyası)
API.recalcAllStreaks = async () => {
  const { data: emps } = await db().from('employees').select('id,dept,is_test');
  if (!emps) return { success: false, updated: 0 };
  let updated = 0;
  for (const emp of emps) {
    if (emp.is_test) continue;
    const streak = await U.calcStreak(emp.id, emp.dept);
    await db().from('employees').update({ streak }).eq('id', emp.id);
    updated++;
  }
  return { success: true, updated };
};

// Bütün işçilərin XP-sini (+streak +milestone) mövcud məlumatlardan SIFIRDAN yenidən hesabla.
// Manual düzəlişlərdən (saat redaktəsi, gec gəliş icazəsi və s.) sonra XP-ni reallıqla uyğunlaşdırır.
// dryRun=true → heç nə yazmır, yalnız köhnə/yeni müqayisəsini qaytarır.
API.recalcAllXP = async (dryRun) => {
  const { data: emps } = await db().from('employees').select('id,name,dept,is_test,xp,streak');
  const results = [];
  let updated = 0;
  for (const emp of emps || []) {
    if (emp.is_test) continue;
    const empId = String(emp.id);
    const [attendance, nahar, izinRows, perms, cedvelRows, audit, exams] = await Promise.all([
      db().from('attendance').select('timestamp,type,shift_type,overtime').eq('emp_id', empId),
      db().from('nahar').select('timestamp,type').eq('emp_id', empId),
      db().from('izin').select('start_date,end_date').eq('emp_id', empId).eq('status', 'approved'),
      db().from('late_perms').select('date_str,requested_time').eq('emp_id', empId).eq('status', 'approved'),
      db().from('cedvel').select('date_str,shift_type').eq('emp_id', empId),
      db().from('xp_audit_log').select('amount').eq('emp_id', empId),
      db().from('trainer_exams').select('trainer_name,answers,date_str').eq('emp_id', empId),
    ]);
    const permMap = {};
    for (const p of perms.data || []) { const [h, m] = (p.requested_time || '23:59').split(':').map(Number); permMap[p.date_str] = h * 60 + m; }
    const cedvelMap = {};
    for (const c of cedvelRows.data || []) cedvelMap[c.date_str] = c.shift_type || null;
    const auditSum = (audit.data || []).reduce((s, r) => s + (Number(r.amount) || 0), 0);

    const res = U.computeEmployeeXP(emp.dept, {
      attendance: attendance.data || [],
      nahar:      nahar.data     || [],
      izinRows:   izinRows.data  || [],
      permMap, cedvelMap, auditSum,
      exams:      exams.data     || [],
    });
    results.push({
      empId: emp.id, name: emp.name, dept: emp.dept,
      oldXP: emp.xp || 0, newXP: res.xp, dXP: res.xp - (emp.xp || 0),
      oldStreak: emp.streak || 0, newStreak: res.streak,
    });
    if (!dryRun) {
      await db().from('employees')
        .update({ xp: res.xp, streak: res.streak, milestones_claimed: res.milestones })
        .eq('id', emp.id);
      updated++;
    }
  }
  results.sort((a, b) => Math.abs(b.dXP) - Math.abs(a.dXP));
  return { success: true, updated, dryRun: !!dryRun, results };
};

// ── CƏRİMƏLƏR (admin) ────────────────────────────────────────────
API.getFines = async () => {
  const { data } = await db().from('fines').select('*').order('created_at', { ascending: false }).limit(300);
  return (data || []).map(r => ({
    fineId: r.fine_id, empId: r.emp_id, empName: r.emp_name, dept: r.dept,
    dateStr: r.date_str, amount: r.amount, lateNum: r.late_num, lateMins: r.late_mins,
    reason: r.reason || '', status: r.status || 'unpaid', createdAt: r.created_at || '',
  }));
};

API.updateFineStatus = async (fineId, status) => {
  if (!['unpaid', 'paid', 'waived'].includes(status)) return { success: false, reason: 'Yanlış status.' };
  const { error } = await db().from('fines').update({ status }).eq('fine_id', fineId);
  return { success: !error };
};

API.deleteFine = async (fineId) => {
  const { error } = await db().from('fines').delete().eq('fine_id', fineId);
  return { success: !error };
};

// Admin paneldən cərimə silmək — hər iki mənbə üçün tək giriş nöqtəsi.
// `source`: 'system' (avtomatik gecikmə cəriməsi) | 'manager' (menecerin yazdığı).
// Silinən sətir maaş hesabatındakı tutulmadan da çıxır — ona görə əvvəlcə
// nəyin silindiyi qaytarılır (panel təsdiq mesajında göstərir, audit üçün log).
API.deleteAnyFine = async (fineId, source) => {
  if (!fineId) return { success: false, reason: 'Cərimə seçilməyib.' };
  const table = source === 'manager' ? 'mgr_fines' : 'fines';
  const { data: row } = await db().from(table).select('*').eq('fine_id', fineId).single();
  if (!row) return { success: false, reason: 'Cərimə tapılmadı.' };
  const { error } = await db().from(table).delete().eq('fine_id', fineId);
  if (error) { sbErr('deleteAnyFine', error); return { success: false, reason: error.message }; }
  console.log(`[FINE-DELETE] ${table} ${fineId} — ${row.emp_name} ${row.amount} AZN`);
  return {
    success: true,
    empName: row.emp_name || '',
    amount:  Number(row.amount) || 0,
    source:  source === 'manager' ? 'manager' : 'system',
  };
};

// İntizam tənbehini VAXTINDAN ƏVVƏL götürmək (AR ƏM 190).
// Qeyd silinmir — audit izi qalır, sadəcə qüvvədən düşür və işçi kartında görünmür.
API.liftTohmet = async (fineId, note) => {
  if (!fineId) return { success: false, reason: 'Sənəd seçilməyib.' };
  const { data: row } = await db().from('fines').select('*').eq('fine_id', fineId).single();
  if (!row) return { success: false, reason: 'Sənəd tapılmadı.' };
  if (!U.isTohmet(row.kind)) return { success: false, reason: 'Bu, intizam tənbehi deyil.' };
  if (row.lifted_at) return { success: true, already: true };

  const { error } = await db().from('fines').update({
    lifted_at: new Date().toISOString(),
    lifted_by: ('Admin' + (note ? ' — ' + String(note).slice(0, 120) : '')),
  }).eq('fine_id', fineId);
  if (error) {
    if (/lifted_at|lifted_by/i.test(error.message || ''))
      return { success: false, reason: 'Sütunlar hələ yaradılmayıb — tohmet-migration.sql işlədilməlidir.' };
    sbErr('liftTohmet', error);
    return { success: false, reason: error.message };
  }
  console.log(`[Töhmət] ${row.emp_name} — ${fineId} vaxtından əvvəl götürüldü`);
  return { success: true, empName: row.emp_name || '' };
};

// Sistem cəriməsinin ödəniş statusu: unpaid | paid | waived.
// 'waived' = bağışlanıb → maaşdan tutulmur, amma tarixçə itmir (silməkdən təhlükəsizdir).
API.setFinePayStatus = async (fineId, status) => {
  if (!['unpaid', 'paid', 'waived'].includes(status))
    return { success: false, reason: 'Yanlış status.' };
  const { error } = await db().from('fines').update({ status }).eq('fine_id', fineId);
  if (error) { sbErr('setFinePayStatus', error); return { success: false, reason: error.message }; }
  return { success: true, status };
};

// ── AÇIQ (bağlanmamış) SMENLƏR ───────────────────────────────────
//  Axşam çıxış etməyən işçi səhər giriş edə bilmir. Admin burada həmin
//  smeni real çıxış saatı ilə bağlayır — bundan sonra işçi girə bilir.
//
//  Ayrıca cədvəl YOXDUR: siyahı davamiyyət qeydlərindən hesablanır.
//  Belədə "təsdiq gözləyir" vəziyyəti heç vaxt real data ilə ayrılmır.

// Neçə günlük geriyə baxılacağını konfiqurasiya deyir; siyahıda isə admin
// daha geniş pəncərə görmək istəyə bilər (köhnə qalıqları təmizləmək üçün).
async function openShiftRows(days) {
  const disc   = U.getDisciplineConfig();
  const gun     = Number(days) > 0 ? Number(days) : Math.max(disc.openShiftLookbackDays, 30);
  const cutoff  = new Date(Date.now() - gun * 86400000).toISOString();
  const todayYMD = U.getLogicalYMD(new Date());

  const { data: logs } = await db().from('attendance')
    .select('emp_id,emp_name,dept,timestamp,type,shift_type')
    .gte('timestamp', cutoff).order('timestamp');

  return U.findOpenShifts(logs, { exceptDay: todayYMD }).map(e => {
    const bitis = expectedShiftEnd(e.gelis, e.dept, e.shiftType);
    return {
      empId:     e.empId,
      empName:   e.empName,
      dept:      e.dept,
      dayStr:    e.dayStr,
      gelisTime: U.fmtTime(e.gelis),
      gelisIso:  e.gelis.toISOString(),
      shiftType: e.shiftType,
      shiftName: U.SHIFT_NAMES[e.shiftType] || '',
      // Adminə TƏKLİF — avtomatik yazılmır
      teklifTime: U.fmtTime(bitis),
      teklifIso:  bitis.toISOString(),
      // Bu qeyd girişi bloklayırmı? (pəncərədən köhnələr bloklamır)
      bloklayir: e.dayStr >= U.toYMD(new Date(Date.now() - disc.openShiftLookbackDays * 86400000)),
    };
  });
}

API.getOpenShifts = async (days) => {
  const rows = await openShiftRows(days);
  return { rows, blocking: rows.filter(r => r.bloklayir).length };
};

// Adminin təsdiqi: smeni verilən saatla bağlayır → işçi yenidən girə bilir.
// `endTime` — 'HH:MM' (həmin məntiqi günə görə). Boş qalsa təklif olunan vaxt.
API.closeOpenShift = async (empId, dayStr, endTime, note) => {
  if (!empId || !dayStr) return { success: false, reason: 'İşçi və gün tələb olunur.' };

  const rows = await openShiftRows(400);
  const hedef = rows.find(r => r.empId === String(empId) && r.dayStr === dayStr);
  if (!hedef) return { success: false, reason: 'Bu gün üçün açıq smen tapılmadı (bəlkə artıq bağlanıb).' };

  let bitis = new Date(hedef.teklifIso);
  if (endTime) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(endTime).trim());
    if (!m) return { success: false, reason: 'Saat formatı yanlışdır (HH:MM).' };
    const [h, mi] = [Number(m[1]), Number(m[2])];
    if (h > 23 || mi > 59) return { success: false, reason: 'Belə saat yoxdur.' };
    // Məntiqi gün + saat → real vaxt. Gün sərhədindən əvvəlki saat ERTƏSİ günə aiddir
    // (gecə smeni 01:30-da bitirsə, o, məntiqi günün SABAHKI təqvim günüdür).
    const [yy, mm, dd] = dayStr.split('-').map(Number);
    bitis = new Date(yy, mm - 1, dd, h, mi, 0, 0);
    if (h < U.getDisciplineConfig().dayCutoffHour) bitis.setDate(bitis.getDate() + 1);
    // Çıxış gəlişdən əvvəl ola bilməz
    if (bitis <= new Date(hedef.gelisIso))
      return { success: false, reason: 'Çıxış saatı gəlişdən sonra olmalıdır.' };
  }

  const { error } = await db().from('attendance').insert({
    emp_id:     hedef.empId,
    emp_name:   hedef.empName,
    dept:       hedef.dept,
    timestamp:  bitis.toISOString(),
    type:       'CIXIS',
    overtime:   ('Admin bağladı' + (note ? ' — ' + String(note).slice(0, 120) : '')),
    shift_type: hedef.shiftType || '',
  });
  if (error) { sbErr('closeOpenShift', error); return { success: false, reason: error.message }; }

  console.log(`[OpenShift] ${hedef.empName} ${dayStr} → ${U.fmtTime(bitis)} (admin)`);
  return { success: true, empName: hedef.empName, dayStr, endTime: U.fmtTime(bitis) };
};

// Köhnə qalıqları toplu təmizləmək üçün: hamısını TƏKLİF olunan vaxtla bağlayır.
// Gündəlik iş üçün deyil — bir dəfəlik təmizlikdir, ona görə ayrıca funksiyadır.
API.closeAllOpenShifts = async (days) => {
  const rows = await openShiftRows(days);
  let bagli = 0;
  for (const r of rows) {
    const { error } = await db().from('attendance').insert({
      emp_id: r.empId, emp_name: r.empName, dept: r.dept,
      timestamp: r.teklifIso, type: 'CIXIS',
      overtime: 'Admin bağladı — toplu', shift_type: r.shiftType || '',
    });
    if (error) sbErr('closeAllOpenShifts', error); else bagli++;
  }
  return { success: true, closed: bagli, total: rows.length };
};

// Cərimələri mövcud davamiyyətdən sıfırdan yenidən hesabla.
// İcazəli günlər (izin / gec gəliş icazəsi) çıxarılır; güzəşt sayından sonrakı
// gecikmələr cərimələnir. Məbləğ və güzəşt DISCIPLINE_CONFIG-dən gəlir —
// dərəcə dəyişdirilibsə mövcud cərimələrin məbləği də bu əməliyyatla düzəlir.
// Hələ mövcud cərimələrin paid/waived statusu qorunur; aradan qalxanlar silinir.
// Cəza sətrinin izahı — cərimə və tənbeh üçün fərqli yazılır
function cezaSebeb(ex) {
  return ex.kind === 'fine'
    ? `Bu ay ${ex.late_num}-ci gecikmə (${ex.late_mins} dəq)`
    : `${U.TOHMET_NAMES[ex.kind]} — bu ay ${ex.late_num}-ci gecikmə (${ex.late_mins} dəq)`;
}

// Bağlanmış ayların siyahısı (`salary_periods`). Cədvəl hələ yoxdursa boş dəst.
async function bagliAylar() {
  const { data, error } = await db().from('salary_periods').select('*');
  if (error) {
    if (!/salary_periods/i.test(error.message || '')) sbErr('bagliAylar', error);
    return new Set();
  }
  // F-16: yenidən açılmış ay bağlı deyil → `recalcAllFines` ona toxuna bilər.
  return new Set((data || []).filter(r => !r.reopened_at).map(r => r.period));
}

// `dryRun = true` → HEÇ NƏ YAZILMIR, yalnız nə dəyişəcəyi qaytarılır.
// (`recalcAllXP` ilə eyni naxış — geri dönməz əməliyyatdan əvvəl önizləmə.)
API.recalcAllFines = async (dryRun) => {
  const quru  = !!dryRun;
  const disc  = U.getDisciplineConfig();
  const first = disc.fineAfterLates + 1;   // neçənci gecikmədən cərimə başlayır
  const bagli = await bagliAylar();
  const { data: emps } = await db().from('employees').select('id,name,dept,is_test');
  let added = 0, removed = 0, kept = 0, imzali = 0, bagliAy = 0;
  const deyisiklikler = [];
  const qeyd = (empName, date, nov, izah) => {
    if (deyisiklikler.length < 500) deyisiklikler.push({ empName, date, nov, izah });
  };

  for (const emp of emps || []) {
    if (emp.is_test) continue;
    const empId = String(emp.id);
    const [att, izinRows, perms, fines] = await Promise.all([
      db().from('attendance').select('timestamp,shift_type').eq('emp_id', empId).eq('type', 'GƏLİŞ'),
      db().from('izin').select('start_date,end_date').eq('emp_id', empId).eq('status', 'approved'),
      db().from('late_perms').select('date_str,requested_time').eq('emp_id', empId).eq('status', 'approved'),
      db().from('fines').select('*').eq('emp_id', empId),
    ]);
    const permMap = {};
    for (const p of perms.data || []) { const [h, m] = (p.requested_time || '23:59').split(':').map(Number); permMap[p.date_str] = h * 60 + m; }
    const izin = izinRows.data || [];

    // Gəlişləri xronoloji oynat, ay üzrə gecikmələri say (icazəlilər çıxılır)
    const arrivals = (att.data || [])
      .map(r => ({ d: new Date(r.timestamp), shift: r.shift_type || '' }))
      .filter(r => !isNaN(r.d.getTime()))
      .sort((a, b) => a.d - b.d);
    const expected = {};      // date_str → { late_num, late_mins, kind }
    const monthCount = {};    // ay → üzrsüz gecikmə sayı
    for (const a of arrivals) {
      // MƏNTİQİ gün — təqvim günü YOX (F-23).
      // Gecə smenində 01:00-da gələn işçinin izni/icazəsi ƏVVƏLKİ günə yazılıb;
      // təqvim günü ilə axtarsaq tapılmır və işçi haqsız cərimə alır. Sistemin
      // qalan hissəsi (streak, XP, hesabat, validateAndLog) məntiqi günlə işləyir.
      const ds  = U.getLogicalYMD(a.d);
      const ym  = ds.slice(0, 7);
      const arr = a.d.getHours() * 60 + a.d.getMinutes();
      if (izin.some(r => ds >= r.start_date && ds <= r.end_date)) continue;        // tam gün izin
      if (ds in permMap && arr <= permMap[ds] + disc.permGraceMins) continue;      // icazə vaxtından tez
      const lim = U.getLateLimit(emp.dept, a.shift, arr);
      if (arr <= lim) continue;                                                    // vaxtında
      monthCount[ym] = (monthCount[ym] || 0) + 1;
      if (monthCount[ym] >= first) {
        // validateAndLog ilə EYNİ pilləkən: 1-ci cəza pul, sonrakılar tənbeh.
        // İki yerdə fərqli hesablasaq, «Cərimələri yenilə» töhmətləri cəriməyə çevirərdi.
        const kind = U.cezaKind(monthCount[ym] - disc.fineAfterLates, disc);
        expected[ds] = { late_num: monthCount[ym], late_mins: arr - lim, kind };
      }
    }

    const existing = fines.data || [];
    const existByDate = {};
    for (const f of existing) existByDate[f.date_str] = f;

    for (const f of existing) {
      const ay = String(f.date_str || '').slice(0, 7);

      // ── TOXUNULMAZ 1: işçinin E-İMZA ilə təsdiqlədiyi sənəd (F-15) ──
      //  İmza MƏHZ o sənədə verilib. Sonradan məbləği dəyişsək, yaxud cəriməni
      //  töhmətə çevirsək (töhmət 6 ay qüvvədədir), işçi imzalamadığı bir sənədlə
      //  üzləşir. AR ƏM baxımından bu zəif nöqtədir — ona görə toxunmuruq.
      if (f.acked) { imzali++; continue; }

      // ── TOXUNULMAZ 2: bağlanmış ay ──
      //  `salary_periods`-də snapshot var, yəni ay ödənilib. Sənədin özünü
      //  dəyişmək/silmək hesabatla sənəd arasında ziddiyyət yaradar.
      if (bagli.has(ay)) { bagliAy++; continue; }

      if (!(f.date_str in expected)) {
        qeyd(emp.name, f.date_str, 'sil',
             (U.TOHMET_NAMES[f.kind || 'fine'] || 'Cərimə') + (f.amount ? ' ' + f.amount + ' AZN' : ''));
        if (!quru) await db().from('fines').delete().eq('fine_id', f.fine_id);
        removed++;
      } else {
        const ex   = expected[f.date_str];
        const pul  = ex.kind === 'fine';
        const patch = {
          late_num: ex.late_num, late_mins: ex.late_mins,
          amount: pul ? disc.fineAmount : 0,
          kind:   ex.kind,
          expires_ymd: pul ? null : U.tohmetExpiry(f.date_str, disc),
          reason: cezaSebeb(ex),
        };
        const kohneNov = f.kind || 'fine';
        if (kohneNov !== ex.kind || Number(f.amount) !== Number(patch.amount)) {
          qeyd(emp.name, f.date_str, 'dəyiş',
               (U.TOHMET_NAMES[kohneNov] || kohneNov) + ' → ' + (U.TOHMET_NAMES[ex.kind] || ex.kind));
        }
        if (!quru) {
          let { error: uErr } = await db().from('fines').update(patch).eq('fine_id', f.fine_id);
          if (uErr && /kind|expires_ymd/i.test(uErr.message || '')) {
            const { kind: _k, expires_ymd: _e, ...kohne } = patch;
            await db().from('fines').update(kohne).eq('fine_id', f.fine_id);
          }
        }
        kept++;
      }
    }

    // Çatışmayan cərimələri əlavə et
    for (const ds of Object.keys(expected)) {
      if (existByDate[ds]) continue;
      if (bagli.has(ds.slice(0, 7))) { bagliAy++; continue; }   // bağlı aya yeni sənəd yazılmır
      const ex  = expected[ds];
      const pul = ex.kind === 'fine';
      qeyd(emp.name, ds, 'əlavə',
           (U.TOHMET_NAMES[ex.kind] || ex.kind) + (pul ? ' ' + disc.fineAmount + ' AZN' : ''));
      added++;
      if (quru) continue;
      const row = {
        fine_id: U.newId('FN-'),
        emp_id: empId, emp_name: emp.name, dept: emp.dept, date_str: ds,
        amount: pul ? disc.fineAmount : 0, late_num: ex.late_num, late_mins: ex.late_mins,
        reason: cezaSebeb(ex), status: 'unpaid',
        kind: ex.kind,
        expires_ymd: pul ? null : U.tohmetExpiry(ds, disc),
      };
      let { error: iErr } = await db().from('fines').insert(row);
      if (iErr && /kind|expires_ymd/i.test(iErr.message || '')) {
        const { kind: _k, expires_ymd: _e, ...kohne } = row;
        await db().from('fines').insert(kohne);
      }
    }
  }
  return {
    success: true, dryRun: quru,
    added, removed, kept,
    // Toxunulmayanlar — panel bunu göstərir ki, admin niyə dəyişmədiyini bilsin
    skippedAcked: imzali, skippedClosed: bagliAy,
    changes: deyisiklikler,
  };
};

API.updateEmployeeMessage = async (id, msg) => {
  const { error } = await db().from('employees').update({ message: msg || '' }).eq('id', id);
  return { success: !error };
};

// İşçinin aylıq taksi limiti (boş/null → ümumi limit işlədilir)
API.updateEmployeeTaxiLimit = async (id, limit) => {
  if (!id) return { success: false, reason: 'İşçi ID tapılmadı.' };
  let val = null;
  if (limit !== '' && limit !== null && limit !== undefined) {
    const n = Math.round(Number(limit));
    if (!Number.isFinite(n) || n < 0 || n > 62) return { success: false, reason: 'Limit 0–62 aralığında olmalıdır.' };
    val = n;
  }
  const { error } = await db().from('employees').update({ taxi_limit: val }).eq('id', id);
  if (error && /taxi_limit/i.test(error.message || '')) {
    return { success: false, reason: 'Limit sütunu hələ yaradılmayıb — taxi-limit-migration.sql işlədilməlidir.' };
  }
  sbErr('updateEmployeeTaxiLimit', error);
  return { success: !error, taxiLimit: val };
};

// İşçinin vəzifəsini dəyiş (Barista / Cashier / Team Leader / Cleaner)
API.updateEmployeePosition = async (id, position) => {
  if (!id) return { success: false, reason: 'İşçi ID tapılmadı.' };
  const pos = position || '';
  if (pos && !U.isValidPosition(pos)) return { success: false, reason: 'Belə vəzifə yoxdur: ' + pos };
  let { error } = await db().from('employees').update({ position: pos }).eq('id', id);
  if (error && positionColMissing(error)) {
    return { success: false, reason: 'Vəzifə sütunu hələ yaradılmayıb — positions-migration.sql işlədilməlidir.' };
  }
  sbErr('updateEmployeePosition', error);
  return { success: !error, position: pos };
};

// İşçinin filialını dəyiş (əvvəl bunu yalnız Supabase-dən əl ilə etmək olurdu).
// Tarixçəyə TOXUNMUR: keçmiş davamiyyət/nahar qeydləri yazıldığı filialda qalır (real tarixçə).
// Yalnız BUGÜNDƏN SONRAKI cədvəl sətirləri yeni filiala keçir ki, yeni menecer onları görüb redaktə edə bilsin.
API.updateEmployeeDept = async (id, dept) => {
  if (!id || !dept) return { success: false, reason: 'İşçi və filial tələb olunur.' };
  if (!U.DEPTS.includes(dept)) return { success: false, reason: 'Belə filial yoxdur: ' + dept };

  const { data: emp } = await db().from('employees').select('id,name,dept').eq('id', id).single();
  if (!emp) return { success: false, reason: 'İşçi tapılmadı.' };
  if (emp.dept === dept) return { success: false, reason: 'İşçi onsuz da bu filialdadır.' };

  const { error } = await db().from('employees').update({ dept }).eq('id', id);
  if (error) { sbErr('updateEmployeeDept', error); return { success: false, reason: error.message }; }

  // Gələcək cədvəl sətirlərini yeni filiala köçür
  const todayYMD = U.toYMD(new Date());
  const { error: cErr, count } = await db().from('cedvel')
    .update({ dept }, { count: 'exact' })
    .eq('emp_id', String(id)).gte('date_str', todayYMD);
  sbErr('updateEmployeeDept:cedvel', cErr);

  // Smen qrupu (saatlar) dəyişmiş ola bilər → streak-i yenidən hesabla ki, panel uyğun göstərsin
  let newStreak = null;
  try {
    newStreak = await U.calcStreak(id, dept);
    await db().from('employees').update({ streak: newStreak }).eq('id', id);
  } catch (e) { console.error('[updateEmployeeDept] streak:', e.message); }

  await U.sendTgTemplate('deptChange', { ad: emp.name, kohne: emp.dept, yeni: dept }, dept);
  return { success: true, from: emp.dept, to: dept, movedSchedule: count || 0, streak: newStreak };
};

// ── FİLİAL İŞ SAATLARI (smen konfiqurasiyası) ────────────────────
// Saatlar settings.SHIFT_CONFIG-də JSON kimi saxlanılır; kodda hardcode qalmayıb.

API.getShiftConfig = async () => ({
  config:   U.getShiftConfig(),
  defaults: U.defaultShiftConfig(),
  depts:    U.DEPTS,
  types:    U.SHIFT_TYPES,
  names:    U.SHIFT_NAMES,
});

API.saveShiftConfig = async (cfg) => {
  if (!cfg || typeof cfg !== 'object') return { success: false, reason: 'Yanlış format.' };

  const num = (v, min, max, fb) => {
    const n = Math.round(Number(v));
    return (Number.isFinite(n) && n >= min && n <= max) ? n : fb;
  };
  const base  = U.defaultShiftConfig();
  const clean = {};

  for (const dept of U.DEPTS) {
    const src = cfg[dept] || base[dept];
    const out = {};
    for (const t of U.SHIFT_TYPES) {
      const s = src[t] || base[dept][t];
      const d = base[dept][t];
      out[t] = {
        startH: num(s.startH, 0, 23, d.startH),
        startM: num(s.startM, 0, 59, d.startM),
        durH:   num(s.durH,   1, 24, d.durH),
        lateH:  num(s.lateH,  0, 23, d.lateH),
        lateM:  num(s.lateM,  0, 59, d.lateM),
      };
    }
    out.fbMorningH = num(src.fbMorningH, 0, 23, base[dept].fbMorningH);
    out.fbMorningM = num(src.fbMorningM, 0, 59, base[dept].fbMorningM);
    out.fbEveningH = num(src.fbEveningH, 0, 23, base[dept].fbEveningH);
    out.fbEveningM = num(src.fbEveningM, 0, 59, base[dept].fbEveningM);
    clean[dept] = out;
  }

  await U.setSetting('SHIFT_CONFIG', JSON.stringify(clean));
  return { success: true, config: U.getShiftConfig() };
};

API.resetShiftConfig = async () => {
  await U.setSetting('SHIFT_CONFIG', '');
  return { success: true, config: U.getShiftConfig() };
};

API.bindDevice = async (secret, deviceId) => {
  if (!secret) return { success: false, reason: 'Xətalı link!' };
  const { data: emp } = await db().from('employees').select('*').eq('secret', secret).single();
  if (!emp) return { success: false, reason: 'İşçi tapılmadı.' };

  if (!emp.device_id) {
    await db().from('employees').update({ device_id: deviceId }).eq('secret', secret);
    return { success: true, message: emp.message || '' };
  }

  if (emp.device_id !== deviceId) {
    return {
      success: false,
      reason: 'Bu kart başqa cihazda qeydiyyatlıdır. Dəyişdirmək üçün adminə müraciət edin.',
      deviceLocked: true,
    };
  }

  return { success: true, message: emp.message || '' };
};

API.resetDevice = async (id) => {
  const { error } = await db().from('employees').update({ device_id: '' }).eq('id', id);
  return { success: !error };
};

// ── SCAN CİHAZLAR ────────────────────────────────────────────────

// ── KİOSKUN GÖRÜNƏN IP-si ────────────────────────────────────────
//  2026-08-22 hadisəsinin dərsi: filialın WiFi IP-si əl ilə yazılırdı və o
//  rəqəm `api.ipify.org`-un gördüyü ünvan idi. Yoxlama isə serverin gördüyü
//  ünvanla müqayisə edir — eyni statik WiFi üçün ikisi fərqli çıxdı və bütün
//  filialda giriş dayandı. Rəqəmi tapmaq üçün fiziki olaraq filiala getmək
//  lazım gəldi.
//
//  İndi kiosk hər bir neçə dəqiqədən bir siqnal göndərir və server həmin
//  sorğunun GƏLDİYİ ünvanı yazır — yəni filialın cari IP-si həmişə göz
//  önündədir, admin panelində bir kliklə siyahıya düşür.
//
//  ⚠️ AVTOMATİK QƏBUL EDİLMİR — bu, yalnız TƏKLİFDİR.
//  Cihaz ID-si QR kodun İÇİNDƏDİR (`CMQR:<cihazID>:<pəncərə>`), yəni QR
//  fotosu olan hər kəsdə cihaz ID-si də var. Avtomatik qəbul etsəydik, həmin
//  adam evdən bir sorğu ilə filialın IP-sini özününkü ilə əvəz edib girə
//  bilərdi — WiFi bağlantısının bütün mənası itərdi. Təsdiq insandadır.
const IP_YAZMA_ARALIQ_MS = 2 * 60 * 1000;   // eyni IP-ni hər siqnalda yazmırıq
const _ipXeberdarliq = new Map();           // 'cihaz|ip' → vaxt (Telegram təkrarı olmasın)

async function kioskIpQeyd(dev, deviceId) {
  const ip = T.clientIp();
  if (!ip) return;
  const eyni  = dev.last_ip === ip;
  const tezed = dev.last_seen && (Date.now() - new Date(dev.last_seen).getTime()) < IP_YAZMA_ARALIQ_MS;
  if (eyni && tezed) return;                // dəyişməyib və təzədir → yazmağa dəyməz

  const { error } = await db().from('scan_devices')
    .update({ last_ip: ip, last_seen: new Date().toISOString() }).eq('device_id', deviceId);
  if (error) {
    // Sütunlar hələ yaradılmayıbsa (kiosk-ip-migration.sql işlədilməyib) sistem
    // sadəcə təklif göstərmir — heç nə sınmır.
    if (!/last_ip|last_seen/i.test(error.message || '')) sbErr('kioskIpQeyd', error);
    return;
  }
  if (eyni) return;

  // IP DƏYİŞDİ. Adminə xəbər ver ki, səhər növbəsindən ƏVVƏL bilsin —
  // bugünkü hadisədə problem yalnız işçilər qapıda qalanda üzə çıxdı.
  const b = T.branchByName(dev.branch);
  const icazeli = String((b && b.wifi_ips) || '').split(',').map(s => s.trim()).filter(Boolean);
  if (icazeli.some(a => ip.startsWith(a))) return;      // onsuz da siyahıdadır

  const acar = deviceId + '|' + ip;
  if (_ipXeberdarliq.has(acar)) return;
  if (_ipXeberdarliq.size > 200) _ipXeberdarliq.clear();
  _ipXeberdarliq.set(acar, Date.now());
  console.warn(`[Kiosk] ${dev.branch} — yeni IP: ${ip} (siyahıda yoxdur: ${icazeli.join(', ') || 'boş'})`);
  await U.sendTelegramMsg(
    `⚠️ <b>${dev.branch}</b> kiosku yeni IP-dən görünür:\n<code>${ip}</code>\n\n` +
    `İcazəli siyahı: <code>${icazeli.join(', ') || 'boş'}</code>\n` +
    `Admin panel → WiFi → «Siyahıya əlavə et».`, null);
}

// Admin panelinin WiFi tabı üçün: hər filialın kiosku indi hansı IP-dən görünür.
API.getKioskIps = async () => {
  const { data } = await db().from('scan_devices').select('*').eq('status', 'active');
  const out = {};
  for (const d of data || []) {
    const b = T.branchByName(d.branch);
    if (!b) continue;
    const icazeli = String((b.wifi_ips) || '').split(',').map(s => s.trim()).filter(Boolean);
    const ip = d.last_ip || '';
    const mov = out[b.branch_id];
    // Bir filialda bir neçə kiosk ola bilər — ən son görüləni götürürük.
    if (mov && mov.lastSeen && d.last_seen && mov.lastSeen >= d.last_seen) continue;
    out[b.branch_id] = {
      deviceId: d.device_id, label: d.label || '', ip,
      lastSeen: d.last_seen || '',
      // Siyahıda varmı? Yoxdursa panel «əlavə et» düyməsi göstərir.
      covered: !!ip && icazeli.some(a => ip.startsWith(a)),
    };
  }
  return out;
};

API.checkScanDevice = async (deviceId) => {
  if (!deviceId) return { allowed: false, pending: false, reason: 'Cihaz ID tapılmadı.' };
  const { data: dev } = await db().from('scan_devices').select('*').eq('device_id', deviceId).single();
  if (dev) {
    if (dev.status === 'active') {
      await kioskIpQeyd(dev, deviceId);
      return { allowed: true, branch: dev.branch, label: dev.label };
    }
    if (dev.status === 'pending') return { allowed: false, pending: true, reason: 'Cihazınız admin tərəfindən hələ təsdiqlənməyib.' };
    if (dev.status === 'blocked') return { allowed: false, pending: false, reason: 'Bu cihaz admin tərəfindən bloklanıb.' };
  }
  //  F-19: bu funksiya AÇARSIZDIR — istənilən şəxs uydurma `deviceId` göndərib
  //  həm cədvələ sətir yaza, həm də adminə Telegram göndərtdirə bilirdi.
  //  Eyni ID təkrarlansa yuxarıdakı `if (dev)` onu tutur, amma HƏR DƏFƏ YENİ
  //  ID göndərmək kifayət idi: sonsuz sətir + sonsuz bildiriş.
  //
  //  İki hədd qoyulur:
  //    1. Eyni anda gözləyən cihazların sayı (real filialda 1-2 olur).
  //    2. Bildiriş tezliyi — sətir yazılsa da adminin telefonu susmalıdır.
  const { count: gozleyen } = await db().from('scan_devices')
    .select('device_id', { count: 'exact', head: true }).eq('status', 'pending');
  if ((gozleyen || 0) >= PENDING_DEVICE_LIMIT) {
    // Loq da boğulur: spam altında minlərlə eyni sətir faydasızdır.
    if (rateHit('newdev-log', T.tenantId(), 1, 3600_000).ok)
      console.warn(`[Device] ${T.tenantId()}: gözləyən cihaz həddi doldu (${gozleyen}) — yeni qeydlər alınmır`);
    return { allowed: false, pending: false,
             reason: 'Təsdiq gözləyən cihaz sayı həddi keçib. Admin ilə əlaqə saxlayın.' };
  }

  await db().from('scan_devices').upsert({ device_id: deviceId, status: 'pending' }, { onConflict: 'device_id' });
  // Cihaz artıq bu müştəriyə bağlıdır → bundan sonra öz device_id-si ilə
  // müştərini özü tanıda bilər (`?t=` göstəricisi bir daha lazım deyil).
  T.cacheDevice(deviceId, T.tenantId());

  //  Bildiriş müştəri başına məhduddur: qeyd onsuz da bazadadır və admin
  //  panelində görünür, yəni bildirişin itməsi məlumatı itirmir.
  const tg = rateHit('newdev', T.tenantId(), DEVICE_TG_PER_HOUR, 3600_000);
  if (tg.ok) await U.sendTgTemplate('newDevice', { brend: T.brand().name, cihaz: deviceId }, null);
  else if (rateHit('newdev-log', T.tenantId(), 1, 3600_000).ok)
    console.warn(`[Device] ${T.tenantId()}: yeni cihaz bildirişləri susduruldu (saatda ${DEVICE_TG_PER_HOUR} hədd)`);

  return { allowed: false, pending: true, reason: 'Cihazınız qeydə alındı. Admin təsdiqini gözləyin.' };
};

API.getScanDevices = async () => {
  const { data } = await db().from('scan_devices').select('*').order('created_at', { ascending: false });
  return (data || []).map(d => ({
    id: d.device_id, deviceId: d.device_id, branch: d.branch || '', status: d.status || 'pending',
    createdAt: d.created_at || '', label: d.label || '',
  }));
};

API.approveScanDevice = async (deviceId, branch, label) => {
  if (!U.DEPTS.includes(branch)) return { success: false, reason: 'Belə filial yoxdur: ' + branch };
  const { error } = await db().from('scan_devices')
    .upsert({ device_id: deviceId, branch, status: 'active', label: label || branch }, { onConflict: 'device_id' });
  if (!error) T.cacheDevice(deviceId, T.tenantId());
  return { success: !error };
};

API.blockScanDevice = async (deviceId) => {
  const { error } = await db().from('scan_devices').update({ status: 'blocked' }).eq('device_id', deviceId);
  return { success: !error };
};

API.removeScanDevice = async (deviceId) => {
  const { error } = await db().from('scan_devices').delete().eq('device_id', deviceId);
  return { success: !error };
};

// ── CƏDVƏL ───────────────────────────────────────────────────────

API.getCedvel = async (dept, weekStart) => {
  const start = new Date(weekStart);
  const dates = [];
  for (let d = 0; d < 7; d++) {
    const dd = new Date(start.getTime() + d * 86400000);
    dates.push(U.toYMD(dd));
  }
  const { data: emps } = await db().from('employees').select('*').eq('dept', dept).order('name');
  // cedvel_id üzrə artan sırala: təkrar (emp_id,date_str) sətir olarsa, sonuncu (ən yeni) təyin qalib gəlir
  // — getEmployeeShift ilə uyğun ki, menecer və işçi eyni smeni görsün.
  const { data: rows } = await db().from('cedvel').select('*').eq('dept', dept).in('date_str', dates).order('cedvel_id', { ascending: true });
  const map = {};
  for (const r of rows || []) {
    if (!map[r.emp_id]) map[r.emp_id] = {};
    map[r.emp_id][r.date_str] = r.shift_type;
  }
  return (emps || []).map(e => ({
    empId: e.id, empName: e.name, dept: e.dept,
    schedule: dates.map(ds => ({ date: ds, shiftType: (map[e.id]?.[ds]) || '' })),
  }));
};

// Cədvəl saxlama — iki qorunma ilə:
//  1) TAKSİ LİMİTİ: bir işçiyə ayda limitdən çox taksili gün yazıla bilməz (admin də daxil;
//     admin limiti İşçilər tabından artıra bilər).
//  2) KEÇMİŞ HƏFTƏ KİLİDİ: menecer bitmiş həftənin cədvəlini dəyişə bilməz (manipulyasiya).
//     Admin üçün kilid yoxdur — səhvləri düzəltmək lazım ola bilər.
async function saveCedvelCore(entries, opts) {
  const o = opts || {};
  if (!entries?.length) return { success: true };

  // ── 1) Keçmiş həftə kilidi (yalnız menecer) ──
  if (o.isManager) {
    const buHefte = U.weekStartYMD(new Date());
    const kohne = [...new Set(entries.map(e => e.dateStr).filter(d => d && d < buHefte))].sort();
    if (kohne.length) {
      return {
        success: false,
        reason: `Bitmiş həftənin cədvəli dəyişdirilə bilməz (${kohne[0].split('-').reverse().join('.')}${kohne.length > 1 ? ' və b.' : ''}). Düzəliş üçün admin ilə əlaqə saxlayın.`,
        locked: true,
      };
    }
  }

  const empIds = [...new Set(entries.map(e => String(e.empId)).filter(Boolean))];
  const dates  = [...new Set(entries.map(e => e.dateStr).filter(Boolean))];

  // ── 2) Aylıq taksi limiti ──
  if (empIds.length && dates.length) {
    const cfg = U.getSalaryConfig();
    let empRows = null;
    ({ data: empRows } = await db().from('employees').select('id,name,dept,taxi_limit').in('id', empIds));
    if (!empRows) ({ data: empRows } = await db().from('employees').select('id,name,dept').in('id', empIds));
    const empMap = {};
    for (const e of empRows || []) empMap[String(e.id)] = e;

    const aylar = [...new Set(dates.map(d => String(d).slice(0, 7)))];
    for (const ay of aylar) {
      const ayBasi = ay + '-01';
      const [yy, mm] = ay.split('-').map(Number);
      const aySonu = mm === 12 ? `${yy + 1}-01-01` : `${yy}-${String(mm + 1).padStart(2, '0')}-01`;
      const { data: mevcud } = await db().from('cedvel')
        .select('emp_id,date_str,shift_type').in('emp_id', empIds).gte('date_str', ayBasi).lt('date_str', aySonu);

      for (const empId of empIds) {
        const emp = empMap[empId];
        if (!emp) continue;
        const limit = U.taxiLimitFor(emp.taxi_limit, cfg);
        // Bu batch-də həmin işçinin toxunduğu tarixlər (onlar əvəz olunacaq)
        const toxunulan = new Set(entries.filter(e => String(e.empId) === empId && e.dateStr).map(e => e.dateStr));
        // Bazada qalan (toxunulmayan) taksili günlər
        let say = (mevcud || []).filter(r =>
          String(r.emp_id) === empId && !toxunulan.has(r.date_str) && U.isTaxiDay(emp.dept, r.shift_type, cfg)
        ).length;
        // Batch-də yazılan taksili günlər
        const yeni = entries.filter(e => String(e.empId) === empId && String(e.dateStr).slice(0, 7) === ay && U.isTaxiDay(emp.dept, e.shiftType, cfg));
        if (say + yeni.length > limit) {
          return {
            success: false,
            limitExceeded: true,
            reason: `${emp.name}: ${ay} ayında taksili smen limiti ${limit}-dir. Hazırda ${say}, əlavə edilən ${yeni.length} → cəmi ${say + yeni.length}. ` +
                    `Limiti artırmaq üçün admin panel → İşçilər.`,
          };
        }
      }
    }
  }

  // Eyni (emp_id,date_str) xanə batch-də təkrarlanarsa sonuncunu saxla — uq_cedvel_emp_date
  // unikal indeksi ilə toqquşub BÜTÜN saxlamanın uğursuz olmasının qarşısını alır.
  const cellMap = new Map();
  for (const e of entries) {
    if (!e.empId || !e.dateStr || !e.shiftType) continue;
    cellMap.set(String(e.empId) + '|' + e.dateStr, e);
  }
  const toInsert = [...cellMap.values()].map((e, i) => ({
    // i (sətir indeksi) batch daxilində unikallığa zəmanət verir — eyni ms-də random toqquşması cədvəli silmir
    cedvel_id:  U.newId('C', i),
    emp_id:     e.empId, emp_name: e.empName, dept: e.dept,
    date_str:   e.dateStr, shift_type: e.shiftType,
  }));
  //  F-17: sil+yaz artıq geri qaytarıla bilir — insert sınsa həftənin
  //  cədvəli SİLİNMİŞ qalmır (izahı: `replaceRows`).
  if (empIds.length && dates.length) {
    const r = await replaceRows('cedvel',
      (q) => q.in('emp_id', empIds).in('date_str', dates), toInsert, 'saveCedvel');
    if (!r.ok) return { success: false, reason: r.reason, restored: r.restored };
  } else if (toInsert.length) {
    const { error } = await db().from('cedvel').insert(toInsert);
    if (error) return { success: false, reason: 'Saxlama xətası: ' + error.message };
  }
  return { success: true };
}

API.saveCedvel = async (entries) => saveCedvelCore(entries, { isManager: false });

API.getDeptList = () => U.DEPTS;

// ══════════════════════════════════════════════════════════════════
//  FİLİALLAR — Faza 1: filial artıq DATA-dır, kod deyil
// ══════════════════════════════════════════════════════════════════
//  Bu bölmə `utils.DEPT_SLUG` hardcode-unu əvəz edir. Admin panelindən
//  filial əlavə/redaktə/sil edilə bilər — kod dəyişikliyi lazım deyil.

// Filial adından slug qurur: "Ağ Şəhər" → "agseher"
const AZ_MAP = { 'ə':'e','ı':'i','ö':'o','ü':'u','ç':'c','ş':'s','ğ':'g',
                 'Ə':'e','I':'i','Ö':'o','Ü':'u','Ç':'c','Ş':'s','Ğ':'g' };
function slugify(name) {
  const base = String(name || '').trim().toLowerCase()
    .replace(/[əıöüçşğƏIÖÜÇŞĞ]/g, ch => AZ_MAP[ch] || ch)
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 24);
  return base || ('f' + Date.now().toString(36));
}

API.getBranches = async () => ({
  branches: T.branches().map(b => ({
    id: b.branch_id, name: b.name, color: b.color || '#bfdbfe',
    wifiIps: b.wifi_ips || '', tgChatId: b.tg_chat_id || '',
    wasteLimit: Number(b.waste_limit ?? 3), mgrName: b.mgr_name || '',
    sortOrder: b.sort_order || 0,
  })),
  managerKeys: await U.getBranchScheduleKeys(),
});

API.addBranch = async (name, opts) => {
  const nm = String(name || '').trim();
  if (!nm) return { success: false, reason: 'Filial adı boşdur.' };
  if (T.branchByName(nm)) return { success: false, reason: 'Bu adda filial artıq var.' };

  const t = T.currentTenant();
  if (t && t.max_branches > 0 && T.branches().length >= t.max_branches) {
    return { success: false, reason: `Planınızda ən çox ${t.max_branches} filial ola bilər.` };
  }

  // Slug unikal olmalıdır (ad fərqli, slug eyni çıxa bilər: "Ağ Şəhər" / "Ağşəhər")
  let slug = slugify(nm), n = 2;
  while (T.branchBySlug(slug)) slug = slugify(nm) + (n++);

  const tid = T.tenantId();
  const { error } = await db().from('branches').insert({
    branch_id: slug,
    name: nm,
    color: (opts && opts.color) || '#bfdbfe',
    wifi_ips: (opts && opts.wifiIps) || '',
    tg_chat_id: (opts && opts.tgChatId) || '',
    waste_limit: Number((opts && opts.wasteLimit) ?? 3),
    sort_order: T.branches().length,
  });
  if (error) { sbErr('addBranch', error); return { success: false, reason: error.message }; }

  await T.reload(tid);
  // Filialın menecer açarı dərhal yaradılsın (panel linki hazır olsun)
  const key = await T.ensureKey(tid, 'manager', slug, nm);

  // Yeni filial müştərinin defolt smen şablonunu miras alsın ki, cədvəl/gecikmə
  // məntiqi ilk gündən işləsin (konfiqurasiyada olmasa saatlar naməlum qalardı).
  const cfg = U.getShiftConfig();
  if (!cfg[nm]) {
    cfg[nm] = JSON.parse(JSON.stringify(U.defaultShiftTemplate()));
    await U.setSetting('SHIFT_CONFIG', JSON.stringify(cfg));
  }
  return { success: true, id: slug, managerKey: key };
};

API.updateBranch = async (branchId, patch) => {
  const b = T.branchBySlug(branchId);
  if (!b) return { success: false, reason: 'Filial tapılmadı.' };
  const p = {};
  if (patch.color      !== undefined) p.color       = String(patch.color || '');
  if (patch.wifiIps    !== undefined) p.wifi_ips    = String(patch.wifiIps || '');
  if (patch.tgChatId   !== undefined) p.tg_chat_id  = String(patch.tgChatId || '');
  if (patch.wasteLimit !== undefined) p.waste_limit = Number(patch.wasteLimit) || 0;
  if (patch.mgrName    !== undefined) p.mgr_name    = String(patch.mgrName || '');
  if (patch.active     !== undefined) p.active      = !!patch.active;
  if (!Object.keys(p).length) return { success: true };

  const tid = T.tenantId();
  const { error } = await db().from('branches').update(p).eq('branch_id', branchId);
  if (error) { sbErr('updateBranch', error); return { success: false, reason: error.message }; }
  await T.reload(tid);
  return { success: true };
};

// Filialın ADINI dəyişmək — ehtiyatlı əməliyyat.
// Səbəb: `dept` sütunu 12 cədvəldə ADI mətn kimi saxlayır (denormallaşdırılıb).
// Sadəcə `branches.name`-i dəyişsək bütün tarixçə "sahibsiz" qalar: köhnə
// davamiyyət, cədvəl, cərimə qeydləri yeni filialla uyğunlaşmaz.
// Ona görə ad dəyişikliyi bütün həmin sütunlarda kaskad yenilənir.
const DEPT_TABLES = [
  'employees', 'attendance', 'nahar', 'cedvel', 'izin', 'late_perms',
  'mgr_schedule', 'checklist_logs', 'mgr_acks', 'product_logs', 'avans',
  'fines', 'mgr_fines', 'xp_audit_log', 'trainer_exams', 'trainer_logs',
  'ops_visits', 'ops_emp_notes', 'ops_issues', 'scan_devices',
];

API.renameBranch = async (branchId, newName) => {
  const b  = T.branchBySlug(branchId);
  const nm = String(newName || '').trim();
  if (!b)  return { success: false, reason: 'Filial tapılmadı.' };
  if (!nm) return { success: false, reason: 'Yeni ad boşdur.' };
  if (nm === b.name) return { success: true, renamed: 0 };
  if (T.branchByName(nm)) return { success: false, reason: 'Bu adda filial artıq var.' };

  const tid = T.tenantId();
  const failed = [];
  for (const tbl of DEPT_TABLES) {
    // `scan_devices`-də sütunun adı `branch`-dır, qalanlarında `dept`
    const col = tbl === 'scan_devices' ? 'branch' : 'dept';
    const { error } = await db().from(tbl).update({ [col]: nm }).eq(col, b.name);
    if (error) { sbErr('renameBranch:' + tbl, error); failed.push(tbl); }
  }
  if (failed.length) {
    return { success: false, reason: 'Ad dəyişmədi — bu cədvəllərdə xəta oldu: ' + failed.join(', ') };
  }

  const { error } = await db().from('branches').update({ name: nm }).eq('branch_id', branchId);
  if (error) { sbErr('renameBranch:branches', error); return { success: false, reason: error.message }; }

  // Smen konfiqurasiyası filial ADI ilə açarlanır → onu da köçür
  const cfg = U.getShiftConfig();
  if (cfg[b.name]) { cfg[nm] = cfg[b.name]; delete cfg[b.name]; await U.setSetting('SHIFT_CONFIG', JSON.stringify(cfg)); }

  // Maaş konfiqurasiyasındakı taksili filial siyahısı da adla işləyir
  const sal = U.getSalaryConfig();
  if (Array.isArray(sal.taxiDepts) && sal.taxiDepts.includes(b.name)) {
    sal.taxiDepts = sal.taxiDepts.map(d => (d === b.name ? nm : d));
    await U.setSetting('SALARY_CONFIG', JSON.stringify(sal));
  }

  await T.reload(tid);
  return { success: true };
};

API.deleteBranch = async (branchId) => {
  const b = T.branchBySlug(branchId);
  if (!b) return { success: false, reason: 'Filial tapılmadı.' };

  // İşçisi olan filial silinmir — tarixçəni sahibsiz qoymamaq üçün.
  const { count } = await db().from('employees')
    .select('id', { count: 'exact', head: true }).eq('dept', b.name);
  if (count > 0) {
    return { success: false, reason: `Bu filialda ${count} işçi var. Əvvəlcə onları köçürün və ya silin.` };
  }

  const tid = T.tenantId();
  await T.revokeKeys(tid, 'manager', branchId);
  const { error } = await db().from('branches').delete().eq('branch_id', branchId);
  if (error) { sbErr('deleteBranch', error); return { success: false, reason: error.message }; }
  await T.reload(tid);
  return { success: true };
};

API.reorderBranches = async (orderedIds) => {
  const tid = T.tenantId();
  const ids = Array.isArray(orderedIds) ? orderedIds : [];
  for (let i = 0; i < ids.length; i++) {
    if (T.branchBySlug(ids[i])) {
      await db().from('branches').update({ sort_order: i }).eq('branch_id', ids[i]);
    }
  }
  await T.reload(tid);
  return { success: true };
};

// ── VƏZİFƏLƏR ─────────────────────────────────────────────────────
//  ƏVVƏL: utils.js-də `POSITIONS = ['Barista','Cashier','Team Leader','Cleaner']`.
//  İNDİ: hər müştəri özü təyin edir (restoranda "Ofisiant", mağazada "Satıcı"...).
API.savePositions = async (list) => {
  const tid   = T.tenantId();
  const names = [...new Set((Array.isArray(list) ? list : [])
    .map(s => String(s || '').trim()).filter(Boolean))];
  if (!names.length) return { success: false, reason: 'Ən azı bir vəzifə olmalıdır.' };

  // İşlədilən vəzifəni silmək maaş hesabatını pozar → xəbərdarlıq et.
  const { data: emps } = await db().from('employees').select('position');
  const inUse = [...new Set((emps || []).map(e => e.position).filter(Boolean))];
  const removed = inUse.filter(p => !names.includes(p));
  if (removed.length) {
    return { success: false, reason: 'Bu vəzifələr işçilərdə işlədilir, silinə bilməz: ' + removed.join(', ') };
  }

  //  ⚠️ Süzgəcdə ƏVVƏL görünməz NUL baytı vardı (`'\0'`) — yəqin ki bir dəfə
  //  boşluq yerinə düşüb. İki nəticəsi olub: fayl `grep` üçün «binary» sayılırdı
  //  (axtarış nəticələri gizlənirdi) və PostgREST-ə NUL göndərmək etibarsızdır.
  //  `name != ''` eyni işi görür — bütün sətirlərə uyğun gəlir.
  //  Silmənin və yazmanın xətası da əvvəl oxunmurdu; indi ikisi də yoxlanılır.
  const r = await replaceRows('positions', (q) => q.neq('name', ''),
    names.map((name, i) => ({ name, sort_order: i, active: true })), 'savePositions');
  if (!r.ok) {
    await T.reload(tid);              // keş bazadakı real vəziyyətlə uzlaşsın
    return { success: false, reason: r.reason, restored: r.restored };
  }
  await T.reload(tid);
  return { success: true, positions: T.positions() };
};

// ── MÜŞTƏRİ ÖZÜ HAQQINDA ──────────────────────────────────────────
API.getTenantInfo = async () => {
  const t = T.currentTenant();
  if (!t) return null;
  return {
    tenantId: t.tenant_id, name: t.name, slug: t.slug || '',
    plan: t.plan, status: t.status, trialEndsAt: t.trial_ends_at || '',
    locale: t.locale, currency: t.currency, timezone: t.timezone,
    maxEmployees: t.max_employees || 0, maxBranches: t.max_branches || 0,
    brand: T.brand(),
    positions: T.positions(),
  };
};

API.saveTenantBrand = async (brand) => {
  const tid = T.tenantId();
  const cur = (T.currentTenant() || {}).brand || {};

  // Rəng yalnız #rrggbb formatında qəbul olunur — CSS-ə yeridiləcəyi üçün
  // ixtiyari mətn buraxsaq stil qaydası pozula bilər.
  const color = String(brand?.themeColor ?? cur.themeColor ?? '').trim();
  const safeColor = /^#[0-9a-fA-F]{6}$/.test(color) ? color : (cur.themeColor || '#5b5ef4');

  // Terminologiya: yalnız tanınan açarlar, hər biri qısa mətn.
  // Göndərilməyibsə mövcud dəst saxlanılır (brend formu ilə ayrıca saxlanılır).
  let terms = cur.terms || {};
  if (brand && brand.terms && typeof brand.terms === 'object') {
    terms = {};
    for (const key of Object.keys(DEFAULT_TERMS)) {
      const v = String(brand.terms[key] || '').trim().slice(0, 30);
      if (v) terms[key] = v;
    }
  }

  const next = {
    ...cur,
    displayName: String(brand?.displayName ?? cur.displayName ?? '').slice(0, 60),
    icon:        String(brand?.icon        ?? cur.icon        ?? '').slice(0, 60),
    themeColor:  safeColor,
    bgColor:     String(brand?.bgColor     ?? cur.bgColor     ?? '').slice(0, 20),
    footer:      String(brand?.footer      ?? cur.footer      ?? '').slice(0, 80),
    terms,
  };
  const { error } = await sb.from('tenants').update({ brand: next }).eq('tenant_id', tid);
  if (error) return { success: false, reason: error.message };
  await T.reload(tid);
  return { success: true, brand: T.brand() };
};

API.getAdminKey = async () => ({
  key: await T.ensureKey(T.tenantId(), 'admin', null, 'Admin'),
});

API.regenerateAdminKey = async () => ({
  key: await T.issueKey(T.tenantId(), 'admin', null, 'Admin'),
});
API.getBranchScheduleKeys = async () => U.getBranchScheduleKeys();
API.validateBranchScheduleKey = (key) => U.validateBranchScheduleKey(key);

API.getCedvelForTrainer = async (trainerKey, weekStart) => {
  const key = roleKey('trainer');
  if (!key || key !== trainerKey) return null;
  const all = await Promise.all(U.DEPTS.map(d => API.getCedvel(d, weekStart)));
  return all.flat();
};

API.getCedvelForManager = async (key, weekStart) => {
  const c = U.validateBranchScheduleKey(key);
  if (!c.valid) return null;
  return API.getCedvel(c.dept, weekStart);
};

API.saveCedvelForManager = async (key, entries) => {
  const c = U.validateBranchScheduleKey(key);
  if (!c.valid) return { success: false, reason: 'İcazəsiz.' };
  return saveCedvelCore(entries, { isManager: true, dept: c.dept });
};

// ── İZİN ─────────────────────────────────────────────────────────

API.getIzinList = async () => {
  const { data } = await db().from('izin').select('*').order('created_at', { ascending: false });
  return (data || []).map(r => ({
    id: r.izin_id, empId: r.emp_id, empName: r.emp_name, dept: r.dept,
    startDate: r.start_date, endDate: r.end_date,
    type: r.type || '', note: r.note || '', status: r.status || '',
    createdAt: r.created_at || '', izinId: r.izin_id,
  }));
};

API.addIzin = async (data) => {
  const id = U.newId('I');
  const { error } = await db().from('izin').insert({
    izin_id: id, emp_id: data.empId, emp_name: data.empName, dept: data.dept,
    start_date: data.startDate, end_date: data.endDate,
    type: data.type || 'İzin', note: data.note || '', status: 'pending',
  });
  return { success: !error };
};

API.updateIzinStatus = async (izinId, status) => {
  const { data: izin } = await db().from('izin').select('emp_id,emp_name,start_date,end_date').eq('izin_id', izinId).single();
  const { error } = await db().from('izin').update({ status }).eq('izin_id', izinId);
  if (!error && izin) {
    const emoji   = status === 'approved' ? '✅' : status === 'rejected' ? '❌' : '🔄';
    const statusAz = status === 'approved' ? 'təsdiqləndi' : status === 'rejected' ? 'rədd edildi' : 'yeniləndi';
    const p = U.fillPush('izinDecision', { emoji, bas: izin.start_date, son: izin.end_date, status: statusAz });
    if (p) await sendPushToEmployee(
      izin.emp_id,
      p.title,
      p.body,
      { tag: 'izin-' + izinId }
    );
  }
  return { success: !error };
};

API.removeIzin = async (izinId) => {
  const { error } = await db().from('izin').delete().eq('izin_id', izinId);
  return { success: !error };
};

// ── HESABAT ───────────────────────────────────────────────────────

// İcazə lookup map qurur: { empId → [{start_date, end_date}] }
// İzin map: { empId → [{s, e}] }  (tam gün izin)
async function buildLeaveMap() {
  const { data } = await db().from('izin').select('emp_id,start_date,end_date').eq('status', 'approved');
  const map = {};
  for (const r of data || []) {
    if (!map[r.emp_id]) map[r.emp_id] = [];
    map[r.emp_id].push({ s: r.start_date, e: r.end_date });
  }
  return map;
}
// Gec gəliş icazəsi map: { "empId|date_str" → permMins (icazə verilən dəqiqə) }
async function buildLatePermMap() {
  const { data } = await db().from('late_perms').select('emp_id,date_str,requested_time').eq('status', 'approved');
  const map = {};
  for (const r of data || []) {
    const [h, m] = (r.requested_time || '23:59').split(':').map(Number);
    map[String(r.emp_id) + '|' + r.date_str] = h * 60 + m;
  }
  return map;
}
function onLeave(leaveMap, empId, dateStr) {
  return (leaveMap[String(empId)] || []).some(r => dateStr >= r.s && dateStr <= r.e);
}
// İcazə varsa və gəlmə vaxtı icazə vaxtı + 5 dəq içindədirsə → vaxtında
// `grace` — güzəşt dəqiqəsi. ƏVVƏL burada `+ 5` HARDCODE idi (F-18), halbuki
// qalan hər yer (`validateAndLog`, `calcStreak`, `recalcAllFines`,
// `computeEmployeeXP`) `DISCIPLINE_CONFIG.permGraceMins` işlədir. Müştəri güzəşti
// 15 dəqiqəyə qaldırsa cərimə yazılmır və streak qırılmırdı, AMMA aylıq hesabat
// həmin günü «gecikmə» sayırdı — işçi 100% əvəzinə 96% görürdü və səbəbi tapılmırdı.
//
// Dəyər arqument kimi ötürülür, içəridə oxunmur: bu funksiya işçi×gün döngüsündə
// minlərlə dəfə çağırılır, `getDisciplineConfig()` isə hər çağırışda dərin kopya
// qaytarır (bax ARCHITECTURE.md — `discRef()` ayrımı).
function withinLatePerm(latePermMap, empId, dateStr, arrivalMins, grace) {
  const key = String(empId) + '|' + dateStr;
  if (!(key in latePermMap)) return false;
  return arrivalMins <= latePermMap[key] + (Number.isFinite(grace) ? grace : 0);
}

// Açar MÜŞTƏRİ ilə başlayır. Əvvəl yalnız "il-ay" idi — yəni bir müştərinin
// hesabatı 60 saniyə ərzində BAŞQA müştəriyə qaytarıla bilirdi (utils.js-dəki
// bütün keşlər onsuz da tenantId ilə açarlanır; bura unudulmuşdu).
const _reportCache = new Map();   // "tenantId|year-month" → { ts, data }
const REPORT_TTL   = 60 * 1000;   // 60 san — eyni hesabat təkrar hesablanmır (dashboard yükü)
const REPORT_CACHE_MAX = 200;     // müştəri × ay kombinasiyası artdıqca yaddaş şişməsin

API.getMonthlyReport = async (year, month) => {
  const cacheKey = T.tenantId() + '|' + year + '-' + month;
  const cached   = _reportCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < REPORT_TTL) return cached.data;

  const { data: emps } = await db().from('employees').select('*');
  const grace = U.getDisciplineConfig().permGraceMins;   // döngədən KƏNARDA (F-18)
  const ay = U.ayPencere(year, month);
  if (!ay) return [];
  const startStr = ay.startYmd, endStr = ay.endYmd;   // TEXT sütunlar (cedvel.date_str)

  const [{ data: logs }, leaveMap, latePermMap, { data: cedvelData }] = await Promise.all([
    // `timestamp` TIMESTAMPTZ-dir → ISO sərhəd. Mətn versiyası UTC-də şərh olunub
    // sərhədi yerli 04:00-a salırdı, məntiqi gün isə 03:00-da kəsilir (F-07).
    db().from('attendance').select('*').gte('timestamp', ay.startIso).lt('timestamp', ay.endIso),
    buildLeaveMap(),
    buildLatePermMap(),
    db().from('cedvel').select('emp_id,date_str,shift_type').gte('date_str', startStr).lt('date_str', endStr),
  ]);

  // calcStreak ilə eyni mənbə: attendance-da shift_type yoxdursa cedveldən al
  const cedvelMap = {};
  for (const c of cedvelData || []) {
    cedvelMap[String(c.emp_id) + '|' + c.date_str] = c.shift_type || null;
  }

  const result = (emps || []).map(emp => {
    const myLogs    = (logs || []).filter(r => r.emp_id === emp.id);
    const gelisLogs = myLogs.filter(r => r.type === 'GƏLİŞ');
    const cixisLogs = myLogs.filter(r => r.type === 'CIXIS');
    let lateCount = 0, onTime = 0, totalHours = 0;
    for (const r of gelisLogs) {
      const d           = new Date(r.timestamp);
      const dateStr     = U.getLogicalYMD(d);   // canlı sistemlə eyni gün (icazə/izin gecə-yarısı sərhədində düz tapılsın)
      const arrivalMins = d.getHours() * 60 + d.getMinutes();
      // Tam gün izin → vaxtında
      if (onLeave(leaveMap, emp.id, dateStr)) { onTime++; continue; }
      // Gec gəliş icazəsi → yalnız icazə vaxtı + 5 dəq içindədirsə vaxtında
      if (withinLatePerm(latePermMap, emp.id, dateStr, arrivalMins, grace)) { onTime++; continue; }
      // calcStreak ilə eyni smen məntiqi: attendance → cedvel → fallback
      const st   = r.shift_type || cedvelMap[String(emp.id) + '|' + dateStr] || null;
      const si   = st ? U.getShiftInfo(emp.dept, st) : null;
      const late = si
        ? arrivalMins > (si.lateH * 60 + si.lateM)
        : U.isLate(emp.dept, d);
      if (late) lateCount++; else onTime++;
    }
    for (const r of cixisLogs) {
      const si  = r.shift_type ? U.getShiftInfo(emp.dept, r.shift_type) : null;
      const dur = si ? si.durH : 8;
      const ot  = r.overtime || '';
      const sign = ot.startsWith('+') ? 1 : ot.startsWith('-') ? -1 : 0;
      const mt   = ot.match(/(\d+)\s*saat\s*(\d+)/);
      totalHours += mt ? dur + sign * (parseInt(mt[1]) + parseInt(mt[2]) / 60) : dur;
    }
    const total = gelisLogs.length;
    return { empId: emp.id, empName: emp.name, dept: emp.dept, totalDays: total, onTime,
      late: lateCount, pct: total > 0 ? Math.round(onTime / total * 100) : 0,
      totalHours: Math.round(totalHours * 10) / 10 };
  }).sort((a, b) => b.pct - a.pct);

  // Vaxtı keçmişləri at; yenə də böyükdürsə ən köhnə qeydləri sil (Map sıra saxlayır).
  const indi = Date.now();
  for (const [k, v] of _reportCache) if (indi - v.ts >= REPORT_TTL) _reportCache.delete(k);
  while (_reportCache.size >= REPORT_CACHE_MAX) _reportCache.delete(_reportCache.keys().next().value);

  _reportCache.set(cacheKey, { ts: indi, data: result });
  return result;
};

// ── MAAŞ ──────────────────────────────────────────────────────────
// Qayda: gün YALNIZ işçi həqiqətən gəlibsə (GƏLİŞ qeydi varsa) ödənilir.
// Həmin günün cədvəldəki smeni 1 yoxsa 2 smen (tam gün) olduğunu və taksi
// hüququnu müəyyən edir. Taksi tam gündə də sabit qalır (iki qat DEYİL).

API.getSalaryConfig = async () => ({
  config:    U.getSalaryConfig(),
  defaults:  U.DEFAULT_SALARY,
  positions: U.POSITIONS,
  depts:     U.DEPTS,
  shiftNames: U.SHIFT_NAMES,
  taxiShiftOptions: U.ALL_SHIFT_TYPES,
});

API.saveSalaryConfig = async (cfg) => {
  if (!cfg || typeof cfg !== 'object') return { success: false, reason: 'Yanlış format.' };
  const base = U.DEFAULT_SALARY;
  const num = (v, fb) => { const n = Number(v); return (Number.isFinite(n) && n >= 0 && n <= 10000) ? U.round2(n) : fb; };
  const clean = {
    rates: {},
    taxi: num(cfg.taxi, base.taxi),
    taxiDepts: Array.isArray(cfg.taxiDepts) ? cfg.taxiDepts.filter(d => U.DEPTS.includes(d)) : base.taxiDepts,
    taxiShifts: Array.isArray(cfg.taxiShifts) ? cfg.taxiShifts.filter(s => U.ALL_SHIFT_TYPES.includes(s)) : base.taxiShifts,
  };
  for (const p of U.POSITIONS) clean.rates[p] = num(cfg.rates && cfg.rates[p], base.rates[p]);
  // Tutulma qaydaları — yalnız tanınan statuslar qəbul edilir ('waived'/'rejected' heç vaxt)
  clean.fineStatuses = Array.isArray(cfg.fineStatuses)
    ? cfg.fineStatuses.filter(s => ['unpaid', 'paid'].includes(s)) : base.fineStatuses;
  clean.avansStatuses = Array.isArray(cfg.avansStatuses)
    ? cfg.avansStatuses.filter(s => ['approved', 'paid'].includes(s)) : base.avansStatuses;
  clean.finesOnlyAcked = typeof cfg.finesOnlyAcked === 'boolean' ? cfg.finesOnlyAcked : base.finesOnlyAcked;
  clean.taxiMonthlyLimit = (() => {
    const n = Math.round(Number(cfg.taxiMonthlyLimit));
    return (Number.isFinite(n) && n >= 0 && n <= 62) ? n : base.taxiMonthlyLimit;
  })();
  clean.restDayPaid = typeof cfg.restDayPaid === 'boolean' ? cfg.restDayPaid : base.restDayPaid;
  clean.restDayMultiplier = (() => {
    const n = Number(cfg.restDayMultiplier);
    return (Number.isFinite(n) && n >= 0 && n <= 2) ? U.round2(n) : base.restDayMultiplier;
  })();
  clean.restDayMonthlyLimit = (() => {
    const n = Math.round(Number(cfg.restDayMonthlyLimit));
    return (Number.isFinite(n) && n >= 0 && n <= 31) ? n : base.restDayMonthlyLimit;
  })();
  await U.setSetting('SALARY_CONFIG', JSON.stringify(clean));
  return { success: true, config: U.getSalaryConfig() };
};

API.resetSalaryConfig = async () => {
  await U.setSetting('SALARY_CONFIG', '');
  return { success: true, config: U.getSalaryConfig() };
};

// ══════════════════════════════════════════════════════════════════
//  İNTİZAM / XP / TELEGRAM KONFİQURASİYALARI
// ══════════════════════════════════════════════════════════════════
//  Bunlar əvvəl kodda sabit rəqəm və sabit mətn idi (30 AZN, 3-cü gecikmə,
//  45/21 dəq, "<b>{ad}</b> smendə." …). İndi hər müştəri paneldən dəyişir.
//  Yazma yolu QƏSDƏN sərtdir: dəyər aralıqdan kənardırsa səssizcə ilkin
//  dəyərə qayıdır — pozulmuş konfiqurasiya davamiyyət yazılmasını dayandırmasın.

API.getDisciplineConfig = async () => ({
  config:   U.getDisciplineConfig(),
  defaults: U.DEFAULT_DISCIPLINE,
});

API.saveDisciplineConfig = async (cfg) => {
  if (!cfg || typeof cfg !== 'object') return { success: false, reason: 'Yanlış format.' };
  // Validasiya/normallaşdırma getDisciplineConfig-in içindədir — JSON-u yazıb
  // geri oxuyuruq ki, panel məhz saxlanılan (təmizlənmiş) dəyəri görsün.
  await U.setSetting('DISCIPLINE_CONFIG', JSON.stringify(cfg));
  return { success: true, config: U.getDisciplineConfig() };
};

API.resetDisciplineConfig = async () => {
  await U.setSetting('DISCIPLINE_CONFIG', '');
  return { success: true, config: U.getDisciplineConfig() };
};

API.getXPConfig = async () => ({
  config:   U.getXPConfig(),
  defaults: U.DEFAULT_XP,
});

API.saveXPConfig = async (cfg) => {
  if (!cfg || typeof cfg !== 'object') return { success: false, reason: 'Yanlış format.' };
  await U.setSetting('XP_CONFIG', JSON.stringify(cfg));
  return { success: true, config: U.getXPConfig() };
};

API.resetXPConfig = async () => {
  await U.setSetting('XP_CONFIG', '');
  return { success: true, config: U.getXPConfig() };
};

// Telegram mesaj şablonları. Hər açar üçün hansı yer tutucuların işlədiyi də
// qaytarılır ki, panel istifadəçiyə göstərə bilsin (yaddan çıxan `{ad}` axtarılmasın).
const TG_TPL_META = {
  arrive:     { ad: 'Gəliş',                 vars: ['ad', 'saat', 'qeyd'] },
  onTime:     { ad: 'Vaxtında qeydi',        vars: [] },
  late1:      { ad: 'Gecikmə — 1-ci',        vars: ['deq', 'say'] },
  late2:      { ad: 'Gecikmə — xəbərdarlıq', vars: ['deq', 'say'] },
  lateFine:   { ad: 'Gecikmə — cərimə',      vars: ['deq', 'say', 'mebleg'] },
  lateTohmet: { ad: 'Gecikmə — töhmət',      vars: ['deq', 'say', 'tenbeh', 'ay'] },
  leave:      { ad: 'Smendən çıxış',         vars: ['ad', 'saat', 'ferq'] },
  lunchGo:    { ad: 'Nahara getdi',          vars: ['ad', 'saat'] },
  lunchBack:  { ad: 'Nahardan qayıtdı',      vars: ['ad', 'saat', 'deq'] },
  mgrIn:      { ad: 'Menecer işdə',          vars: ['saat'] },
  mgrOut:     { ad: 'Menecer çıxdı',         vars: ['saat', 'ferq'] },
  deptChange: { ad: 'Filial dəyişdi',        vars: ['ad', 'kohne', 'yeni'] },
  newDevice:  { ad: 'Yeni scan cihazı',      vars: ['brend', 'cihaz'] },
  openShiftBlocked: { ad: 'Giriş bloklandı (açıq smen)', vars: ['ad', 'gun'] },
  emergency:  { ad: 'Təcili bildiriş',       vars: ['ad', 'filial', 'mesaj'] },
};

API.getTgTemplates = async () => ({
  config:   U.getTgTemplates(),
  defaults: U.DEFAULT_TG,
  meta:     TG_TPL_META,
  keys:     U.TG_KEYS,
});

API.saveTgTemplates = async (cfg) => {
  if (!cfg || typeof cfg !== 'object') return { success: false, reason: 'Yanlış format.' };
  const clean = {};
  for (const k of U.TG_KEYS) {
    if (typeof cfg[k] !== 'string') continue;
    // Telegram mesaj limiti 4096-dır; şablon + doldurulmuş dəyərlər üçün ehtiyat saxlanır.
    clean[k] = cfg[k].slice(0, 2000);
  }
  await U.setSetting('TG_TEMPLATES', JSON.stringify(clean));
  return { success: true, config: U.getTgTemplates() };
};

API.resetTgTemplates = async () => {
  await U.setSetting('TG_TEMPLATES', '');
  return { success: true, config: U.getTgTemplates() };
};

// Push (telefon) bildiriş şablonları — Telegram-dan fərqi: başlıq və mətn ayrıdır.
const PUSH_TPL_META = {
  izinDecision:     { ad: 'İzin qərarı (işçiyə)',        vars: ['emoji', 'bas', 'son', 'status'] },
  latePermRequest:  { ad: 'Gec gəliş tələbi (menecerə)', vars: ['ad', 'tarix', 'saat'] },
  latePermDecision: { ad: 'Gec gəliş qərarı (işçiyə)',   vars: ['emoji', 'tarix', 'saat', 'status'] },
  avansRequest:     { ad: 'Avans tələbi (menecerə)',     vars: ['ad', 'mebleg', 'qeyd'] },
  avansDecision:    { ad: 'Avans qərarı (işçiyə)',       vars: ['emoji', 'mebleg', 'status'] },
  mgrFine:          { ad: 'Cərimə bildirişi (işçiyə)',   vars: ['mebleg', 'sebeb'] },
  mgrTohmet:        { ad: 'Töhmət bildirişi (işçiyə)',   vars: ['tenbeh', 'ay', 'sebeb'] },
  fineAck:          { ad: 'Cərimə imzalandı (menecerə)', vars: ['ad', 'mebleg'] },
  lunchLate:        { ad: 'Nahar gecikməsi (menecerə)',  vars: ['ad', 'deq', 'limit'] },
  execGlobal:       { ad: 'İcraçının ümumi mesajı',      vars: ['icraci', 'mesaj'] },
  execMsg:          { ad: 'İcraçının filial mesajı',     vars: ['icraci', 'mesaj'] },
  execAck:          { ad: 'Menecer təsdiqi (icraçıya)',  vars: ['filial', 'nov', 'saat'] },
  announce:         { ad: 'Elan (hamıya)',               vars: ['emoji', 'basliq', 'metn'] },
  examDone:         { ad: 'İmtahan bitdi (trainerə)',    vars: ['metn'] },
};

API.getPushTemplates = async () => ({
  config:   U.getPushTemplates(),
  defaults: U.DEFAULT_PUSH,
  meta:     PUSH_TPL_META,
  keys:     U.PUSH_KEYS,
});

API.savePushTemplates = async (cfg) => {
  if (!cfg || typeof cfg !== 'object') return { success: false, reason: 'Yanlış format.' };
  const clean = {};
  for (const k of U.PUSH_KEYS) {
    const v = cfg[k];
    if (!v || typeof v !== 'object') continue;
    clean[k] = {
      // Push başlığı telefonda onsuz da kəsilir; həddlər səxavətli saxlanılıb.
      title: typeof v.title === 'string' ? v.title.slice(0, 200)  : undefined,
      body:  typeof v.body  === 'string' ? v.body.slice(0, 1000) : undefined,
    };
  }
  await U.setSetting('PUSH_TEMPLATES', JSON.stringify(clean));
  return { success: true, config: U.getPushTemplates() };
};

API.resetPushTemplates = async () => {
  await U.setSetting('PUSH_TEMPLATES', '');
  return { success: true, config: U.getPushTemplates() };
};

// Şablonu göndərmədən əvvəl yoxlamaq üçün: doldurulmuş nümunə mətn.
// Bütün şablon növləri üçün ortaq nümunə dəyərlər.
// Bir filialın/işçinin adı uydurma deyil, real siyahıdan götürülür ki,
// önizləmə həqiqi mesajın uzunluğunu göstərsin.
function tplSample() {
  const filial = (U.DEPTS && U.DEPTS[0]) || 'Filial';
  return {
    ad: 'Rəşad Məmmədov', saat: '08:04', qeyd: ' — Vaxtında', ferq: '+15 dəq',
    deq: 27, say: 3, limit: U.getDisciplineConfig().lunchMaxMins,
    mebleg: U.getDisciplineConfig().fineAmount,
    kohne: filial, yeni: (U.DEPTS && U.DEPTS[1]) || 'Filial 2',
    brend: T.brand().name, cihaz: 'SD-4821',
    filial, mesaj: 'Kassada problem var.',
    emoji: '✅', status: 'təsdiqləndi', bas: '2026-08-24', son: '2026-08-26',
    tarix: '2026-08-21', sebeb: 'Forma geyinməyib', nov: 'ümumi mesajı',
    icraci: U.getSetting('EXEC_NAME') || 'İcraçı',
    basliq: 'Yeni Elan', metn: 'Bazar ertəsi ümumi yığıncaq var.',
  };
}

API.previewTgTemplate = async (key, text) => {
  if (!U.TG_KEYS.includes(key)) return { success: false, reason: 'Belə şablon yoxdur.' };
  return { success: true, text: U.fillTemplate(String(text || ''), tplSample()) };
};

API.previewPushTemplate = async (key, title, body) => {
  if (!U.PUSH_KEYS.includes(key)) return { success: false, reason: 'Belə şablon yoxdur.' };
  const s = tplSample();
  return {
    success: true,
    title: U.fillTemplate(String(title || ''), s),
    text:  U.fillTemplate(String(body  || ''), s),
  };
};

// Avans hansı aya aiddir? — TƏSDİQ/ÖDƏNİŞ günü (`decided_ymd`), o yoxdursa tələb günü.
// İki sorğu lazımdır: tələbi keçən ay, qərarı bu ay olan avans tək pəncərəyə düşmür.
// Əvvəl yalnız tələb tarixi işlədilirdi → iyulda istənib avqustda təsdiqlənən avans
// artıq ödənilmiş iyula yazılır və tutulma itirdi.
async function fetchAvansForMonth(startStr, endStr) {
  const cols = 'avans_id,emp_id,amount,note,status,date_str,decided_ymd';
  const byReq = await db().from('avans').select(cols).gte('date_str', startStr).lt('date_str', endStr);
  // Sütun hələ yaradılmayıbsa (avans-decided-migration.sql işlədilməyib) köhnə davranış
  if (byReq.error) {
    if (!/decided_ymd/i.test(byReq.error.message || '')) sbErr('fetchAvansForMonth', byReq.error);
    const { data } = await db().from('avans').select('emp_id,amount,note,status,date_str')
      .gte('date_str', startStr).lt('date_str', endStr);
    return { data: data || [] };
  }
  // NULL decided_ymd bu sorğuya düşmür (SQL-də NULL müqayisəsi false-dur) — istənilən budur
  const byDec = await db().from('avans').select(cols).gte('decided_ymd', startStr).lt('decided_ymd', endStr);
  sbErr('fetchAvansForMonth(qerar)', byDec.error);   // sınsa köhnə davranışa enirik, hesabat çökmür

  return { data: U.pickAvansForMonth([...(byReq.data || []), ...(byDec.data || [])], startStr, endStr) };
}

// Ayı CANLI hesablayır (bağlanma/snapshot məntiqi API.getSalaryReport-dadır).
async function computeSalaryReport(year, month) {
  const y = Number(year), mo = Number(month);
  if (!y || !mo || mo < 1 || mo > 12) return { rows: [], totals: {} };
  const cfg  = U.getSalaryConfig();
  const disc = U.getDisciplineConfig();   // qanuni cərimə tavanı (ƏM 175)
  // TEXT sütunlar üçün YMD, TIMESTAMPTZ sütunlar üçün ISO (izahı: U.ayPencere).
  // Əvvəl hamısı YMD idi; `timestamp`/`created_at` müqayisələri UTC-də şərh
  // olunub sərhədi yerli 04:00-a salırdı, məntiqi gün isə 03:00-dır (F-07).
  const ay = U.ayPencere(y, mo);
  const startStr = ay.startYmd, endStr = ay.endYmd;

  const [{ data: emps }, { data: logs }, { data: cedvelRows }, { data: sysFines }, { data: mgrFines }, { data: avansRows }] = await Promise.all([
    db().from('employees').select('*'),
    db().from('attendance').select('emp_id,timestamp,type,shift_type').gte('timestamp', ay.startIso).lt('timestamp', ay.endIso),
    db().from('cedvel').select('emp_id,date_str,shift_type').gte('date_str', startStr).lt('date_str', endStr),
    // Tutulmalar — hamısı həmin aya aiddir
    db().from('fines').select('emp_id,date_str,amount,reason,status,acked').gte('date_str', startStr).lt('date_str', endStr),
    db().from('mgr_fines').select('emp_id,amount,reason,status,created_at,created_by').gte('created_at', ay.startIso).lt('created_at', ay.endIso),
    fetchAvansForMonth(startStr, endStr),
  ]);

  // Tutulmaları işçi üzrə yığ (konfiqurasiyadakı status qaydalarına görə)
  const tutulma = {};
  const tut = (id) => (tutulma[id] = tutulma[id] || { cerime: 0, avans: 0, siyahi: [] });
  // İMZA QAYDASI: `finesOnlyAcked` açıqdırsa işçinin e-imza ilə təsdiqləmədiyi
  // cərimə hesabatda ÜMUMİYYƏTLƏ görünmür — nə məbləğə əlavə olunur, nə siyahıya.
  // İmza iki cədvəldə fərqli saxlanılır: `fines.acked` (boolean),
  // `mgr_fines.status === 'acknowledged'`.
  const imzali = cfg.finesOnlyAcked;
  for (const f of sysFines || []) {
    if (!cfg.fineStatuses.includes(f.status || 'unpaid')) continue;
    if (imzali && !f.acked) continue;
    const t = tut(String(f.emp_id)); const m = Number(f.amount) || 0;
    t.cerime += m;
    t.siyahi.push({ nov: 'cerime', date: f.date_str || '', mebleg: m, qeyd: f.reason || 'Gecikmə cəriməsi', menbe: 'Sistem' });
  }
  for (const f of mgrFines || []) {
    if (imzali && f.status !== 'acknowledged') continue;
    const t = tut(String(f.emp_id)); const m = Number(f.amount) || 0;
    t.cerime += m;
    t.siyahi.push({ nov: 'cerime', date: U.toYMD(new Date(f.created_at || Date.now())), mebleg: m, qeyd: f.reason || 'Menecer cəriməsi', menbe: f.created_by || 'Menecer' });
  }
  for (const a of avansRows || []) {
    if (!cfg.avansStatuses.includes(a.status)) continue;
    const t = tut(String(a.emp_id)); const m = Number(a.amount) || 0;
    t.avans += m;
    // Tarix kimi qərar günü göstərilir (tutulma həmin aya yazılır); tələb ayrı aydırsa qeyd edilir
    const qerarGunu = a.decided_ymd || a.date_str || '';
    const gecTeleb  = a.decided_ymd && a.date_str && a.date_str.slice(0, 7) !== a.decided_ymd.slice(0, 7);
    t.siyahi.push({
      nov: 'avans', date: qerarGunu, mebleg: m,
      qeyd: (a.note || 'Avans') + (gecTeleb ? ` (tələb: ${a.date_str})` : ''),
      menbe: a.status === 'paid' ? 'Ödənilib' : 'Təsdiqlənib',
    });
  }

  // Cədvəl: emp|gün → smen  (+ işçi üzrə istirahət günləri ayrıca)
  const cedvelMap = {};
  const istirahetMap = {};      // emp → [gün, ...]
  for (const c of cedvelRows || []) {
    const id = String(c.emp_id);
    cedvelMap[id + '|' + c.date_str] = c.shift_type || '';
    if (c.shift_type === 'istirahetsm') (istirahetMap[id] = istirahetMap[id] || []).push(c.date_str);
  }

  // Gəlişlər: emp → { məntiqi gün → gəlişdəki smen }  (eyni gündə təkrar gəliş bir gün sayılır)
  const gelisMap = {};
  for (const r of logs || []) {
    if (r.type !== 'GƏLİŞ') continue;
    const d = new Date(r.timestamp);
    if (isNaN(d.getTime())) continue;
    const id = String(r.emp_id);
    if (!gelisMap[id]) gelisMap[id] = {};
    const ds = U.getLogicalYMD(d);
    if (!(ds in gelisMap[id])) gelisMap[id][ds] = r.shift_type || '';
  }

  const rows = (emps || [])
    .filter(e => !e.is_test && !String(e.id).startsWith('MGR-'))
    .map(e => {
      const gunler = gelisMap[String(e.id)] || {};
      const detay = [];
      const limit = U.taxiLimitFor(e.taxi_limit, cfg);
      let maas = 0, taksi = 0, smenSayi = 0, tamGunSayi = 0, taksiGunu = 0, limitAsan = 0;
      for (const ds of Object.keys(gunler).sort()) {
        // Cədvəldəki smen əsasdır; yoxdursa gəliş anında qeyd olunan smen
        const shift = cedvelMap[String(e.id) + '|' + ds] || gunler[ds] || '';
        const g = U.computeDayPay(e.position || '', e.dept, shift, cfg);
        // Aylıq taksi limiti: limitdən sonrakı günlər taksi qazanmır (tarix sırası ilə)
        let gunTaksi = g.taxi;
        if (gunTaksi > 0) {
          if (taksiGunu >= limit) { gunTaksi = 0; limitAsan++; }
          else taksiGunu++;
        }
        maas += g.pay; taksi += gunTaksi; smenSayi += g.shifts;
        if (shift === 'tamgun') tamGunSayi++;
        detay.push({ date: ds, shift, shiftName: U.SHIFT_NAMES[shift] || '—', pay: g.pay, taxi: gunTaksi, taxiLimitli: g.taxi > 0 && gunTaksi === 0 });
      }

      // İSTİRAHƏT günləri — işçi gəlmir, amma günlük maaşı ödənilir (taksi yox).
      // İşçi həmin gün nədənsə gəlibsə, yuxarıdakı iş günü hesabı üstündür (təkrar ödəmə olmasın).
      // Aylıq tavan: istirahət günü gəliş tələb etmir və cədvəli menecer yazır — tavan
      // olmasa bütün ay istirahət yazılıb işləmədən tam maaş almaq olardı. Cədvəlin
      // saxlanması bloklanmır; limitdən sonrakı günlər sadəcə ödənilmir və admin-ə görünür.
      const istirahetLimit = cfg.restDayMonthlyLimit;
      let istirahetGunu = 0, istirahetMaas = 0, istirahetLimitAsan = 0;
      for (const ds of (istirahetMap[String(e.id)] || []).sort()) {
        if (ds in gunler) continue;                       // həmin gün onsuz da işlənib
        const g = U.computeRestDayPay(e.position || '', cfg);
        if (g.pay <= 0 && !cfg.restDayPaid) continue;
        if (istirahetGunu >= istirahetLimit) {            // tavan doldu → bu gün ödənilmir
          istirahetLimitAsan++;
          detay.push({ date: ds, shift: 'istirahetsm', shiftName: 'İstirahət', pay: 0, taxi: 0, istirahet: true, istirahetLimitli: true });
          continue;
        }
        istirahetGunu++; istirahetMaas += g.pay; maas += g.pay;
        detay.push({ date: ds, shift: 'istirahetsm', shiftName: 'İstirahət', pay: g.pay, taxi: 0, istirahet: true });
      }
      detay.sort((a, b) => String(a.date).localeCompare(String(b.date)));
      const t = tutulma[String(e.id)] || { cerime: 0, avans: 0, siyahi: [] };
      const brut = U.round2(maas + taksi);

      // ── QANUNİ TAVAN (AR ƏM 175) ──
      // Cərimə tutulması əmək haqqının müəyyən faizini (defolt 20%) keçə bilməz.
      // Tavandan artıq hissə TUTULMUR, amma qeyd İTMİR — hesabatda göstərilir
      // ki, admin nə qədərinin qanuni səbəbdən çıxılmadığını görsün.
      const cap = U.applyFineCap(brut, t.cerime, disc);

      return {
        empId: e.id, empName: e.name, dept: e.dept, position: e.position || '',
        rate: cfg.rates[e.position] || 0,
        gunSayi: Object.keys(gunler).length, istirahetGunu, istirahetMaas: U.round2(istirahetMaas),
        istirahetLimit, istirahetLimitAsan,
        smenSayi, tamGunSayi,
        taksiGunu, taksiLimit: limit, taksiLimitAsan: limitAsan,
        maas: U.round2(maas), taksi: U.round2(taksi), brut,
        cerime: U.round2(cap.tutulan), avans: U.round2(t.avans),
        // Qanuni tavana görə çıxılmayan hissə (0 = tavan işə düşməyib)
        cerimeXam:   U.round2(cap.tutulan + cap.kesilen),
        cerimeKesik: U.round2(cap.kesilen),
        cerimeLimit: cap.limit,
        cemi: U.round2(brut - cap.tutulan - t.avans),   // ƏLƏ VERİLƏCƏK məbləğ
        detay, tutulmalar: t.siyahi.sort((a, b) => String(a.date).localeCompare(String(b.date))),
      };
    })
    // Yalnız tutulması və ya ödənilən istirahəti olan (amma işləməyən) işçilər də görünsün.
    // `istirahetLimitAsan` da şərtdədir: yoxsa BÜTÜN istirahəti tavandan kənar qalan işçi
    // siyahıdan tamam düşər və admin problemi görməz.
    .filter(r => r.gunSayi > 0 || r.istirahetGunu > 0 || r.istirahetLimitAsan > 0 || r.cerime > 0 || r.avans > 0)
    .sort((a, b) => a.dept.localeCompare(b.dept) || b.cemi - a.cemi);

  const totals = rows.reduce((t, r) => {
    t.maas += r.maas; t.taksi += r.taksi; t.brut += r.brut;
    t.cerime += r.cerime; t.avans += r.avans; t.cemi += r.cemi;
    t.cerimeKesik += (r.cerimeKesik || 0);
    t.gun += r.gunSayi; t.smen += r.smenSayi; t.istirahet += r.istirahetGunu;
    return t;
  }, { maas: 0, taksi: 0, brut: 0, cerime: 0, avans: 0, cemi: 0, cerimeKesik: 0, gun: 0, smen: 0, istirahet: 0 });
  ['maas', 'taksi', 'brut', 'cerime', 'avans', 'cemi', 'cerimeKesik'].forEach(k => { totals[k] = U.round2(totals[k]); });
  // Panel qanuni tavanı izah edə bilsin deyə faiz də göndərilir
  totals.finePercentCap = disc.finePercentCap;

  // Vəzifəsi təyin edilməyənlər 0 maaş alır — admin xəbərdar olsun
  totals.vezifesiz = rows.filter(r => !r.position && r.gunSayi > 0).length;
  // İstirahət tavanına dəyən işçilər — cədvəldə anormal çox istirahət ola bilər
  totals.istirahetLimitli = rows.filter(r => r.istirahetLimitAsan > 0).length;
  return { rows, totals, config: cfg, year: y, month: mo };
}

// ── AYIN BAĞLANMASI ───────────────────────────────────────────────
// Bağlanmış ay bir daha yenidən hesablanmır: dərəcə dəyişikliyi, sonradan yazılan
// cərimə/avans, cədvəl düzəlişi və `recalcAllFines` artıq ödənilmiş ayın rəqəmlərini
// dəyişməsin. Səhv olsa admin ayı yenidən aça bilər.
const periodStr = (y, mo) => `${y}-${String(mo).padStart(2, '0')}`;

//  F-16: yenidən açılmış ay sətri BAZADA QALIR (silinmir), amma «bağlı»
//  sayılmır. `reopened_at IS NULL` — bağlılığın yeganə ölçüsüdür.
//  Sütun hələ yaradılmayıbsa (audit-log-migration.sql işlədilməyib) köhnə
//  davranış qalır: sətrin mövcudluğu = bağlıdır.
function acilibmi(row) {
  return !!(row && row.reopened_at);
}

async function getSalaryPeriod(period) {
  const { data, error } = await db().from('salary_periods').select('*').eq('period', period).maybeSingle();
  // Cədvəl hələ yaradılmayıbsa (salary-period-migration.sql işlədilməyib) sistem
  // sadəcə həmişə canlı hesablayır — heç nə sınmır.
  if (error) { if (!/salary_periods/i.test(error.message || '')) sbErr('getSalaryPeriod', error); return null; }
  if (!data || acilibmi(data)) return null;
  return data;
}

// Sətri OLDUĞU KİMİ oxuyur (açılmış olsa da) — yenidən bağlayanda köhnə
// snapshot-u jurnala yazmaq üçün lazımdır.
async function getSalaryPeriodRaw(period) {
  const { data, error } = await db().from('salary_periods').select('*').eq('period', period).maybeSingle();
  if (error) return null;
  return data || null;
}

// live=true → bağlı olsa da canlı hesabla (admin fərqi görmək istəyəndə)
API.getSalaryReport = async (year, month, live) => {
  const y = Number(year), mo = Number(month);
  if (!y || !mo || mo < 1 || mo > 12) return { rows: [], totals: {} };
  const period = periodStr(y, mo);
  const snap = await getSalaryPeriod(period);

  if (snap && !live) {
    return {
      rows: snap.rows || [], totals: snap.totals || {}, config: snap.config || U.getSalaryConfig(),
      year: y, month: mo, closed: true, closedAt: snap.closed_at, closedBy: snap.closed_by,
    };
  }
  const rep = await computeSalaryReport(y, mo);
  // Bağlı ayın canlı baxışı: admin snapshot ilə fərqi görsün
  if (snap) {
    rep.closed = true; rep.closedAt = snap.closed_at; rep.closedBy = snap.closed_by; rep.liveView = true;
    rep.snapshotCemi = (snap.totals && snap.totals.cemi) != null ? snap.totals.cemi : null;
  }
  return rep;
};

API.closeSalaryMonth = async (year, month) => {
  const y = Number(year), mo = Number(month);
  if (!y || !mo || mo < 1 || mo > 12) return { success: false, reason: 'Yanlış ay.' };
  const period = periodStr(y, mo);
  if (await getSalaryPeriod(period)) return { success: false, reason: 'Bu ay artıq bağlanıb.' };

  const rep = await computeSalaryReport(y, mo);
  if (!rep.rows || !rep.rows.length) return { success: false, reason: 'Bu ayda ödəniləcək heç nə yoxdur — bağlamağa ehtiyac yoxdur.' };

  //  Ay əvvəl bağlanıb-açılıbsa, sətir hələ də oradadır və indi ÜSTÜNDƏN
  //  yazılacaq. Köhnə snapshot itməsin deyə o, jurnala köçürülür —
  //  «mart ayı iki dəfə bağlanıb, birinci dəfə rəqəmlər bunlar idi».
  const kohne = await getSalaryPeriodRaw(period);
  if (kohne) await auditDetail('closeSalaryMonth:yenidən', period, {
    closed_at: kohne.closed_at, reopened_at: kohne.reopened_at, reopened_by: kohne.reopened_by,
    totals: kohne.totals, rows: kohne.rows,
  });

  const row = {
    period, closed_by: 'admin', config: rep.config, rows: rep.rows, totals: rep.totals,
    closed_at: new Date().toISOString(), reopened_at: null, reopened_by: null,
  };
  let { error } = kohne
    ? await db().from('salary_periods').update(row).eq('period', period)
    : await db().from('salary_periods').insert(row);
  // Sütunlar hələ yaradılmayıbsa köhnə formada təkrarla (miqrasiyadan əvvəlki aralıq)
  if (error && /reopened_/i.test(error.message || '')) {
    const { reopened_at: _a, reopened_by: _b, ...kohneForma } = row;
    ({ error } = kohne
      ? await db().from('salary_periods').update(kohneForma).eq('period', period)
      : await db().from('salary_periods').insert(kohneForma));
  }
  if (error) {
    if (/salary_periods/i.test(error.message || ''))
      return { success: false, reason: 'Cədvəl hələ yaradılmayıb — salary-period-migration.sql işlədilməlidir.' };
    sbErr('closeSalaryMonth', error);
    return { success: false, reason: error.message };
  }
  return { success: true, period, cemi: rep.totals.cemi, isciSayi: rep.rows.length };
};

//  F-16: ƏVVƏL burada `DELETE` vardı — ay yenidən açılanda «bağlananda
//  rəqəmlər bunlar idi» sənədi geri dönməz itirdi. Halbuki ayın bağlanmasının
//  bütün mənası elə həmin sənəddir (imzalanmış cərimələr, ödənilmiş məbləğlər).
//  İndi sətir QALIR, sadəcə `reopened_at` ilə işarələnir; hesabat yenidən
//  canlı hesablanır, çünki `getSalaryPeriod` açılmış ayı «bağlı» saymır.
API.reopenSalaryMonth = async (year, month) => {
  const y = Number(year), mo = Number(month);
  if (!y || !mo || mo < 1 || mo > 12) return { success: false, reason: 'Yanlış ay.' };
  const period = periodStr(y, mo);

  const kohne = await getSalaryPeriodRaw(period);
  if (!kohne) return { success: false, reason: 'Bu ay bağlanmayıb.' };
  if (kohne.reopened_at) return { success: false, reason: 'Bu ay artıq açıqdır.' };

  const patch = { reopened_at: new Date().toISOString(), reopened_by: T.role() || 'admin' };
  let { error } = await db().from('salary_periods').update(patch).eq('period', period);

  //  Sütunlar hələ yaradılmayıbsa (audit-log-migration.sql işlədilməyib)
  //  köhnə davranışa qayıdırıq — sistem dayanmasın. Amma snapshot-u ƏVVƏLCƏ
  //  jurnala yazırıq ki, heç olmasa orada qalsın.
  if (error && /reopened_/i.test(error.message || '')) {
    console.warn('[Salary] reopened_at sütunu yoxdur — snapshot yalnız jurnalda saxlanılır.');
    await auditDetail('reopenSalaryMonth:silindi', period, { totals: kohne.totals, rows: kohne.rows });
    ({ error } = await db().from('salary_periods').delete().eq('period', period));
  } else {
    await auditDetail('reopenSalaryMonth', period, { totals: kohne.totals, closed_at: kohne.closed_at });
  }

  sbErr('reopenSalaryMonth', error);
  return { success: !error, period };
};

// Hansı aylar bağlıdır (panel düymənin vəziyyətini bilsin)
API.getClosedSalaryMonths = async () => {
  const { data, error } = await db().from('salary_periods').select('*').order('period', { ascending: false });
  if (error) return [];
  // Yenidən açılmış aylar «bağlı» siyahısında görünmür (F-16) — sətir isə qalır.
  return (data || []).filter(r => !acilibmi(r))
    .map(r => ({ period: r.period, closedAt: r.closed_at, closedBy: r.closed_by }));
};

API.getWarnings = async () => {
  const { data: emps } = await db().from('employees').select('*');
  const now    = new Date();
  const dow    = now.getDay();
  const monday = new Date(now.getTime() - (dow === 0 ? 6 : dow - 1) * 86400000);
  monday.setHours(0, 0, 0, 0);

  const mondayStr = U.toYMD(monday);
  const [{ data: logs }, leaveMap, latePermMap, { data: warnCedvel }] = await Promise.all([
    db().from('attendance').select('*').eq('type', 'GƏLİŞ').gte('timestamp', monday.toISOString()),
    buildLeaveMap(),
    buildLatePermMap(),
    db().from('cedvel').select('emp_id,date_str,shift_type').gte('date_str', mondayStr),
  ]);

  const warnCedvelMap = {};
  for (const c of warnCedvel || []) {
    warnCedvelMap[String(c.emp_id) + '|' + c.date_str] = c.shift_type || null;
  }

  const grace = U.getDisciplineConfig().permGraceMins;   // döngədən KƏNARDA (F-18)
  const warnings = [];
  for (const emp of emps || []) {
    const myLogs = (logs || []).filter(r => r.emp_id === emp.id);
    let late = 0;
    for (const r of myLogs) {
      const d       = new Date(r.timestamp);
      const dateStr = U.getLogicalYMD(d);   // canlı sistemlə eyni gün (icazə/izin gecə-yarısı sərhədində düz tapılsın)
      const arrMins = d.getHours() * 60 + d.getMinutes();
      if (onLeave(leaveMap, emp.id, dateStr) || withinLatePerm(latePermMap, emp.id, dateStr, arrMins, grace)) continue;
      const st  = r.shift_type || warnCedvelMap[String(emp.id) + '|' + dateStr] || null;
      const si  = st ? U.getShiftInfo(emp.dept, st) : null;
      const isL = si
        ? arrMins > (si.lateH * 60 + si.lateM)
        : U.isLate(emp.dept, d);
      if (isL) late++;
    }
    if (late >= 3) warnings.push({ empId: emp.id, empName: emp.name, dept: emp.dept, lateCount: late });
  }
  return warnings.sort((a, b) => b.lateCount - a.lateCount);
};

// ── DAVAMIYYƏT ────────────────────────────────────────────────────
//  Davamiyyət sətrini yazır və qeydi HANSI KİOSKUN yazdığını saxlayır.
//  Audit izi: eyni cihaz bir neçə işçinin adından giriş yazırsa, yaxud bir
//  işçinin girişləri hər dəfə fərqli cihazdan gəlirsə — bu, nümunə kimi görünür.
//  Qarşısını almır, amma sübut yaradır.
//
//  `device_id` sütunu hələ yaradılmayıbsa (attendance-device-migration.sql
//  işlədilməyib) qeyd İTMƏSİN — sütunsuz təkrarlanır. Miqrasiyadan sonra bu
//  ehtiyat yol heç işə düşmür.
async function insertAttendance(row) {
  let { error } = await db().from('attendance').insert(row);
  if (error && /device_id/i.test(error.message || '')) {
    const { device_id: _d, ...kohne } = row;
    ({ error } = await db().from('attendance').insert(kohne));
    if (!error) console.warn('[Davamiyyət] device_id sütunu yoxdur — attendance-device-migration.sql işlədilməlidir.');
  }
  return error;
}

//  `secret`   — işçinin öz açarı (dispatcher onu X-CM-Key kimi də alır)
//  `qrToken`  — kiosk ekranından skan edilən mətn
//  ƏVVƏL burada dinamik 4 rəqəmli PIN vardı: server bütün işçiləri gəzib PIN-i
//  uyğunlaşdırırdı. O, həm lazımsız (açar onsuz da sorğudadır), həm də riskli
//  idi — 10 000 variant, toqquşmada SƏHV işçiyə gəliş yazılırdı. Silindi.
API.validateAndLog = async (secret, qrToken, forceMode) => {
  if (!secret) return { valid: false, reason: 'Kart tanınmadı. Linki yenidən açın.' };

  // Köhnə (keşdə qalmış) tətbiq versiyası: birinci arqument 4 rəqəmli PIN idi.
  // Səssiz uğursuzluq əvəzinə nə etmək lazım olduğunu deyirik.
  if (/^\d{4}$/.test(String(secret))) {
    return { valid: false, reason: 'Tətbiqin köhnə versiyası. Kartı bağlayıb yenidən açın.' };
  }

  const { data: matched } = await db().from('employees').select('*').eq('secret', secret).single();
  // `badPin` — dispatcher-dəki brute-force sayğacı yalnız BU halı sayır.
  // Aşağıdakı iş qaydası rədləri (istirahət, açıq smen, WiFi) sayılmır:
  // onlar real işçidir və limitə görə bloklanmamalıdırlar.
  if (!matched) return { valid: false, badPin: true, reason: 'Kart tanınmadı.' };

  // 1) Kiosk QR-ı — «ekranın qarşısındasan» sübutu
  const qr = await U.verifyKioskQr(qrToken, matched.dept);
  if (!qr.ok) return { valid: false, reason: qr.reason };

  // 2) Filial şəbəkəsi — «binadasan» sübutu. QR şəkil kimi ötürülə bilir,
  //    şəbəkə isə yox; ona görə bu yoxlama QR ilə birlikdə qalır.
  const wc = U.checkWifiIp(matched.dept, '');
  if (!wc.ok) return { valid: false, reason: wc.reason };

  // Qeydi hansı kioskun yazdığı saxlanılır (audit izi — bax `insertAttendance`)
  const deviceId = qr.device.device_id;

  const ts       = new Date();
  const todayStr = U.getLogicalDateStr(ts);
  const todayYMD = U.getLogicalYMD(ts);

  const todayShift = await U.getEmployeeShift(matched.id, todayYMD);
  if (todayShift === 'istirahetsm') return { valid: false, reason: 'Bu gün sizin istirahət gününüzdür!' };
  if (await U.hasApprovedLeave(matched.id, todayYMD)) return { valid: false, reason: 'Bu gün üçün təsdiq edilmiş izniniz var.' };

  const { data: allLogs } = await db().from('attendance').select('*').eq('emp_id', String(matched.id));
  const todayLogs = (allLogs || []).filter(r => U.getLogicalDateStr(new Date(r.timestamp)) === todayStr);
  const shiftInfo = todayShift ? U.getShiftInfo(matched.dept, todayShift) : null;

  if (todayLogs.length === 0) {
    const disc = U.getDisciplineConfig();

    // ── Bağlanmamış smen: giriş BLOKLANIR, admin təsdiqi lazımdır ──
    //  Axşam çıxış etməyən işçi səhər gələ bilmir. Əvvəl bunun yerinə hər gecə
    //  04:00-da avtomatik bağlama vardı — o, çıxış saatını UYDURUR və işçi
    //  cəzasız qalırdı. İndi admin real saatı yazıb təsdiqləyir.
    //
    //  Yalnız `openShiftLookbackDays` günlük pəncərəyə baxılır: köhnə qeyd
    //  səhvi işçini həmişəlik bağlamasın (adminin toplu təmizləmə düyməsi var).
    if (disc.blockOnOpenShift) {
      const sinir = U.toYMD(new Date(ts.getTime() - disc.openShiftLookbackDays * 86400000));
      const acqi = U.findOpenShifts(allLogs, { exceptDay: todayYMD }).filter(e => e.dayStr >= sinir);
      if (acqi.length) {
        const son = acqi[acqi.length - 1];
        // İşçi qapıda qalmasın deyə idarəçiyə DƏRHAL xəbər gedir.
        // Bildiriş göndərilə bilməsə də giriş yenə bloklanır — qaydanı
        // bildiriş kanalının işləməsindən asılı etmirik.
        try {
          await U.sendTgTemplate('openShiftBlocked',
            { ad: matched.name, gun: son.dayStr }, matched.dept);
          const pb = U.fillPush('openShiftBlocked', { ad: matched.name, gun: son.dayStr });
          if (pb) await sendPushToManager(matched.dept, pb.title, pb.body,
            { tag: 'openshift-' + matched.id, requireInteraction: true });
        } catch (e) { console.error('[OpenShift bildiriş]', e.message); }

        return {
          valid: false,
          warningType: 'UNCLOSED_SHIFT',       // skan səhifəsi bunu bloklayan ekranla göstərir
          empName: matched.name,
          openDay: son.dayStr,
          reason: `${son.dayStr} tarixli smeniniz bağlanmayıb. Giriş üçün idarəçi təsdiqi lazımdır.`,
        };
      }
    }

    const nowMins = ts.getHours() * 60 + ts.getMinutes() +
      (ts.getHours() < 3 && shiftInfo && shiftInfo.startH >= 12 ? 24 * 60 : 0);
    let late = shiftInfo
      ? nowMins > (shiftInfo.lateH * 60 + shiftInfo.lateM)
      : U.isLate(matched.dept, ts);
    if (late) {
      const perm = await U.getApprovedLatePerm(matched.id, todayYMD);
      if (perm) {
        const [ph, pm] = perm.requestedTime.split(':').map(Number);
        if ((ts.getHours() * 60 + ts.getMinutes()) <= ph * 60 + pm + disc.permGraceMins) late = false;
      }
    }
    let lateWarning = late ? '' : U.getTgTemplates().onTime;
    sbErr('validateAndLog:GƏLİŞ', await insertAttendance({
      emp_id: matched.id, emp_name: matched.name, dept: matched.dept,
      timestamp: ts.toISOString(), type: 'GƏLİŞ', overtime: '', shift_type: todayShift || '',
      device_id: deviceId,
    }));
    if (!matched.is_test) {
      const newStreak = await U.calcStreak(matched.id, matched.dept);
      await db().from('employees').update({ streak: newStreak }).eq('id', matched.id);
      if (!late) {
        // Gəliş XP-si və milestone bonusları XP_CONFIG-dədir (əvvəl burada hardcode idi).
        // recalcAllXP eyni mənbədən oxuyur → panel və yenidən hesablama uyğun qalır.
        const xpCfg = U.getXPConfig();
        await awardXP(matched.id, xpCfg.arrivalXP, newStreak);
        const MS_BONUSES = xpCfg.milestones;
        if (MS_BONUSES[newStreak]) {
          const claimed = matched.milestones_claimed || [];
          if (!claimed.includes(newStreak)) {
            await awardXP(matched.id, MS_BONUSES[newStreak], 0);
            await db().from('employees')
              .update({ milestones_claimed: [...claimed, newStreak] })
              .eq('id', matched.id);
          }
        }
      } else {
        // Gecikmə cəzası — pillələr və streak qalxanı DISCIPLINE_CONFIG-dədir
        const lateThreshold = U.getLateLimit(matched.dept, todayShift, ts.getHours() * 60 + ts.getMinutes());
        const lateMins = nowMins - lateThreshold;
        const penalty  = U.latePenaltyXP(lateMins, matched.streak, disc);
        const { data: empXP } = await db().from('employees').select('xp').eq('id', matched.id).single();
        const current = empXP?.xp || 0;
        await db().from('employees').update({ xp: Math.max(0, current - penalty) }).eq('id', matched.id);

        // Aylıq cərimə sistemi — izin və gec gəliş icazəsi olan günlər SAYILMIR.
        // Ay sərhədi GÜN KƏSİMİ saatındadır (03:00), yəni aşağıdakı `getLogicalYMD`
        // ilə dəqiq üst-üstə düşür: 1 avqust 01:00-da gələn işçi iyula aiddir və
        // pəncərə də onu iyulda saxlayır (F-07).
        const cariAy = U.ayPencere(ts.getFullYear(), ts.getMonth() + 1);
        const [{ data: monthLogs }, { data: monthIzin }, { data: monthPerms }] = await Promise.all([
          db().from('attendance').select('timestamp,shift_type').eq('emp_id', String(matched.id))
            .eq('type', 'GƏLİŞ').gte('timestamp', cariAy.startIso).lt('timestamp', cariAy.endIso),
          db().from('izin').select('start_date,end_date').eq('emp_id', String(matched.id)).eq('status', 'approved'),
          db().from('late_perms').select('date_str,requested_time').eq('emp_id', String(matched.id)).eq('status', 'approved'),
        ]);
        const finePermMap = {};
        for (const p of monthPerms || []) {
          const [ph, pm] = (p.requested_time || '23:59').split(':').map(Number);
          finePermMap[p.date_str] = ph * 60 + pm;
        }
        let prevLateCount = 0;
        for (const log of monthLogs || []) {
          const d = new Date(log.timestamp);
          if (U.getLogicalDateStr(d) === todayStr) continue; // bugünkü qeydi sayma
          // MƏNTİQİ gün — təqvim günü YOX (F-23). Gecə smenində 01:00-da gələn
          // işçinin izni/icazəsi əvvəlki günə yazılıb; təqvim günü ilə axtarsaq
          // tapılmır və vaxtında gəlmiş gün «üzrsüz gecikmə» kimi sayılır.
          const ds  = U.getLogicalYMD(d);
          const tot = d.getHours() * 60 + d.getMinutes();
          // Tam gün izin → cərimə sayılmır
          if ((monthIzin || []).some(r => ds >= r.start_date && ds <= r.end_date)) continue;
          // Gec gəliş icazəsi: icazə vaxtından (+güzəşt) tez gəlibsə → cərimə sayılmır
          if (ds in finePermMap && tot <= finePermMap[ds] + disc.permGraceMins) continue;
          const lim = U.getLateLimit(matched.dept, log.shift_type, tot);
          if (tot > lim) prevLateCount++;
        }
        const thisLateNum = prevLateCount + 1;
        // `fineAfterLates` qədər gecikmə güzəştdir (ƏM 186 — xəbərdarlıq tənbeh sayılmır);
        // ondan sonrakılar cəzalandırılır.
        const cezaVar = prevLateCount >= disc.fineAfterLates;
        // Bu ayda neçənci CƏZADIR — pillə buna görə seçilir:
        // 1-ci cəza pul cəriməsi, sonrakılar intizam tənbehi (töhmət → şiddətli → sonuncu).
        const cezaSira = thisLateNum - disc.fineAfterLates;
        const kind   = cezaVar ? U.cezaKind(cezaSira, disc) : null;
        const pulCez = kind === 'fine';
        const mebleg = pulCez ? disc.fineAmount : 0;

        // Mesaj CƏZA VƏZİYYƏTİNƏ görə seçilir, sabit "2-ci gecikmə"yə görə yox —
        // güzəşt sayı dəyişdirilsə xəbərdarlıq mərhələsi də onunla uzanır.
        const tg = U.getTgTemplates();
        lateWarning = U.fillTemplate(
          !cezaVar ? (prevLateCount === 0 ? tg.late1 : tg.late2)
                   : (pulCez ? tg.lateFine : tg.lateTohmet),
          { deq: lateMins, say: thisLateNum, mebleg, tenbeh: U.TOHMET_NAMES[kind] || '', ay: disc.tohmetMonths }
        );

        // Cəza DB-də saxlanılır (audit izi). Töhmətdə `amount = 0` olur →
        // maaş hesabatındakı cəm dəyişmir.
        if (cezaVar) {
          const sebeb = pulCez
            ? `Bu ay ${thisLateNum}-ci gecikmə (${lateMins} dəq)`
            : `${U.TOHMET_NAMES[kind]} — bu ay ${thisLateNum}-ci gecikmə (${lateMins} dəq)`;
          const row = {
            fine_id:   U.newId('FN-'),
            emp_id:    String(matched.id), emp_name: matched.name, dept: matched.dept,
            date_str:  todayYMD, amount: mebleg, late_num: thisLateNum, late_mins: lateMins,
            reason:    sebeb, status: 'unpaid',
            kind,
            // Tənbeh verilən gündən 6 ay qüvvədə olur (ƏM 190.1)
            expires_ymd: pulCez ? null : U.tohmetExpiry(todayYMD, disc),
          };
          let { error: fineErr } = await db().from('fines').insert(row);
          // `kind`/`expires_ymd` sütunları hələ yaradılmayıbsa (tohmet-migration.sql
          // işlədilməyib) qeyd İTMƏSİN — sütunsuz təkrarlanır.
          if (fineErr && /kind|expires_ymd/i.test(fineErr.message || '')) {
            const { kind: _k, expires_ymd: _e, ...kohne } = row;
            ({ error: fineErr } = await db().from('fines').insert(kohne));
            if (!fineErr) console.warn('[Töhmət] kind sütunu yoxdur — tohmet-migration.sql işlədilməlidir.');
          }
          sbErr('insertFine', fineErr);
        }
      }
    }
    await U.sendTgTemplate('arrive', { ad: matched.name, saat: U.fmtTime(ts), qeyd: lateWarning }, matched.dept);
    return { valid: true, empName: matched.name, dept: matched.dept, type: 'GƏLİŞ', overtime: '' };

  } else if (todayLogs.length === 1) {
    // Nahar açıq qalmışsa xəbərdar et (forceMode keçilmədikdə)
    if (!forceMode) {
      const { data: naharLogs } = await db().from('nahar').select('*').eq('emp_id', String(matched.id));
      const naharGet = (naharLogs || []).filter(r => U.getLogicalDateStr(new Date(r.timestamp)) === todayStr && r.type === 'NAHAR_GET');
      const naharQay = (naharLogs || []).filter(r => U.getLogicalDateStr(new Date(r.timestamp)) === todayStr && r.type === 'NAHAR_QAY');
      if (naharGet.length > 0 && naharQay.length === 0) {
        // `reason` QƏSDƏN əlavə olunub: əvvəl bu cavabı kiosk səhifəsi ayrıca
        // xəbərdarlıq ekranı ilə göstərirdi. PIN rejimi silindikdən sonra yeganə
        // çağıran işçi kartıdır və o, sadəcə `reason`-u göstərir — mətnsiz cavab
        // «Xəta baş verdi» kimi görünərdi.
        return {
          valid: false, warningType: 'UNCLOSED_LUNCH', empName: matched.name,
          reason: 'Nahardan qayıdış qeyd edilməyib. Əvvəlcə nahardan qayıdışı yazın.',
        };
      }
    }

    const reqH = shiftInfo ? shiftInfo.durH : fallbackShiftHours(matched.dept);
    const diffMs = ts.getTime() - new Date(todayLogs[0].timestamp).getTime() - reqH * 3600000;
    const absMs  = Math.abs(diffMs);
    const dh = Math.floor(absMs / 3600000), dm = Math.floor((absMs % 3600000) / 60000);
    const overtimeStr = (dh === 0 && dm === 0) ? 'Tam vaxtında'
      : `${diffMs >= 0 ? '+' : '-'}${dh} saat ${dm} dəq`;
    sbErr('validateAndLog:CIXIS', await insertAttendance({
      emp_id: matched.id, emp_name: matched.name, dept: matched.dept,
      timestamp: ts.toISOString(), type: 'CIXIS', overtime: overtimeStr, shift_type: todayShift || '',
      device_id: deviceId,
    }));
    // Nahara görə XP LƏĞV EDİLDİ — çıxışda nahar bonusu verilmir.
    await U.sendTgTemplate('leave', { ad: matched.name, saat: U.fmtTime(ts), ferq: overtimeStr }, matched.dept);
    return { valid: true, empName: matched.name, dept: matched.dept, type: 'CIXIS', overtime: overtimeStr };
  }
  return { valid: false, reason: 'Bu gün üçün artıq qeyd var' };
};

API.getOnlineEmployees = async () => {
  const todayStr = U.getLogicalDateStr(new Date());
  // Yalnız son 2 günün qeydləri bugünkü məntiqi günü əhatə etməyə kifayətdir
  const cutoff = new Date(Date.now() - 2 * 86400000).toISOString();
  const { data: logs } = await db().from('attendance').select('*').gte('timestamp', cutoff).order('timestamp');
  const empMap = {};
  for (const row of logs || []) {
    if (!row.emp_id || String(row.emp_id).startsWith('MGR-')) continue;
    const rd = new Date(row.timestamp);
    if (U.getLogicalDateStr(rd) !== todayStr) continue;
    if (!empMap[row.emp_id]) empMap[row.emp_id] = { name: row.emp_name, dept: row.dept, gelis: null, cixis: false };
    if (row.type === 'GƏLİŞ') empMap[row.emp_id].gelis = rd;
    if (row.type === 'CIXIS') empMap[row.emp_id].cixis = true;
  }
  return Object.values(empMap)
    .filter(e => e.gelis && !e.cixis)
    .map(e => ({ name: e.name, dept: e.dept, checkInTime: U.fmtTime(e.gelis), checkInMs: e.gelis.getTime() }))
    .sort((a, b) => a.checkInMs - b.checkInMs);
};

API.registerEmployeeSession = (secret) => {
  if (!secret) return { ok: false };
  return { ok: true };
};

// ── PUSH ABUNƏLIK ────────────────────────────────────────────────
//  Abunəlik yazmaq/silmək üçün TƏK NÖQTƏ. Əvvəl eyni upsert dörd yerdə
//  kopyalanmışdı və heç birində `error` OXUNMURDU — hər halda `{ ok: true }`
//  qaytarılırdı.
//
//  Bu, real bir sınmanı gizlədirdi: `onConflict:'endpoint'` tdb tərəfindən
//  (haqlı olaraq) `'tenant_id,endpoint'`-a çevrilir, amma bazada belə unikal
//  indeks yox idi → Postgres 42P10 verirdi → HEÇ BİR yeni abunəlik yazılmırdı,
//  panel isə «abunə olundu» göstərirdi. İndi xəta oxunur və çağırana qaytarılır.

// «ON CONFLICT üçün uyğun unikal indeks yoxdur» xətasını tanıyır.
function missingConflictIndex(err) {
  if (!err) return false;
  if (err.code === '42P10') return true;
  const m = String(err.message || err.details || '').toLowerCase();
  return m.includes('no unique or exclusion constraint');
}

async function savePushSubscription(empId, subscription) {
  const row = {
    emp_id:   String(empId),
    endpoint: subscription.endpoint,
    p256dh:   subscription.keys?.p256dh || '',
    auth:     subscription.keys?.auth   || '',
  };

  const { error } = await db().from('push_subscriptions').upsert(row, { onConflict: 'endpoint' });
  if (!error) return { ok: true };

  // İndeks hələ yaradılmayıbsa (push-endpoint-migration.sql işlədilməyib)
  // abunəlik İTMƏSİN — əl ilə sil+yaz. Miqrasiyadan sonra bu yol işə düşmür.
  if (missingConflictIndex(error)) {
    await db().from('push_subscriptions').delete().eq('endpoint', row.endpoint);
    const { error: insErr } = await db().from('push_subscriptions').insert(row);
    if (insErr) {
      sbErr('savePushSubscription(ehtiyat yol)', insErr);
      return { ok: false, reason: 'Bildiriş abunəliyi yazıla bilmədi.' };
    }
    console.warn('[Push] (tenant_id,endpoint) unikal indeksi yoxdur — ' +
                 'push-endpoint-migration.sql işlədilməlidir. Hazırda ehtiyat yolla yazılır.');
    return { ok: true, degraded: true };
  }

  sbErr('savePushSubscription', error);
  return { ok: false, reason: 'Bildiriş abunəliyi yazıla bilmədi.' };
}

async function dropPushSubscription(empId, endpoint) {
  const { error } = await db().from('push_subscriptions')
    .delete().eq('emp_id', String(empId)).eq('endpoint', endpoint);
  if (error) { sbErr('dropPushSubscription', error); return { ok: false, reason: 'Abunəlik silinmədi.' }; }
  return { ok: true };
}

API.subscribePush = async (secret, subscription) => {
  if (!secret || !subscription?.endpoint) return { ok: false, reason: 'Məlumat çatışmır.' };
  const { data: emp } = await db().from('employees').select('id').eq('secret', secret).single();
  if (!emp) return { ok: false, reason: 'İşçi tapılmadı.' };
  return savePushSubscription(emp.id, subscription);
};

API.unsubscribePush = async (secret, endpoint) => {
  if (!secret || !endpoint) return { ok: false };
  const { data: emp } = await db().from('employees').select('id').eq('secret', secret).single();
  if (!emp) return { ok: false };
  return dropPushSubscription(emp.id, endpoint);
};

// Manager push abunəliyi (branchKey ilə)
API.subscribePushManager = async (branchKey, subscription) => {
  if (!branchKey || !subscription?.endpoint) return { ok: false, reason: 'Məlumat çatışmır.' };
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return { ok: false, reason: 'İcazəsiz.' };
  return savePushSubscription('MGR-' + check.dept.replace(/\s+/g, ''), subscription);
};

API.unsubscribePushManager = async (branchKey, endpoint) => {
  if (!branchKey || !endpoint) return { ok: false };
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return { ok: false };
  return dropPushSubscription('MGR-' + check.dept.replace(/\s+/g, ''), endpoint);
};

// İcraçı push abunəliyi (emp_id = 'EXEC')
API.subscribePushExec = async (execKey, subscription) => {
  if (!execKey || roleKey('exec') !== execKey || !subscription?.endpoint) return { ok: false };
  return savePushSubscription('EXEC', subscription);
};

API.unsubscribePushExec = async (execKey, endpoint) => {
  if (!execKey || roleKey('exec') !== execKey || !endpoint) return { ok: false };
  return dropPushSubscription('EXEC', endpoint);
};

API.subscribePushTrainer = async (trainerKey, subscription) => {
  if (!trainerKey || roleKey('trainer') !== trainerKey || !subscription?.endpoint) return { ok: false };
  return savePushSubscription('TRAINER', subscription);
};

API.unsubscribePushTrainer = async (trainerKey, endpoint) => {
  if (!trainerKey || roleKey('trainer') !== trainerKey || !endpoint) return { ok: false };
  return dropPushSubscription('TRAINER', endpoint);
};

// ── DASHBOARD ─────────────────────────────────────────────────────

API.getDashboardData = async (secret) => {
  const { data: emp } = await db().from('employees').select('*').eq('secret', secret).single();
  if (!emp) return null;
  const now    = new Date();
  const monday = new Date(now.getTime() - ((now.getDay() === 0 ? 6 : now.getDay() - 1) * 86400000));
  monday.setHours(0, 0, 0, 0);
  const DAY_NAMES = ['B.e.','Ç.a.','Çər.','C.a.','Cüm.','Şən.','Baz.'];

  const nextMonday0 = new Date(monday.getTime() + 7 * 86400000);

  //  F-22: iki həftənin 14 günü ÜÇÜN BİR sorğu. Əvvəl `buildWeek` hər gün
  //  `getEmployeeShift` çağırırdı — kartın hər açılışında 14 əlavə sorğu.
  const iki_hefte = [];
  for (let d = 0; d < 14; d++) iki_hefte.push(U.toYMD(new Date(monday.getTime() + d * 86400000)));

  const [allDeptSched, allDeptSchedNext, shiftMap] = await Promise.all([
    API.getCedvel(emp.dept, U.toYMD(monday)),
    API.getCedvel(emp.dept, U.toYMD(nextMonday0)),
    U.getEmployeeShifts(emp.id, iki_hefte),
  ]);

  const buildWeek = (startDate, deptSched) => {
    const week = [];
    for (let d = 0; d < 7; d++) {
      const dd     = new Date(startDate.getTime() + d * 86400000);
      const ds     = U.toYMD(dd);
      const st     = shiftMap[ds] || null;
      const si     = st ? U.getShiftInfo(emp.dept, st) : null;
      const dayIdx = dd.getDay() === 0 ? 6 : dd.getDay() - 1;
      const myGroup = (st === 'axsamsm' || st === 'fullsm') ? 'evening' : 'morning';
      const colleagues = [];
      if (st && st !== 'istirahetsm') {
        for (const other of deptSched) {
          if (other.empId === emp.id) continue;
          const od = other.schedule[d];
          if (!od?.shiftType || od.shiftType === 'istirahetsm') continue;
          const tg = (od.shiftType === 'axsamsm' || od.shiftType === 'fullsm') ? 'evening' : 'morning';
          if (tg === myGroup) colleagues.push(other.empName.split(' ')[0]);
        }
      }
      week.push({ date: ds, dayName: DAY_NAMES[dayIdx], shiftType: st || '',
        label: si ? si.label : st === 'istirahetsm' ? 'İstirahət' : '-',
        isToday: U.toYMD(now) === ds, colleagues });
    }
    return week;
  };

  const weekSchedule     = buildWeek(monday, allDeptSched);
  const nextWeekSchedule = buildWeek(nextMonday0, allDeptSchedNext);

  // Hesabat, nahar və elanlar bir-birindən asılı deyil → paralel.
  const todayStr = U.getLogicalDateStr(now);
  const [report, { data: naharRows }, announcements] = await Promise.all([
    API.getMonthlyReport(now.getFullYear(), now.getMonth() + 1),
    db().from('nahar').select('*').eq('emp_id', String(emp.id)),
    API.getAnnouncements(),
  ]);
  const myR = report.find(r => r.empId === emp.id) || { totalDays:0, onTime:0, late:0, pct:0 };

  const naharGet = (naharRows || []).filter(r => U.getLogicalDateStr(new Date(r.timestamp)) === todayStr && r.type === 'NAHAR_GET');
  const naharQay = (naharRows || []).filter(r => U.getLogicalDateStr(new Date(r.timestamp)) === todayStr && r.type === 'NAHAR_QAY');
  const lunchStatus = (naharGet.length > 0 && naharQay.length === 0)
    ? { onLunch: true, startedAt: naharGet[0].timestamp }
    : { onLunch: false };

  return {
    streak:          emp.is_test ? 999 : (emp.streak || 0),
    xp:              emp.is_test ? 999999 : (emp.xp || 0),
    dept:            emp.dept,
    weekSchedule,
    nextWeekSchedule,
    monthStats:      { days: myR.totalDays, onTime: myR.onTime, late: myR.late, pct: myR.pct },
    announcements,
    lunchStatus,
    brand:           T.brand(),
    // Gecikmə xəbərdarlığının həddi. ƏVVƏL mycode.html-də filial adına görə
    // hardcode idi (`dept==='Ağ Şəhər' ? 16:05 : 15:05`). İndi filialın öz
    // konfiqurasiyasından gəlir — cavab serverdəki qayda ilə eyni olur.
    lateLimits: (function () {
      // Xəbərdarlıq payı: kartda "gecikmisən" yazısı hədddən bu qədər sonra çıxır.
      const buf = U.getDisciplineConfig().lateWarnBuffer;
      return {
        morning: U.getLateLimit(emp.dept, 'sehersm', 0) + buf,
        evening: U.getLateLimit(emp.dept, 'axsamsm', 14 * 60) + buf,
      };
    })(),
  };
};

// ── NAHAR ────────────────────────────────────────────────────────

API.logLunch = async (secret, clientIp, lunchType) => {
  if (!secret) return { valid: false, reason: 'Kod daxil edilməyib' };
  if (lunchType !== 'NAHAR_GET' && lunchType !== 'NAHAR_QAY') return { valid: false, reason: 'Yanlış nahar növü' };
  // İşçi öz `secret`-i ilə tapılır (nahar üçün kiosk QR-ı tələb olunmur — WiFi kifayətdir)
  const { data: matched } = await db().from('employees').select('*').eq('secret', secret).single();
  if (!matched) return { valid: false, reason: 'Yanlış və ya vaxtı keçmiş kod!' };
  // ƏVVƏL: `if (clientIp) { … }` — yəni IP gəlməsə yoxlama TAMAMİLƏ atlanırdı.
  // İndi şərtsizdir; IP-ni onsuz da server özü müəyyən edir.
  { const wc = U.checkWifiIp(matched.dept, clientIp); if (!wc.ok) return { valid: false, reason: wc.reason }; }

  const ts       = new Date();
  const todayStr = U.getLogicalDateStr(ts);
  const { data: attLogs } = await db().from('attendance').select('*').eq('emp_id', String(matched.id));
  const hasTodayGelis = (attLogs || []).some(r => U.getLogicalDateStr(new Date(r.timestamp)) === todayStr && r.type === 'GƏLİŞ');
  const hasTodayCixis = (attLogs || []).some(r => U.getLogicalDateStr(new Date(r.timestamp)) === todayStr && r.type === 'CIXIS');
  if (!hasTodayGelis) return { valid: false, reason: 'Əvvəlcə giriş qeydə alınmalıdır!' };
  if (hasTodayCixis)  return { valid: false, reason: 'Artıq smen çıxışı qeydə alınıb!' };

  const { data: naharLogs } = await db().from('nahar').select('*').eq('emp_id', String(matched.id));
  const naharGet = (naharLogs || []).filter(r => U.getLogicalDateStr(new Date(r.timestamp)) === todayStr && r.type === 'NAHAR_GET');
  const naharQay = (naharLogs || []).filter(r => U.getLogicalDateStr(new Date(r.timestamp)) === todayStr && r.type === 'NAHAR_QAY');

  if (lunchType === 'NAHAR_GET') {
    if (naharGet.length > 0) return { valid: false, reason: 'Artıq nahara çıxmısınız!' };
    await db().from('nahar').insert({ nahar_id: U.newId('NH-'), emp_id: matched.id, emp_name: matched.name, dept: matched.dept, timestamp: ts.toISOString(), type: 'NAHAR_GET' });
    await U.sendTgTemplate('lunchGo', { ad: matched.name, saat: U.fmtTime(ts) }, matched.dept);
    return { valid: true, empName: matched.name, dept: matched.dept, type: 'NAHAR_GET' };
  }
  if (naharGet.length === 0) return { valid: false, reason: 'Əvvəlcə nahara çıxış qeydə alınmalıdır!' };
  if (naharQay.length > 0)   return { valid: false, reason: 'Nahardan qayıdışınız artıq qeydə alınıb!' };
  const diffMin = Math.round((ts.getTime() - new Date(naharGet[0].timestamp).getTime()) / 60000);
  await db().from('nahar').insert({ nahar_id: U.newId('NH-'), emp_id: matched.id, emp_name: matched.name, dept: matched.dept, timestamp: ts.toISOString(), type: 'NAHAR_QAY' });
  const limit     = lunchMax();
  const lateLunch = diffMin > limit;
  await U.sendTgTemplate('lunchBack', { ad: matched.name, saat: U.fmtTime(ts), deq: diffMin }, matched.dept);
  if (lateLunch) {
    const p = U.fillPush('lunchLate', { ad: matched.name, deq: diffMin, limit });
    if (p) await sendPushToManager(matched.dept, p.title, p.body,
      { tag: 'lunch-late-' + matched.id });
  }
  // Nahar XP-si burada VERİLMİR — işçi nahar anında bal artımı görməsin.
  // Bonus (tez qayıdış / nahara getməmə) smen çıxışında hesablanır (aşağıda CIXIS bloku).
  return { valid: true, empName: matched.name, dept: matched.dept, type: 'NAHAR_QAY', duration: diffMin };
};

// Menecer: bugünkü nahar jurnalı (müddət + status; gec qayıdanlar/hələ naharda olanlar işarələnir)
API.getLunchLogForManager = async (branchKey) => {
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return [];
  const todayStr = U.getLogicalDateStr(new Date());
  const cutoff   = new Date(Date.now() - 2 * 86400000).toISOString();
  const { data: rows } = await db().from('nahar').select('*')
    .eq('dept', check.dept).gte('timestamp', cutoff);
  const byEmp = {};
  for (const r of rows || []) {
    if (U.getLogicalDateStr(new Date(r.timestamp)) !== todayStr) continue;
    const k = String(r.emp_id);
    if (!byEmp[k]) byEmp[k] = { empName: r.emp_name, get: null, qay: null };
    if (r.type === 'NAHAR_GET') byEmp[k].get = new Date(r.timestamp);
    if (r.type === 'NAHAR_QAY') byEmp[k].qay = new Date(r.timestamp);
  }
  const now = Date.now();
  const limit = lunchMax();
  const result = [];
  for (const k of Object.keys(byEmp)) {
    const e = byEmp[k];
    if (!e.get) continue;
    const endMs  = e.qay ? e.qay.getTime() : now;
    const durMin = Math.round((endMs - e.get.getTime()) / 60000);
    result.push({
      empName: e.empName,
      start:   U.fmtTime(e.get),
      end:     e.qay ? U.fmtTime(e.qay) : '',
      durMin,
      ongoing: !e.qay,
      late:    durMin > limit,
      limit,
    });
  }
  return result.sort((a, b) =>
    (b.ongoing ? 1 : 0) - (a.ongoing ? 1 : 0) || b.durMin - a.durMin
  );
};

// ── MENECER DAVAMİYYƏTİ ──────────────────────────────────────────

API.logManagerCheckin = async (branchKey, type) => {
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return { valid: false, reason: 'İcazəsiz giriş.' };
  const dept    = check.dept;
  const MGR_ID  = 'MGR-' + dept.replace(/\s+/g, '');
  const mgrName = 'Menecer (' + dept + ')';
  const ts      = new Date();
  const todayStr = U.getLogicalDateStr(ts);
  const { data: all } = await db().from('attendance').select('*').eq('emp_id', MGR_ID);
  const todayLogs = (all || []).filter(r => U.getLogicalDateStr(new Date(r.timestamp)) === todayStr);

  if (type === 'GELIS') {
    if (todayLogs.some(r => r.type === 'GELIS' || r.type === 'GƏLİŞ')) return { valid: false, reason: 'Giriş artıq qeydə alınıb!' };
    await db().from('attendance').insert({ emp_id: MGR_ID, emp_name: mgrName, dept, timestamp: ts.toISOString(), type: 'GELIS', overtime: '', shift_type: '' });
    await U.sendTgTemplate('mgrIn', { saat: U.fmtTime(ts) }, dept);
    return { valid: true, type: 'GELIS', time: U.fmtTime(ts) };
  }
  if (type === 'CIXIS') {
    const gelisRow = todayLogs.find(r => r.type === 'GELIS' || r.type === 'GƏLİŞ');
    if (!gelisRow) return { valid: false, reason: 'Əvvəlcə giriş qeydə alınmalıdır!' };
    if (todayLogs.some(r => r.type === 'CIXIS')) return { valid: false, reason: 'Çıxış artıq qeydə alınıb!' };
    const diffMs = ts.getTime() - new Date(gelisRow.timestamp).getTime();
    const dh = Math.floor(diffMs / 3600000), dm = Math.floor((diffMs % 3600000) / 60000);
    const dur = `${dh} saat ${dm} dəq`;
    await db().from('attendance').insert({ emp_id: MGR_ID, emp_name: mgrName, dept, timestamp: ts.toISOString(), type: 'CIXIS', overtime: dur, shift_type: '' });
    await U.sendTgTemplate('mgrOut', { saat: U.fmtTime(ts), ferq: dur }, dept);
    return { valid: true, type: 'CIXIS', time: U.fmtTime(ts), duration: dur };
  }
  return { valid: false, reason: 'Yanlış əməliyyat.' };
};

API.getManagersLiveStatus = async () => {
  const todayStr = U.getLogicalDateStr(new Date());
  // Yalnız son 2 günün qeydləri bugünkü məntiqi günü əhatə etməyə kifayətdir
  const cutoff = new Date(Date.now() - 2 * 86400000).toISOString();
  const { data: logs } = await db().from('attendance').select('*').gte('timestamp', cutoff).order('timestamp');
  const result = {};
  for (const dept of U.DEPTS) {
    const slug    = U.deptToSlug(dept);
    const mgrId   = 'MGR-' + dept.replace(/\s+/g, '');
    const deptLogs = (logs || []).filter(r => r.emp_id === mgrId && U.getLogicalDateStr(new Date(r.timestamp)) === todayStr);
    let gelisDate = null, cixisDate = null;
    for (const r of deptLogs) {
      const rd = new Date(r.timestamp);
      if (r.type === 'GELIS' || r.type === 'GƏLİŞ') gelisDate = rd;
      if (r.type === 'CIXIS') cixisDate = rd;
    }
    result[dept] = {
      mgrName:  mgrNameOf(dept) || `Menecer · ${dept}`,
      gelis:    gelisDate ? U.fmtTime(gelisDate) : null,
      gelisMs:  gelisDate ? gelisDate.getTime() : null,
      cixis:    cixisDate ? U.fmtTime(cixisDate) : null,
      isOnline: !!(gelisDate && !cixisDate),
      hadGelis: !!gelisDate,
    };
  }
  return result;
};

// ── MENECER İNFO ─────────────────────────────────────────────────
//  ƏVVƏL: idarəçi adı/mesajı `MGR_NAME_<slug>` və `MGR_MSG_<slug>` parametrlərində
//  idi və `MGR_SLUGS` 4 filialı sabit gəzirdi. İNDİ: hər ikisi `branches`
//  cədvəlinin sütunudur → filial sayı sərbəstdir.

// Bir və ya bir neçə filialın sütununu yeniləyir və keşi təzələyir.
async function patchBranches(patchBySlug) {
  const tid = T.tenantId();
  const entries = Object.entries(patchBySlug).filter(([slug]) => T.branchBySlug(slug));
  for (const [slug, patch] of entries) {
    await db().from('branches').update(patch).eq('branch_id', slug);
  }
  if (entries.length) await T.reload(tid);
  return entries.length;
}

API.getMgrInfo = () => ({
  globalMsg: U.getSetting('MGR_GLOBAL_MSG'),
  names: Object.fromEntries(T.branches().map(b => [b.branch_id, b.mgr_name || ''])),
  msgs:  Object.fromEntries(T.branches().map(b => [b.branch_id, b.mgr_msg  || ''])),
});

API.saveMgrInfo = async (data) => {
  if (data.globalMsg !== undefined) await U.setSetting('MGR_GLOBAL_MSG', data.globalMsg || '');
  const patch = {};
  for (const b of T.branches()) {
    const p = {};
    if (data.names?.[b.branch_id] !== undefined) p.mgr_name = data.names[b.branch_id] || '';
    if (data.msgs?.[b.branch_id]  !== undefined) p.mgr_msg  = data.msgs[b.branch_id]  || '';
    if (Object.keys(p).length) patch[b.branch_id] = p;
  }
  await patchBranches(patch);
  return { success: true };
};

// İcraçı menecerlərə mesaj yazır → saxla + həmin menecer(lər)ə push
API.saveExecMessages = async (execKey, data) => {
  if (!execAuth(execKey)) return { success: false, reason: 'İcazəsiz.' };
  const execName = U.getSetting('EXEC_NAME') || 'İcraçı';
  const keys = await U.getBranchScheduleKeys();

  if (data.globalMsg !== undefined) {
    await U.setSetting('MGR_GLOBAL_MSG', data.globalMsg || '');
    if (data.globalMsg) {
      for (const dept of U.DEPTS) {
        const p = U.fillPush('execGlobal', { icraci: execName, mesaj: String(data.globalMsg).slice(0, 140) });
        if (p) await sendPushToManager(dept, p.title, p.body,
          { tag: 'exec-global', url: '/manager?key=' + (keys[dept] || '') });
      }
    }
  }

  const patch = {};
  for (const b of T.branches()) {
    const msg = data.msgs?.[b.branch_id];
    if (msg === undefined) continue;
    patch[b.branch_id] = { mgr_msg: msg || '' };
  }
  await patchBranches(patch);

  for (const b of T.branches()) {
    const msg = data.msgs?.[b.branch_id];
    if (!msg) continue;
    const p = U.fillPush('execMsg', { icraci: execName, mesaj: String(msg).slice(0, 140) });
    if (p) await sendPushToManager(b.name, p.title, p.body,
      { tag: 'exec-msg-' + b.branch_id, url: '/manager?key=' + (keys[b.name] || '') });
  }
  return { success: true };
};

API.getMgrInfoForBranch = (branchKey) => {
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return null;
  const b = T.branchByName(check.dept);
  return { dept: check.dept, mgrName: (b && b.mgr_name) || '',
           globalMsg: U.getSetting('MGR_GLOBAL_MSG'), branchMsg: (b && b.mgr_msg) || '' };
};

// ── TELEGRAM ─────────────────────────────────────────────────────
//  Filial chat ID-ləri `branches.tg_chat_id`-dədir (əvvəl `TG_CHAT_<Ad>`).

API.getTelegramSettings = () => U.getTelegramSettings();

API.saveTelegramSettings = async (data) => {
  await Promise.all([
    U.setSetting('TG_TOKEN',      data.token     || ''),
    U.setSetting('TG_ADMIN_CHAT', data.adminChat || ''),
    U.setSetting('TG_ENABLED',    data.enabled ? 'true' : 'false'),
  ]);
  // data.chats = { <branch_id>: '<chatId>' }
  const patch = {};
  for (const [slug, chatId] of Object.entries(data.chats || {})) {
    patch[slug] = { tg_chat_id: chatId || '' };
  }
  await patchBranches(patch);
  return { success: true };
};

API.testTelegram = async () => {
  const cfg = U.getTelegramSettings();
  if (!cfg.token)     return { success: false, reason: 'Token boşdur.' };
  if (!cfg.adminChat) return { success: false, reason: 'Chat ID boşdur.' };
  try {
    const r = await fetch(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: cfg.adminChat,
        text: `<b>${T.brand().name}</b>\n\n✅ Telegram bağlantısı uğurla quruldu!`,
        parse_mode: 'HTML',
      }),
    });
    const d = await r.json();
    return d.ok ? { success: true } : { success: false, reason: d.description };
  } catch (e) { return { success: false, reason: e.toString() }; }
};

// ── WiFi IP ──────────────────────────────────────────────────────
//  `branches.wifi_ips` (əvvəl `IP_<slug>` parametrləri).

// Serverin MƏHZ BU sorğuda gördüyü IP.
//
// Admin paneli filial IP-sini bununla doldurmalıdır. Əvvəl panel `api.ipify.org`-dan
// oxuyurdu — o isə başqa dəyər qaytara bilər (fərqli IP ailəsi, fərqli çıxış nöqtəsi),
// yəni filial serverin heç vaxt görməyəcəyi bir IP ilə qeyd oluna bilərdi.
// İndi paneldəki rəqəm ilə yoxlamadakı rəqəm eyni mənbədəndir.
API.getMyIp = async () => ({
  ip:       T.clientIp(),
  enforced: U.WIFI_ENFORCE,     // false olsa panel bunu xəbərdarlıq kimi göstərir
});

API.getBranchIPs = () =>
  Object.fromEntries(T.branches().map(b => [b.branch_id, b.wifi_ips || '']));

API.saveBranchIPs = async (data) => {
  const patch = {};
  for (const [slug, ips] of Object.entries(data || {})) {
    patch[slug] = { wifi_ips: ips || '' };
  }
  await patchBranches(patch);
  return { success: true };
};

// ── ÇEKLİST ─────────────────────────────────────────────────────

API.getChecklistItems = async () => {
  const { data } = await db().from('checklist_items').select('*').order('sort_order');
  return (data || []).map(r => ({ ...r, itemId: r.item_id, active: !!r.active }));
};

API.saveChecklistItems = async (items) => {
  //  Siyahı BÜTÖV əvəz olunur (boş siyahı = hamısını sil) — davranış dəyişmir,
  //  sadəcə insert sınsa köhnə siyahı geri qayıdır (F-17).
  const incoming = (items || []).map((item, i) => ({
    item_id:    String(item.itemId || item.item_id || U.newId('CI-', i)),
    text:       String(item.text || '').trim(),
    category:   String(item.category || 'Digər'),
    sort_order: i + 1,
    active:     item.active !== false,
  })).filter(r => r.text);

  const r = await replaceRows('checklist_items', (q) => q.neq('item_id', 'x'), incoming, 'saveChecklistItems');
  if (!r.ok) return { success: false, reason: r.reason, restored: r.restored };
  return { success: true };
};

API.getChecklistForBranch = async (branchKey) => {
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return { valid: false, reason: 'İcazəsiz giriş.' };
  const today = U.toYMD(new Date());
  const [{ data: items }, { data: logs }] = await Promise.all([
    db().from('checklist_items').select('*').eq('active', true).order('sort_order'),
    db().from('checklist_logs').select('*').eq('date', today).eq('dept', check.dept),
  ]);
  const logMap = {};
  for (const r of logs || []) logMap[r.item_id] = r;
  return { valid: true, dept: check.dept, date: today, items: (items || []).map(item => {
    const log = logMap[item.item_id] || {};
    return {
      ...item,
      itemId:    item.item_id,
      active:    !!item.active,
      checked:   !!log.checked,
      checkedAt: log.checked_at || '',
      checked_at:log.checked_at || '',
      mgrNote:   log.mgr_note  || '',
      mgr_note:  log.mgr_note  || '',
      adminNote: log.admin_note|| '',
      admin_note:log.admin_note|| '',
    };
  }) };
};

API.submitChecklistItem = async (branchKey, itemId, checked, mgrNote) => {
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return { valid: false, reason: 'İcazəsiz giriş.' };
  const today = U.toYMD(new Date());
  const ts    = new Date();
  const { data: existing } = await db().from('checklist_logs').select('log_id').eq('date', today).eq('dept', check.dept).eq('item_id', String(itemId)).single();
  if (existing) {
    await db().from('checklist_logs').update({ checked: !!checked, checked_at: checked ? U.fmtTime(ts) : '', mgr_note: mgrNote || '' }).eq('log_id', existing.log_id);
  } else {
    const { data: itemRow } = await db().from('checklist_items').select('text').eq('item_id', String(itemId)).single();
    await db().from('checklist_logs').insert({ log_id: U.newId('CL-'), date: today, dept: check.dept, item_id: itemId, item_text: itemRow?.text || '', checked: !!checked, checked_at: checked ? U.fmtTime(ts) : '', mgr_note: mgrNote || '', admin_note: '' });
  }
  return { valid: true, checkedAt: checked ? U.fmtTime(ts) : '', checked_at: checked ? U.fmtTime(ts) : '' };
};

API.getChecklistReport = async (dateStr) => {
  const date  = dateStr || U.toYMD(new Date());
  
  const [{ data: items }, { data: logs }] = await Promise.all([
    db().from('checklist_items').select('*').eq('active', true).order('sort_order'),
    db().from('checklist_logs').select('*').eq('date', date),
  ]);
  const report = {};
  for (const dept of U.DEPTS) {
    report[dept] = {};
    for (const item of items || []) report[dept][item.item_id] = { checked: false, checked_at: '', mgr_note: '', admin_note: '' };
  }
  for (const r of logs || []) {
    if (report[r.dept]?.[r.item_id] !== undefined) {
      report[r.dept][r.item_id] = {
        checked:    !!r.checked,
        checkedAt:  r.checked_at  || '', checked_at:  r.checked_at  || '',
        mgrNote:    r.mgr_note    || '', mgr_note:    r.mgr_note    || '',
        adminNote:  r.admin_note  || '', admin_note:  r.admin_note  || '',
      };
    }
  }
  return { date, items: (items || []).map(i => ({ ...i, itemId: i.item_id, active: !!i.active })), report };
};

API.saveAdminNote = async (dateStr, dept, itemId, adminNote) => {
  const date = dateStr || U.toYMD(new Date());
  const { data: existing } = await db().from('checklist_logs').select('log_id').eq('date', date).eq('dept', dept).eq('item_id', String(itemId)).single();
  if (existing) {
    await db().from('checklist_logs').update({ admin_note: adminNote || '' }).eq('log_id', existing.log_id);
  } else {
    const { data: itemRow } = await db().from('checklist_items').select('text').eq('item_id', String(itemId)).single();
    await db().from('checklist_logs').insert({ log_id: U.newId('CL-'), date, dept, item_id: itemId, item_text: itemRow?.text || '', checked: false, checked_at: '', mgr_note: '', admin_note: adminNote || '' });
  }
  return { success: true };
};

// ── MENECER TƏSDİQ ───────────────────────────────────────────────

API.getMgrAckStatus = async (branchKey) => {
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return null;
  const { data } = await db().from('mgr_acks').select('*').eq('date', U.toYMD(new Date())).eq('dept', check.dept).single();
  if (!data) return { globalAcked: false, globalAckedAt: '', branchAcked: false, branchAckedAt: '' };
  return { globalAcked: !!data.global_acked, globalAckedAt: data.global_acked_at || '', branchAcked: !!data.branch_acked, branchAckedAt: data.branch_acked_at || '' };
};

API.ackMgrMessage = async (branchKey, msgType) => {
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return { success: false };
  const today = U.toYMD(new Date()), ts = U.fmtTime(new Date());
  const { data: existing } = await db().from('mgr_acks').select('ack_id').eq('date', today).eq('dept', check.dept).single();
  const upd = msgType === 'global' ? { global_acked: true, global_acked_at: ts } : { branch_acked: true, branch_acked_at: ts };
  if (existing) {
    await db().from('mgr_acks').update(upd).eq('ack_id', existing.ack_id);
  } else {
    await db().from('mgr_acks').insert({ ack_id: U.newId('ACK-'), date: today, dept: check.dept, ...upd });
  }
  // İcraçıya təsdiq bildirişi
  const typeAz = msgType === 'global' ? 'ümumi mesajı' : 'filial mesajını';
  const pAck = U.fillPush('execAck', { filial: check.dept, nov: typeAz, saat: ts });
  if (pAck) await sendPushToExec(pAck.title, pAck.body,
    { tag: 'exec-ack-' + check.dept + '-' + msgType, url: '/icraci?key=' + roleKey('exec') });
  return { success: true, time: ts };
};

API.getMgrAcksForAdmin = async (dateStr) => {
  const date  = dateStr || U.toYMD(new Date());
  
  const { data } = await db().from('mgr_acks').select('*').eq('date', date);
  const result = {};
  for (const d of U.DEPTS) result[d] = { globalAcked: false, globalAckedAt: '', branchAcked: false, branchAckedAt: '' };
  for (const r of data || []) {
    if (result[r.dept]) result[r.dept] = { globalAcked: !!r.global_acked, globalAckedAt: r.global_acked_at || '', branchAcked: !!r.branch_acked, branchAckedAt: r.branch_acked_at || '' };
  }
  return { date, acks: result };
};

// ── MƏHSULLAR ────────────────────────────────────────────────────

// İcazə verilən itki faizi. ƏVVƏL filial adları ilə hardcode obyekt idi
// (`{'Gənclik':2.5, 'Ağ Şəhər':3.0, ...}`), İNDİ `branches.waste_limit` sütunu.
function getWasteLimit(dept) {
  const b = T.branchByName(dept);
  const v = b && b.waste_limit;
  return Number.isFinite(Number(v)) ? Number(v) : 3.0;
}

API.getProducts = async () => {
  const { data } = await db().from('products').select('*').eq('active', true).order('name');
  return (data || []).map(p => ({ productId: p.product_id, product_id: p.product_id, name: p.name, unit: p.unit }));
};

API.addProduct = async (name, unit) => {
  if (!name?.trim()) return { success: false, reason: 'Ad boş ola bilməz.' };
  const id = U.newId('PRD-');
  const { error } = await db().from('products').insert({ product_id: id, name: name.trim(), unit: unit || 'ədəd', active: true });
  return { success: !error, productId: id, product_id: id };
};

API.deleteProduct = async (productId) => {
  const { error } = await db().from('products').update({ active: false }).eq('product_id', productId);
  return error ? { success: false, reason: 'Tapılmadı.' } : { success: true };
};

API.getProductLogsForBranch = async (branchKey, monthStr) => {
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return { valid: false };
  const { data: products } = await db().from('products').select('*').eq('active', true);
  const { data: logs } = await db().from('product_logs').select('*').eq('dept', check.dept).like('date_str', monthStr + '%');
  const totals = {};
  for (const r of logs || []) {
    if (!totals[r.product_id]) totals[r.product_id] = { incoming: 0, wasted: 0 };
    totals[r.product_id].incoming += Number(r.incoming) || 0;
    totals[r.product_id].wasted   += Number(r.wasted)   || 0;
  }
  let totalIn = 0, totalWasted = 0;
  const items = (products || []).map(p => {
    const t = totals[p.product_id] || { incoming:0, wasted:0 };
    totalIn += t.incoming; totalWasted += t.wasted;
    return { productId: p.product_id, product_id: p.product_id, name: p.name, unit: p.unit, totalIncoming: t.incoming, totalWasted: t.wasted };
  });
  const limit = getWasteLimit(check.dept);
  const pct   = totalIn > 0 ? Math.round(totalWasted / totalIn * 1000) / 10 : 0;
  return { valid: true, dept: check.dept, monthStr, items, limit, totalIn, totalWasted, pct, exceeded: totalIn > 0 && pct > limit };
};

API.saveProductLogs = async (branchKey, monthStr, logs) => {
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return { valid: false };
  const todayYMD = U.toYMD(new Date());
  const toInsert = (logs || []).filter(l => (l.product_id||l.productId) && (Number(l.incoming) || Number(l.wasted))).map((l, i) => ({
    log_id: U.newId('PL-', i),
    date_str: todayYMD, dept: check.dept, product_id: l.product_id||l.productId, product_name: l.name||l.productName||'',
    incoming: Number(l.incoming) || 0, wasted: Number(l.wasted) || 0,
  }));
  if (toInsert.length) await db().from('product_logs').insert(toInsert);
  const { data: allLogs } = await db().from('product_logs').select('*').eq('dept', check.dept).like('date_str', monthStr + '%');
  let totalIn = 0, totalWasted = 0;
  for (const r of allLogs || []) { totalIn += Number(r.incoming)||0; totalWasted += Number(r.wasted)||0; }
  const limit = getWasteLimit(check.dept);
  const pct   = totalIn > 0 ? Math.round(totalWasted / totalIn * 1000) / 10 : 0;
  return { valid: true, pct, limit, exceeded: totalIn > 0 && pct > limit, totalIn, totalWasted };
};

API.getWasteStatsForAdmin = async (dateStr) => {
  
  const { data: logs } = await db().from('product_logs').select('*').like('date_str', dateStr + '%');
  const deptMap = {};
  for (const d of U.DEPTS) deptMap[d] = { dept: d, totalIn:0, totalWasted:0, products:[], limit: getWasteLimit(d) };
  for (const r of logs || []) {
    if (!deptMap[r.dept] || (!r.incoming && !r.wasted)) continue;
    deptMap[r.dept].totalIn     += Number(r.incoming)||0;
    deptMap[r.dept].totalWasted += Number(r.wasted)  ||0;
    deptMap[r.dept].products.push({ name: r.product_name, incoming: Number(r.incoming)||0, wasted: Number(r.wasted)||0 });
  }
  return U.DEPTS.map(d => {
    const s = deptMap[d], pct = s.totalIn > 0 ? Math.round(s.totalWasted/s.totalIn*1000)/10 : 0;
    return { dept:s.dept, totalIn:s.totalIn, totalWasted:s.totalWasted, pct, limit:s.limit, exceeded:s.totalIn>0&&pct>s.limit, hasData:s.totalIn>0||s.totalWasted>0, products:s.products };
  });
};

// ── MENECER HƏFTƏLIK QRAFİK ───────────────────────────────────────

API.getMgrWeekSchedule = async (branchKey, weekStart) => {
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return null;
  const start = new Date(weekStart);
  const dates = Array.from({length:7}, (_, d) => U.toYMD(new Date(start.getTime()+d*86400000)));
  const { data } = await db().from('mgr_schedule').select('*').eq('dept', check.dept).in('date_str', dates);
  const map = {};
  for (const r of data || []) map[r.date_str] = r.shift_type;
  return { dept: check.dept, schedule: dates.map(ds => ({ date: ds, shiftType: map[ds] || '' })) };
};

API.saveMgrWeekSchedule = async (branchKey, entries) => {
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return { success: false, reason: 'İcazəsiz.' };
  const dates = entries.map(e => e.dateStr).filter(Boolean);
  const toInsert = entries.filter(e => e.dateStr && e.shiftType).map((e, i) => ({
    sched_id: U.newId('MS-', i),
    dept: check.dept, date_str: e.dateStr, shift_type: e.shiftType,
  }));
  if (!dates.length) return { success: true };
  const r = await replaceRows('mgr_schedule',
    (q) => q.eq('dept', check.dept).in('date_str', dates), toInsert, 'saveMgrWeekSchedule');
  if (!r.ok) return { success: false, reason: r.reason, restored: r.restored };
  return { success: true };
};

API.getMgrScheduleForAdmin = async (weekStart) => {
  
  const start = new Date(weekStart);
  const dates = Array.from({length:7}, (_, d) => U.toYMD(new Date(start.getTime()+d*86400000)));
  const { data } = await db().from('mgr_schedule').select('*').in('date_str', dates);
  const map = {};
  for (const dept of U.DEPTS) map[dept] = {};
  for (const r of data || []) { if (map[r.dept]) map[r.dept][r.date_str] = r.shift_type; }
  const DAY_NAMES = ['B.e.','Ç.a.','Çər.','C.a.','Cüm.','Şən.','Baz.'];
  return {
    dates: dates.map(ds => { const dd=new Date(ds); return {date:ds,dayName:DAY_NAMES[dd.getDay()===0?6:dd.getDay()-1]}; }),
    managers: U.DEPTS.map(dept => ({ dept, mgrName: mgrNameOf(dept)||dept, schedule: dates.map(ds=>map[dept][ds]||'') })),
  };
};

// ── GEC GƏLİŞ İCAZƏSİ ────────────────────────────────────────────

API.requestLatePerm = async (secret, dateStr, requestedTime) => {
  if (!secret||!dateStr||!requestedTime) return { success:false, reason:'Məlumatlar natamamdır.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return { success:false, reason:'Tarix formatı yanlışdır.' };
  if (!/^\d{2}:\d{2}$/.test(requestedTime)) return { success:false, reason:'Vaxt formatı yanlışdır.' };
  const { data: emp } = await db().from('employees').select('*').eq('secret', secret).single();
  if (!emp) return { success:false, reason:'İşçi tapılmadı.' };
  // `.single()` İŞLƏDİLMİR (F-25 ilə eyni kök): (emp_id,date_str) üzrə unikallıq
  // yoxdur, təkrar sətir olanda `.single()` xəta verib `existing`-i null edirdi —
  // yəni bir dəfə təkrar yarananda bu qapı BÜSBÜTÜN açıq qalırdı və hər müraciət
  // yeni sətir yazırdı. İndi bütün sətirlər oxunur.
  const { data: existingRows } = await db().from('late_perms').select('status').eq('emp_id', String(emp.id)).eq('date_str', dateStr);
  if ((existingRows || []).some(r => r.status==='pending' || r.status==='approved')) return { success:false, reason:'Bu tarix üçün artıq icazəniz mövcuddur.' };
  const permId = U.newId('LP-');
  await db().from('late_perms').insert({ perm_id: permId, emp_id:emp.id, emp_name:emp.name, dept:emp.dept, date_str:dateStr, requested_time:requestedTime, status:'pending' });

  // Manager-ə push bildiriş
  const pReq = U.fillPush('latePermRequest', { ad: emp.name, tarix: dateStr, saat: requestedTime });
  if (pReq) await sendPushToManager(
    emp.dept,
    pReq.title,
    pReq.body,
    { tag: 'lateperm-req-' + permId, url: '/manager?key=' + (await U.getBranchScheduleKeys())[emp.dept] }
  );
  return { success:true, permId };
};

// ── MENECER BU SƏTRƏ TOXUNA BİLƏRMİ? (F-13, F-14) ────────────────
//  Qayda: menecerin GÖRDÜYÜ sətir = dəyişə biləcəyi sətir.
//  `getLatePermsForManager` və `getAvansForManager` siyahını İKİ mənbədən
//  yığır — sətrin öz `dept`-i, VƏ işçinin CARİ filialı. İkisi lazımdır, çünki
//  işçi filial dəyişəndə köhnə sətirlərdə `dept` köhnə qalır.
//  Təsdiq yoxlaması eyni qaydanı təkrarlamalıdır: sərtləşdirsək menecer
//  siyahıda görüb toxuna bilmədiyi sətirlə qarşılaşar, yumşaltsaq isə
//  BAŞQA filialın sətrini dəyişə bilər (səhvin özü bu idi).
async function rowInBranch(rowDept, empId, dept) {
  if (rowDept && rowDept === dept) return true;
  if (!empId) return false;
  const { data: emp } = await db().from('employees').select('dept').eq('id', String(empId)).single();
  return !!emp && emp.dept === dept;
}

API.getLatePermsForManager = async (branchKey) => {
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return [];

  // İki ayrı sorğu: dept adına görə VƏ filialın işçi ID-lərinə görə
  // (dept string-ində xüsusi hərflər olduğu üçün .or() işlətmirik)
  const { data: empRows } = await db().from('employees').select('id').eq('dept', check.dept);
  const empIds = (empRows || []).map(e => String(e.id));

  const [{ data: byDept }, { data: byEmpId }] = await Promise.all([
    db().from('late_perms').select('*').eq('dept', check.dept)
      .order('created_at', { ascending: false }).limit(50),
    empIds.length
      ? db().from('late_perms').select('*').in('emp_id', empIds)
          .order('created_at', { ascending: false }).limit(50)
      : Promise.resolve({ data: [] }),
  ]);

  // Birləşdir, təkrarları sil (perm_id-ə görə)
  const seen = new Set();
  const merged = [...(byDept || []), ...(byEmpId || [])].filter(r => {
    if (seen.has(r.perm_id)) return false;
    seen.add(r.perm_id);
    return true;
  });

  return merged.map(r => ({
    permId:        r.perm_id,
    empId:         r.emp_id,
    empName:       r.emp_name,
    dept:          r.dept,
    dateStr:       r.date_str,
    requestedTime: r.requested_time,
    status:        r.status,
    createdAt:     r.created_at,
  })).sort((a, b) => {
    if (a.status === 'pending' && b.status !== 'pending') return -1;
    if (a.status !== 'pending' && b.status === 'pending') return  1;
    return (b.createdAt || '').localeCompare(a.createdAt || '');
  });
};

// İcraçı: bütün filiallar üzrə gecikmə icazələri (filial → siyahı)
API.getLatePermsForExec = async (execKey) => {
  if (!execKey || roleKey('exec') !== execKey) return null;
  const { data } = await db().from('late_perms').select('*')
    .order('created_at', { ascending: false }).limit(400);
  const result = {};
  for (const d of U.DEPTS) result[d] = [];
  for (const r of (data || [])) {
    const dept = r.dept || '';
    if (!result[dept]) result[dept] = [];
    result[dept].push({
      permId: r.perm_id, empId: r.emp_id, empName: r.emp_name, dept,
      dateStr: r.date_str, requestedTime: r.requested_time,
      status: r.status, createdAt: r.created_at, approvedAt: r.approved_at || '',
    });
  }
  for (const d of Object.keys(result)) {
    result[d].sort((a, b) => {
      if (a.status === 'pending' && b.status !== 'pending') return -1;
      if (a.status !== 'pending' && b.status === 'pending') return  1;
      return (b.createdAt || '').localeCompare(a.createdAt || '');
    });
  }
  return result;
};

API.approveLatePerm = async (branchKey, permId, action) => {
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return { success: false, reason: 'İcazəsiz.' };
  if (action !== 'approved' && action !== 'rejected') return { success: false, reason: 'Yanlış əməliyyat.' };
  const { data: perm } = await db().from('late_perms').select('emp_id,dept,date_str,requested_time').eq('perm_id', permId).single();
  if (!perm) return { success: false, reason: 'İcazə tapılmadı.' };

  // F-13: açar ETİBARLI olsa da, sətir HƏMİN filialın olmalıdır.
  // Əvvəl bu yoxlama yox idi → istənilən filialın meneceri `permId`-ni bilsə
  // (və ya təxmin etsə) BAŞQA filialın gec gəliş icazəsini təsdiqləyə bilirdi.
  if (!await rowInBranch(perm.dept, perm.emp_id, check.dept)) {
    return { success: false, reason: 'Bu icazə sizin filialınıza aid deyil.' };
  }

  const { error, count } = await db().from('late_perms')
    .update({ status: action, approved_at: new Date().toISOString() })
    .eq('perm_id', permId);
  if (!error && perm) {
    const emoji   = action === 'approved' ? '✅' : '❌';
    const statusAz = action === 'approved' ? 'təsdiqləndi' : 'rədd edildi';
    const p = U.fillPush('latePermDecision', { emoji, tarix: perm.date_str, saat: perm.requested_time, status: statusAz });
    if (p) await sendPushToEmployee(
      perm.emp_id,
      p.title,
      p.body,
      { tag: 'lateperm-' + permId }
    );
  }
  return { success: !error, updated: count };
};

API.getMyLatePerms = async (secret) => {
  if (!secret) return [];
  const { data:emp } = await db().from('employees').select('id').eq('secret',secret).single();
  if (!emp) return [];
  const today = U.toYMD(new Date());
  const { data } = await db().from('late_perms').select('perm_id,date_str,requested_time,status').eq('emp_id',String(emp.id)).gte('date_str',today).order('date_str').limit(5);
  return (data || []).map(r => ({
    permId:        r.perm_id,
    dateStr:       r.date_str,
    requestedTime: r.requested_time,
    status:        r.status,
  }));
};

// ── AVANS ────────────────────────────────────────────────────────

API.requestAvans = async (secret, amount, note) => {
  if (!secret) return { success: false, reason: 'İcazəsiz giriş.' };
  const amt = parseFloat(amount);
  const avansMax = U.getDisciplineConfig().avansMax;
  if (!amt || amt <= 0 || amt > avansMax)
    return { success: false, reason: `Məbləğ 1–${avansMax} AZN aralığında olmalıdır.` };

  const { data: emp } = await db().from('employees').select('id,name,dept').eq('secret', secret).single();
  if (!emp) return { success: false, reason: 'İşçi tapılmadı.' };

  // Eyni gün artıq tələb göndərilib?
  const today = U.toYMD(new Date());
  const { data: existing } = await db().from('avans')
    .select('status').eq('emp_id', String(emp.id)).eq('date_str', today).single();
  if (existing && (existing.status === 'pending' || existing.status === 'approved')) {
    return { success: false, reason: 'Bu gün üçün artıq avans tələbiniz mövcuddur.' };
  }

  const id = U.newId('AV-');
  const { error } = await db().from('avans').insert({
    avans_id:   id,
    emp_id:     String(emp.id),
    emp_name:   emp.name,
    dept:       emp.dept,
    amount:     amt,
    note:       (note || '').slice(0, 120),
    status:     'pending',
    date_str:   today,
  });
  if (error) { sbErr('requestAvans', error); return { success: false, reason: 'Xəta baş verdi.' }; }

  // Telegram YOX — manager-ə push bildiriş
  const pAv = U.fillPush('avansRequest', { ad: emp.name, mebleg: amt, qeyd: note ? ` — ${note}` : '' });
  if (pAv) await sendPushToManager(
    emp.dept,
    pAv.title,
    pAv.body,
    { tag: 'avans-req-' + id, url: '/manager?key=' + (await U.getBranchScheduleKeys())[emp.dept] }
  );
  return { success: true };
};

API.getMyAvansList = async (secret) => {
  if (!secret) return [];
  const { data: emp } = await db().from('employees').select('id').eq('secret', secret).single();
  if (!emp) return [];
  const { data } = await db().from('avans')
    .select('avans_id,amount,note,status,date_str,created_at')
    .eq('emp_id', String(emp.id))
    .order('created_at', { ascending: false })
    .limit(10);
  return (data || []).map(r => ({
    avansId:   r.avans_id,
    amount:    r.amount,
    note:      r.note      || '',
    status:    r.status,
    dateStr:   r.date_str,
    createdAt: r.created_at || '',
  }));
};

// Admin üçün: bütün avans tələblərini al
API.getAvansList = async () => {
  const { data } = await db().from('avans')
    .select('*').order('created_at', { ascending: false }).limit(100);
  return (data || []).map(r => ({
    avansId:   r.avans_id,
    empId:     r.emp_id,
    empName:   r.emp_name,
    dept:      r.dept,
    amount:    r.amount,
    note:      r.note      || '',
    status:    r.status,
    dateStr:   r.date_str,
    createdAt: r.created_at || '',
  }));
};

// Admin: menecerlərin təsdiqlədiyi gec gəliş icazələri + avanslar, filial üzrə
// Ay aralığı: (2026, 7) → { start:'2026-07-01', end:'2026-08-01' }. Ay verilməyibsə null.
// `U.ayPencere`-nin uzerine nazik ortuk: burada HEM TEXT, HEM TIMESTAMPTZ
// sutunlar suzulur, ona gore hər iki forma lazımdır (izahı: utils.ayPencere).
function ayAraligi(year, month) {
  return U.ayPencere(year, month);
}

// year/month verilməsə HAMISI qaytarılır (köhnə davranış — icraçı paneli belə çağırır)
API.getApprovedByBranch = async (year, month) => {
  const ay = ayAraligi(year, month);
  let permQ = db().from('late_perms').select('*').eq('status', 'approved');
  let avansQ = db().from('avans').select('*').in('status', ['approved', 'paid']);
  if (ay) {
    permQ  = permQ.gte('date_str', ay.startYmd).lt('date_str', ay.endYmd);
    avansQ = avansQ.gte('date_str', ay.startYmd).lt('date_str', ay.endYmd);
  }
  const [{ data: emps }, { data: perms }, { data: avans }] = await Promise.all([
    db().from('employees').select('id,dept'),
    permQ.order('date_str', { ascending: false }).limit(1000),
    avansQ.order('created_at', { ascending: false }).limit(1000),
  ]);
  const empDept = {};
  for (const e of emps || []) empDept[String(e.id)] = e.dept;
  const result = {};
  for (const d of U.DEPTS) result[d] = { latePerms: [], avans: [] };
  const bucket = (rowDept, empId) => {
    let dept = rowDept;
    if (!result[dept]) dept = empDept[String(empId)] || rowDept || 'Digər';
    if (!result[dept]) result[dept] = { latePerms: [], avans: [] };
    return result[dept];
  };
  for (const p of perms || []) {
    bucket(p.dept, p.emp_id).latePerms.push({
      permId: p.perm_id, empName: p.emp_name, dateStr: p.date_str,
      requestedTime: p.requested_time, approvedAt: p.approved_at || '',
    });
  }
  for (const a of avans || []) {
    bucket(a.dept, a.emp_id).avans.push({
      avansId: a.avans_id, empName: a.emp_name, amount: a.amount,
      note: a.note || '', status: a.status, dateStr: a.date_str, createdAt: a.created_at || '',
    });
  }
  return result;
};

// Admin/İcraçı: menecer cərimələri filial üzrə (bütün statuslar, pending önə)
// year/month verilməsə HAMISI qaytarılır (köhnə davranış — icraçı paneli belə çağırır)
API.getMgrFinesForAdmin = async (year, month) => {
  const ay = ayAraligi(year, month);
  let mgrQ = db().from('mgr_fines').select('*');
  let sysQ = db().from('fines').select('*');
  if (ay) {
    // `created_at` TIMESTAMPTZ → ISO sərhəd; `date_str` TEXT → YMD sətri (F-07)
    mgrQ = mgrQ.gte('created_at', ay.startIso).lt('created_at', ay.endIso);   // menecer cəriməsində tarix = yazılma vaxtı
    sysQ = sysQ.gte('date_str', ay.startYmd).lt('date_str', ay.endYmd);       // sistem cəriməsində gecikmə günü
  }
  const [{ data: emps }, { data: mfines }, { data: sfines }] = await Promise.all([
    db().from('employees').select('id,dept'),
    mgrQ.order('created_at', { ascending: false }).limit(1000),
    sysQ.order('created_at', { ascending: false }).limit(1000),
  ]);
  const empDept = {};
  for (const e of emps || []) empDept[String(e.id)] = e.dept;
  const result = {};
  for (const d of U.DEPTS) result[d] = [];
  const place = (item, rowDept, empId) => {
    let dept = rowDept;
    if (!result[dept]) dept = empDept[String(empId)] || rowDept || 'Digər';
    if (!result[dept]) result[dept] = [];
    result[dept].push(item);
  };
  for (const f of mfines || []) {
    place({
      fineId: f.fine_id, empName: f.emp_name, amount: f.amount, reason: f.reason || '',
      status: f.status, createdBy: f.created_by || 'Menecer', createdAt: f.created_at || '',
      ackedAt: f.acked_at || '', source: 'manager', ...novMelumat(f),
    }, f.dept, f.emp_id);
  }
  for (const f of sfines || []) {
    place(normSystemFine(f), f.dept, f.emp_id);
  }
  for (const d of Object.keys(result)) {
    result[d].sort((a, b) =>
      (fineIsOpen(b) ? 1 : 0) - (fineIsOpen(a) ? 1 : 0) || (b.createdAt || '').localeCompare(a.createdAt || ''));
  }
  return result;
};

// Admin üçün: avans statusunu dəyişdir
// F-14: ƏVVƏL imza `(avansId, status)` idi və auth səviyyəsi `'staff'`.
// Yəni İSTƏNİLƏN panel açarı — trainer, ops, icraçı, BAŞQA filialın meneceri —
// istənilən avansı təsdiqləyə və «Ödənildi» işarələyə bilirdi. Bu, puldur.
// İndi filial açarı tələb olunur və sətir həmin filialın olmalıdır
// (`getAvansForManager` onsuz da yalnız o sətirləri göstərirdi).
API.updateAvansStatus = async (branchKey, avansId, status) => {
  // Köhnə (keşdə qalmış) panel `(avansId, status)` göndərir → `status` boş qalır.
  // Səssiz uğursuzluq əvəzinə nə etmək lazım olduğunu deyirik.
  if (status === undefined && ['approved', 'rejected', 'paid'].includes(avansId)) {
    return { success: false, reason: 'Panelin köhnə versiyası. Səhifəni yeniləyin (Ctrl+F5).' };
  }
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return { success: false, reason: 'İcazəsiz.' };
  if (!['approved', 'rejected', 'paid'].includes(status))
    return { success: false, reason: 'Yanlış status.' };
  const { data: av } = await db().from('avans').select('emp_id,emp_name,amount,dept').eq('avans_id', avansId).single();
  if (!av) return { success: false, reason: 'Avans tapılmadı.' };
  if (!await rowInBranch(av.dept, av.emp_id, check.dept)) {
    return { success: false, reason: 'Bu avans sizin filialınıza aid deyil.' };
  }
  // Qərar günü: maaş hesabatı tutulmanı TƏLƏB ayına yox, TƏSDİQ/ÖDƏNİŞ ayına yazsın deyə.
  // (Rədd edilən avans tutulmur — ona qərar günü lazım deyil.)
  const patch = { status };
  if (status === 'approved' || status === 'paid') patch.decided_ymd = U.toYMD(new Date());
  let { error } = await db().from('avans').update(patch).eq('avans_id', avansId);
  // Sütun hələ yaradılmayıbsa (avans-decided-migration.sql işlədilməyib) köhnə davranışa qayıt
  if (error && /decided_ymd/i.test(error.message || '')) {
    ({ error } = await db().from('avans').update({ status }).eq('avans_id', avansId));
  }
  if (!error && av) {
    const map = {
      approved: { emoji: '✅', az: 'təsdiqləndi' },
      rejected: { emoji: '❌', az: 'rədd edildi'  },
      paid:     { emoji: '💵', az: 'ödənildi'     },
    };
    const { emoji, az } = map[status] || { emoji: '🔄', az: 'yeniləndi' };
    const p = U.fillPush('avansDecision', { emoji, mebleg: av.amount, status: az });
    if (p) await sendPushToEmployee(
      av.emp_id,
      p.title,
      p.body,
      { tag: 'avans-' + avansId }
    );
  }
  return { success: !error };
};

// ── MENECER CƏRİMƏSİ (manual — işçi elektron imza ilə təsdiqləyir) ───

// ══════════════════════════════════════════════════════════════════
//  AYLIQ CƏRİMƏ TUTUMU (AR ƏM 175 → 20%)
// ══════════════════════════════════════════════════════════════════
//  İKİ QAT MÜDAFİƏ, hər birinin öz bazası var — bu fərq qəsdəndir:
//
//  1) YAZMA ANINDA (bu funksiya) — baza CƏDVƏLƏ görə proqnozlaşdırılan
//     ay sonu brütüdür. Səbəb: ayın 3-ü faktiki brüt kiçikdir, faktiki
//     bazadan istifadə etsək menecer ayın əvvəlində nahaq bloklanardı.
//
//  2) HESABATDA (`getSalaryReport`) — baza FAKTİKİ qazancdır. İşçi ayın
//     qalanına gəlməsə tavan avtomatik daralır və artıq tutulmur.
//
//  Yəni yazma anındakı yoxlama səxavətlidir, real qoruma hesabatdadır.
async function fineCapacity(empId, dept, when) {
  const ts   = when || new Date();
  const disc = U.getDisciplineConfig();
  const cfg  = U.getSalaryConfig();
  // TEXT sütunlar → YMD, TIMESTAMPTZ → ISO (izahı: U.ayPencere). Tavan hesabı
  // maaş hesabatı ilə EYNİ pəncərədən istifadə etməlidir, yoxsa menecer paneldə
  // görünən «qalan tutum» hesabatdakı rəqəmlə uyğun gəlməzdi.
  const ay = U.ayPencere(ts.getFullYear(), ts.getMonth() + 1);

  const [{ data: emp }, { data: ced }, { data: sysF }, { data: mgrF }] = await Promise.all([
    db().from('employees').select('id,name,dept,position').eq('id', String(empId)).single(),
    db().from('cedvel').select('date_str,shift_type').eq('emp_id', String(empId))
      .gte('date_str', ay.startYmd).lt('date_str', ay.endYmd),
    db().from('fines').select('amount,status,kind').eq('emp_id', String(empId))
      .gte('date_str', ay.startYmd).lt('date_str', ay.endYmd),
    db().from('mgr_fines').select('amount,status,kind').eq('emp_id', String(empId))
      .gte('created_at', ay.startIso).lt('created_at', ay.endIso),
  ]);
  if (!emp) return null;

  // Ay sonu proqnoz brütü — cədvəldəki iş günlərinin cəmi
  let brut = 0;
  for (const c of ced || []) {
    const st = c.shift_type || '';
    if (!st || st === 'istirahetsm') continue;
    brut += U.computeDayPay(emp.position, emp.dept || dept, st, cfg).pay;
  }
  brut = U.round2(brut);

  // Artıq yazılmış cərimələr. İMZASIZLAR DA SAYILIR — onlar imzalanacaq,
  // saymasaq menecer imzasız cərimə yığıb tavanı keçə bilərdi.
  // Bağışlananlar (waived) və tənbehlər (məbləğ 0) sayılmır.
  let yazilan = 0;
  for (const f of sysF || []) {
    if (U.isTohmet(f.kind || 'fine')) continue;
    if (f.status === 'waived') continue;
    yazilan += Number(f.amount) || 0;
  }
  for (const f of mgrF || []) {
    if (U.isTohmet(f.kind || 'fine')) continue;
    yazilan += Number(f.amount) || 0;
  }
  yazilan = U.round2(yazilan);

  const pct   = disc.finePercentCap;
  const limit = (pct && brut > 0) ? U.round2(brut * pct / 100) : null;
  const qalan = limit === null ? null : U.round2(Math.max(0, limit - yazilan));

  return {
    empId: String(emp.id), empName: emp.name, brut, yazilan, limit, qalan,
    faiz: pct,
    // Tavan dolubsa menecer YALNIZ tənbeh yaza bilər
    doludur: limit !== null && qalan <= 0,
    // Brüt hesablana bilmirsə (cədvəl yoxdur) tavan tətbiq edilmir — bloklamırıq
    brutYoxdur: !(brut > 0),
  };
};

// Menecer paneli cərimə formasında bunu göstərir
API.getFineCapacity = async (branchKey, empId) => {
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return { success: false, reason: 'İcazəsiz.' };
  if (!empId) return { success: false, reason: 'İşçi seçilməyib.' };
  const { data: emp } = await db().from('employees').select('id,dept').eq('id', String(empId)).single();
  if (!emp) return { success: false, reason: 'İşçi tapılmadı.' };
  if (emp.dept !== check.dept) return { success: false, reason: 'Bu işçi sizin filialınıza aid deyil.' };
  const cap = await fineCapacity(empId, check.dept);
  if (!cap) return { success: false, reason: 'Hesablana bilmədi.' };
  return { success: true, ...cap, tohmetAdlari: U.TOHMET_NAMES };
};

// `kind`: 'fine' (pul cəriməsi) | 'tohmet' | 'siddetli' | 'sonuncu'
// Tənbehdə məbləğ YOXDUR (amount = 0) — maaşdan heç nə tutulmur.
API.addMgrFine = async (branchKey, empId, amount, reason, kind) => {
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return { success: false, reason: 'İcazəsiz.' };
  if (!empId) return { success: false, reason: 'İşçi seçilməyib.' };
  if (!reason || !reason.trim()) return { success: false, reason: 'Səbəb yazılmalıdır.' };

  const nov    = kind || 'fine';
  const tenbeh = U.isTohmet(nov);
  if (!tenbeh && nov !== 'fine') return { success: false, reason: 'Belə sənəd növü yoxdur.' };

  const disc = U.getDisciplineConfig();
  const amt  = tenbeh ? 0 : parseFloat(amount);
  if (!tenbeh) {
    if (isNaN(amt) || amt <= 0 || amt > disc.mgrFineMax)
      return { success: false, reason: `Məbləğ 1–${disc.mgrFineMax} AZN aralığında olmalıdır.` };
  }

  const { data: emp } = await db().from('employees').select('id,name,dept').eq('id', String(empId)).single();
  if (!emp) return { success: false, reason: 'İşçi tapılmadı.' };
  if (emp.dept !== check.dept) return { success: false, reason: 'Bu işçi sizin filialınıza aid deyil.' };

  // ── QANUNİ TAVAN (ƏM 175) ──
  // Bu ayın cərimələri tavanı doldurubsa menecer artıq PUL cəriməsi yaza
  // bilmir — yalnız intizam tənbehi yaza bilər. Tənbeh həmişə keçir,
  // çünki onda tutulma yoxdur.
  if (!tenbeh) {
    const cap = await fineCapacity(emp.id, check.dept);
    if (cap && cap.limit !== null && !cap.brutYoxdur) {
      if (cap.qalan <= 0) {
        return {
          success: false,
          capReached: true,
          reason: `Bu işçinin bu aylıq cərimə tavanı dolub (${cap.limit} ₼ = maaşın ${cap.faiz}%-i, ` +
                  `artıq ${cap.yazilan} ₼ yazılıb). AR Əmək Məcəlləsinin 175-ci maddəsinə görə ` +
                  `daha çox tutula bilməz — pul cəriməsi əvəzinə töhmət yaza bilərsiniz.`,
          cap,
        };
      }
      if (amt > cap.qalan) {
        return {
          success: false,
          capExceeded: true,
          reason: `Bu məbləğ qanuni tavanı aşır. Bu ay ən çoxu ${cap.qalan} ₼ yazıla bilər ` +
                  `(tavan ${cap.limit} ₼ = maaşın ${cap.faiz}%-i, artıq ${cap.yazilan} ₼ yazılıb). ` +
                  `Məbləği azaldın və ya töhmət yazın.`,
          cap,
        };
      }
    }
  }

  const id = U.newId('MF-');
  const mgrName = mgrNameOf(check.dept) || ('Menecer (' + check.dept + ')');
  const bugun = U.getLogicalYMD(new Date());
  const row = {
    fine_id: id, emp_id: String(emp.id), emp_name: emp.name, dept: check.dept,
    amount: amt, reason: reason.trim().slice(0, 300), status: 'pending', created_by: mgrName,
    kind: nov,
    expires_ymd: tenbeh ? U.tohmetExpiry(bugun, disc) : null,
  };
  let { error } = await db().from('mgr_fines').insert(row);
  // Sütunlar hələ yaradılmayıbsa (tohmet-migration.sql işlədilməyib) qeyd itməsin
  if (error && /kind|expires_ymd/i.test(error.message || '')) {
    const { kind: _k, expires_ymd: _e, ...kohne } = row;
    ({ error } = await db().from('mgr_fines').insert(kohne));
    if (!error && tenbeh) console.warn('[Töhmət] mgr_fines.kind sütunu yoxdur — tohmet-migration.sql işlədilməlidir.');
  }
  if (error) { sbErr('addMgrFine', error); return { success: false, reason: 'Xəta baş verdi.' }; }

  // Bildiriş: tənbehdə məbləğ yerinə növü və müddəti göndərilir
  const pFine = tenbeh
    ? U.fillPush('mgrTohmet', { tenbeh: U.TOHMET_NAMES[nov], ay: disc.tohmetMonths, sebeb: reason.trim().slice(0, 80) })
    : U.fillPush('mgrFine',   { mebleg: amt, sebeb: reason.trim().slice(0, 80) });
  if (pFine) await sendPushToEmployee(
    emp.id, pFine.title, pFine.body,
    { tag: 'mgrfine-' + id, requireInteraction: true }
  );
  return { success: true, fineId: id, kind: nov, kindName: U.TOHMET_NAMES[nov] || 'Cərimə' };
};

API.getMgrFinesForManager = async (branchKey) => {
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return [];
  const { data: empRows } = await db().from('employees').select('id').eq('dept', check.dept);
  const empIds = (empRows || []).map(e => String(e.id));
  const noEmp = Promise.resolve({ data: [] });
  const [{ data: mByDept }, { data: mByEmp }, { data: sByDept }, { data: sByEmp }] = await Promise.all([
    db().from('mgr_fines').select('*').eq('dept', check.dept).order('created_at', { ascending: false }).limit(100),
    empIds.length ? db().from('mgr_fines').select('*').in('emp_id', empIds).order('created_at', { ascending: false }).limit(100) : noEmp,
    db().from('fines').select('*').eq('dept', check.dept).order('created_at', { ascending: false }).limit(100),
    empIds.length ? db().from('fines').select('*').in('emp_id', empIds).order('created_at', { ascending: false }).limit(100) : noEmp,
  ]);
  const seen = new Set();
  const out  = [];
  for (const r of [...(mByDept || []), ...(mByEmp || [])]) {
    if (seen.has('m' + r.fine_id)) continue; seen.add('m' + r.fine_id);
    out.push({
      fineId: r.fine_id, empId: r.emp_id, empName: r.emp_name, amount: r.amount,
      reason: r.reason || '', status: r.status, createdBy: r.created_by || 'Menecer',
      createdAt: r.created_at || '', ackedAt: r.acked_at || '', source: 'manager', ...novMelumat(r),
    });
  }
  for (const r of [...(sByDept || []), ...(sByEmp || [])]) {
    if (seen.has('s' + r.fine_id)) continue; seen.add('s' + r.fine_id);
    out.push(normSystemFine(r));
  }
  return out.sort((a, b) =>
    (fineIsOpen(b) ? 1 : 0) - (fineIsOpen(a) ? 1 : 0) || (b.createdAt || '').localeCompare(a.createdAt || ''));
};

API.getMyFines = async (secret) => {
  if (!secret) return [];
  const { data: emp } = await db().from('employees').select('id').eq('secret', secret).single();
  if (!emp) return [];
  const eid = String(emp.id);
  const [{ data: mf }, { data: sf }] = await Promise.all([
    db().from('mgr_fines').select('*').eq('emp_id', eid).order('created_at', { ascending: false }).limit(20),
    db().from('fines').select('*').eq('emp_id', eid).order('created_at', { ascending: false }).limit(20),
  ]);
  // İntizam tənbehi yalnız QÜVVƏDƏ olduğu müddətdə işçi kartında görünür (ƏM 190.1).
  // Müddəti bitən və ya vaxtından əvvəl götürülən tənbeh siyahıdan düşür —
  // qeyd bazada qalır (audit), sadəcə işçiyə göstərilmir.
  // Hər iki mənbəyə (menecer + sistem) eyni qayda tətbiq olunur.
  const out = [];
  for (const r of mf || []) {
    const n = {
      fineId: r.fine_id, amount: r.amount, reason: r.reason || '', status: r.status,
      createdAt: r.created_at || '', ackedAt: r.acked_at || '', createdBy: r.created_by || 'Menecer',
      source: 'manager', ...novMelumat(r),
    };
    if (n.isTohmet && !n.aktiv) continue;
    out.push(n);
  }
  for (const r of sf || []) {
    const n = normSystemFine(r);
    if (n.isTohmet && !n.aktiv) continue;
    out.push(n);
  }
  return out.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
};

API.acknowledgeFine = async (secret, fineId) => {
  if (!secret || !fineId) return { success: false, reason: 'Məlumat çatışmır.' };
  const { data: emp } = await db().from('employees').select('id,name,dept').eq('secret', secret).single();
  if (!emp) return { success: false, reason: 'İşçi tapılmadı.' };
  const isSystem = String(fineId).indexOf('FN-') === 0;   // sistem cəriməsi
  const table    = isSystem ? 'fines' : 'mgr_fines';
  const { data: fine } = await db().from(table).select('*').eq('fine_id', fineId).single();
  if (!fine) return { success: false, reason: 'Cərimə tapılmadı.' };
  if (String(fine.emp_id) !== String(emp.id)) return { success: false, reason: 'İcazəsiz.' };
  const now = new Date().toISOString();
  if (isSystem) {
    if (fine.acked) return { success: true, already: true };
    const { error } = await db().from('fines').update({ acked: true, acked_at: now }).eq('fine_id', fineId);
    if (error) { sbErr('acknowledgeFine(sys)', error); return { success: false, reason: 'Xəta baş verdi.' }; }
  } else {
    if (fine.status === 'acknowledged') return { success: true, already: true };
    const { error } = await db().from('mgr_fines').update({ status: 'acknowledged', acked_at: now }).eq('fine_id', fineId);
    if (error) { sbErr('acknowledgeFine(mgr)', error); return { success: false, reason: 'Xəta baş verdi.' }; }
  }
  const pAcked = U.fillPush('fineAck', { ad: emp.name, mebleg: fine.amount });
  if (pAcked) await sendPushToManager(emp.dept, pAcked.title, pAcked.body, { tag: 'fine-ack-' + fineId });
  return { success: true };
};

// ── YENİLİKLƏR ───────────────────────────────────────────────────

API.getAnnouncements = async () => {
  const { data } = await db().from('announcements').select('*').order('pinned',{ascending:false}).order('date',{ascending:false});
  return (data||[]).map(r=>({
    id:r.id, title:r.title, body:r.body, type:r.type||'info', pinned:!!r.pinned,
    date: r.date ? r.date.slice(0,10).split('-').reverse().join('.') : '',
  }));
};

API.saveAnnouncement = async (data) => {
  if (data.id) {
    const { error } = await db().from('announcements').update({ title:data.title, body:data.body, type:data.type||'info', pinned:!!data.pinned }).eq('id',data.id);
    if (!error) return { ok:true };
  }
  const annId = U.newId('YN-');
  const { error: insErr } = await db().from('announcements').insert({ id:annId, title:data.title, body:data.body, type:data.type||'info', pinned:!!data.pinned });
  if (insErr) { sbErr('saveAnnouncement.insert', insErr); return { ok:false, error: insErr.message }; }
  // Yeni elan — bütün işçilərə push göndər
  const typeEmoji = { info:'ℹ️', success:'✅', warning:'⚠️', new:'🆕' };
  const emoji = typeEmoji[data.type] || '📢';
  const pAnn = U.fillPush('announce', { emoji, basliq: data.title || 'Yeni Elan', metn: data.body ? data.body.slice(0, 100) : '' })
             || { title: '', body: '' };
  const pushRes = await sendPushToAll(
    pAnn.title,
    pAnn.body,
    { tag: 'announce-' + annId }
  );
  console.log(`[Announce] yeni elan "${data.title}" əlavə olundu — push ${pushRes.sent}/${pushRes.total}`);
  return { ok:true, id:annId, pushSent: pushRes.sent, pushTotal: pushRes.total };
};

// ── PROFİL ────────────────────────────────────────────────────────

API.getMyProfile = async (secret) => {
  if (!secret) return null;
  const { data: emp } = await db().from('employees').select('id,name,dept,is_test,streak,xp').eq('secret', secret).single();
  if (!emp) return null;
  const isTest = emp.is_test === true;
  const { data: p } = await db().from('profiles').select('*').eq('emp_id', emp.id).single();
  return {
    empId: emp.id, empName: emp.name, dept: emp.dept,
    testMode:    isTest,
    streak:      isTest ? 999 : (emp.streak || 0),
    xp:          isTest ? 999999 : (emp.xp || 0),
    avatarType:  p?.avatar_type  || 'preset',
    avatarValue: p?.avatar_value || 'mug-hot',
    accentColor: p?.accent_color || '#5b5ef4',
    bio:         p?.bio          || '',
    photoData:   p?.photo_data   || '',
    //  Sahibinin öz profili — minik də gəlir. Yoxdursa panel onu səssizcə
    //  yaradıb saxlayır (F-21 geriyə doldurma: mövcud şəkillərin miniyi
    //  bir dəfə, sahibi kartını açanda yaranır).
    photoThumb:  p?.photo_thumb  || '',
    bannerStyle: p?.banner_style || 'none',
    cardTheme:   p?.card_theme   || 'glass',
    glowEffect:  p?.glow_effect  || 'none',
    frameStyle:  p?.frame_style  || 'none',
  };
};

API.saveProfile = async (secret, data) => {
  if (!secret) return { success: false };
  const { data: emp } = await db().from('employees').select('id').eq('secret', secret).single();
  if (!emp) return { success: false };
  const d = data || {};

  // F-09: şəkil YOXLANILIR. Rədd səbəbi işçiyə deyilir — səssizcə boşaltmaq
  // daha pisdir, çünki işçi şəklin saxlanıldığını zənn edərdi.
  const photoErr = U.photoDataError(d.photoData);
  if (photoErr) return { success: false, reason: photoErr };
  const isPhoto = d.avatarType === 'photo';

  const row = {
    emp_id:       emp.id,
    avatar_type:  isPhoto ? 'photo' : 'preset',
    avatar_value: U.cleanStyleId(d.avatarValue, 'mug-hot'),
    accent_color: U.cleanHexColor(d.accentColor, '#5b5ef4'),
    bio:          String(d.bio || '').slice(0, 80),
    // Şəkil yalnız `avatarType === 'photo'` olanda saxlanılır — preset seçildikdə
    // köhnə base64 cədvəldə qalmasın (o, hər `getTeamProfiles` çağırışında daşınır).
    photo_data:   isPhoto ? String(d.photoData || '') : '',
    //  F-21: komanda siyahısı TAM şəkli daşımasın deyə panel 48px minik də
    //  göndərir. Miniyi olmayan profil siyahıda tam şəklə geri düşür —
    //  yəni bu sahə boş qalsa da heç nə sınmır.
    photo_thumb:  isPhoto ? U.cleanThumb(d.photoThumb) : '',
    banner_style: U.cleanStyleId(d.bannerStyle, 'none'),
    card_theme:   U.cleanStyleId(d.cardTheme,   'glass'),
    glow_effect:  U.cleanStyleId(d.glowEffect,  'none'),
    frame_style:  U.cleanStyleId(d.frameStyle,  'none'),
    updated_at:   new Date().toISOString(),
  };

  let { error } = await db().from('profiles').upsert(row, { onConflict: 'emp_id' });
  //  Sütun hələ yaradılmayıbsa (profile-thumb-migration.sql işlədilməyib)
  //  profil saxlamaq DAYANMAMALIDIR — miniksiz təkrarlayırıq.
  if (error && /photo_thumb/i.test(error.message || '')) {
    const { photo_thumb: _t, ...miniksiz } = row;
    ({ error } = await db().from('profiles').upsert(miniksiz, { onConflict: 'emp_id' }));
  }
  sbErr('saveProfile', error);
  return { success: !error };
};

API.getTeamProfiles = async (secret) => {
  if (!secret) return [];
  const { data: caller } = await db().from('employees').select('id').eq('secret', secret).single();
  if (!caller) return [];
  const { data: emps } = await db().from('employees').select('id,name,dept,is_test,streak,xp').order('name');
  const { data: profiles } = await db().from('profiles').select('*');
  const pm = {};
  for (const p of profiles || []) pm[p.emp_id] = p;
  const result = (emps || []).filter(e => !e.is_test).map(e => ({
    empId:       e.id,
    empName:     e.name,
    dept:        e.dept,
    streak:      e.streak || 0,
    xp:          e.xp || 0,
    avatarType:  pm[e.id]?.avatar_type  || 'preset',
    avatarValue: pm[e.id]?.avatar_value || 'mug-hot',
    accentColor: pm[e.id]?.accent_color || '#5b5ef4',
    bio:         pm[e.id]?.bio          || '',
    //  F-21: siyahıda MİNİK gedir, tam şəkil YOX. 19 işçidə cavab 105 KB idi —
    //  hər profil tabı açılışında. Minik ~1-2 KB.
    //  ⚠️ Geri uyğunluq: miniyi olmayan köhnə profil üçün tam şəkil qalır.
    //  Belədə nə deploy ilə SQL arasındakı aralıqda, nə də köhnə profillərdə
    //  üzlər itmir; minik yarandıqca cavab öz-özünə kiçilir.
    photoData:   pm[e.id]?.photo_thumb  || pm[e.id]?.photo_data || '',
    //  Sahibinə «miniyin yoxdur» demək üçün (panel onu səssizcə yaradır)
    thumbMissing: !!(pm[e.id]?.photo_data) && !(pm[e.id]?.photo_thumb),
    bannerStyle: pm[e.id]?.banner_style || 'none',
    cardTheme:   pm[e.id]?.card_theme   || 'glass',
    glowEffect:  pm[e.id]?.glow_effect  || 'none',
    frameStyle:  pm[e.id]?.frame_style  || 'none',
  }));
  return result;
};

// ── STREAK BACKFILL ───────────────────────────────────────────────
// (API.recalcAllStreaks yuxarıda — İŞÇİLƏR bölməsində — bir dəfə təyin olunub.)

// ── REAKSİYALAR ──────────────────────────────────────────────────

API.getReactions = async (secret) => {
  const { data: caller } = await db().from('employees').select('id').eq('secret', secret).single();
  if (!caller) return {};
  const { data: rows } = await db().from('reactions').select('*');
  const result = {};
  for (const r of rows || []) {
    if (!result[r.to_emp_id]) result[r.to_emp_id] = { like:0, love:0, fire:0, angry:0, mine:null };
    result[r.to_emp_id][r.type] = (result[r.to_emp_id][r.type] || 0) + 1;
    if (r.from_emp_id === caller.id) result[r.to_emp_id].mine = r.type;
  }
  return result;
};

API.toggleReaction = async (secret, toEmpId, type) => {
  const VALID = ['like'];
  if (!VALID.includes(type)) return { ok: false };
  const { data: caller } = await db().from('employees').select('id').eq('secret', secret).single();
  if (!caller || caller.id === toEmpId) return { ok: false };
  const { data: existing } = await db().from('reactions')
    .select('*').eq('from_emp_id', caller.id).eq('to_emp_id', toEmpId).single();
  if (existing) {
    if (existing.type === type) {
      await db().from('reactions').delete().eq('from_emp_id', caller.id).eq('to_emp_id', toEmpId);
    } else {
      await db().from('reactions').update({ type }).eq('from_emp_id', caller.id).eq('to_emp_id', toEmpId);
    }
  } else {
    await db().from('reactions').insert({ from_emp_id: caller.id, to_emp_id: toEmpId, type });
  }
  return { ok: true };
};

API.getPublicProfile = async (secret, targetEmpId) => {
  if (!secret || !targetEmpId) return null;
  const { data: caller } = await db().from('employees').select('id').eq('secret', secret).single();
  if (!caller) return null;
  const { data: emp } = await db().from('employees').select('id,name,dept,is_test,streak,xp').eq('id', targetEmpId).single();
  if (!emp || emp.is_test) return null;   // test/demo hesabı liderlik/aurada göstərilmir
  const { data: p } = await db().from('profiles').select('*').eq('emp_id', emp.id).single();
  const streak = emp.streak || 0;
  const now = new Date();
  const report = await API.getMonthlyReport(now.getFullYear(), now.getMonth() + 1);
  const myR = report.find(r => r.empId === emp.id) || { totalDays: 0, onTime: 0, late: 0, pct: 0 };
  return {
    empId: emp.id, empName: emp.name, dept: emp.dept, streak,
    xp:          emp.xp || 0,
    avatarType:  p?.avatar_type  || 'preset',
    avatarValue: p?.avatar_value || 'mug-hot',
    accentColor: p?.accent_color || '#5b5ef4',
    bio:         p?.bio          || '',
    photoData:   p?.photo_data   || '',
    bannerStyle: p?.banner_style || 'none',
    cardTheme:   p?.card_theme   || 'glass',
    glowEffect:  p?.glow_effect  || 'none',
    frameStyle:  p?.frame_style  || 'none',
    stats: { days: myR.totalDays, onTime: myR.onTime, late: myR.late, pct: myR.pct },
  };
};

// ── TƏCİLİ BİLDİRİŞ ─────────────────────────────────────────────

API.sendEmergency = async (secret, message) => {
  if (!secret || !message?.trim()) return { success: false, reason: 'Məlumatlar natamamdır.' };
  const { data: emp } = await db().from('employees').select('id,name,dept').eq('secret', secret).single();
  if (!emp) return { success: false, reason: 'İşçi tapılmadı.' };
  await U.sendTgTemplate('emergency',
    { ad: emp.name, filial: emp.dept, mesaj: message.trim() }, emp.dept);
  return { success: true };
};

API.deleteAnnouncement = async (id) => {
  const { error } = await db().from('announcements').delete().eq('id',id);
  return { ok:!error };
};

// ── MENECER DASHBOARD ─────────────────────────────────────────────

API.getAvansForManager = async (branchKey) => {
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return [];

  const { data: empRows } = await db().from('employees').select('id').eq('dept', check.dept);
  const empIds = (empRows || []).map(e => String(e.id));

  const [{ data: byDept }, { data: byEmpId }] = await Promise.all([
    db().from('avans').select('*').eq('dept', check.dept)
      .order('created_at', { ascending: false }).limit(50),
    empIds.length
      ? db().from('avans').select('*').in('emp_id', empIds)
          .order('created_at', { ascending: false }).limit(50)
      : Promise.resolve({ data: [] }),
  ]);

  const seen = new Set();
  const merged = [...(byDept || []), ...(byEmpId || [])].filter(r => {
    if (seen.has(r.avans_id)) return false;
    seen.add(r.avans_id);
    return true;
  });

  return merged.map(r => ({
    avansId:   r.avans_id,
    empName:   r.emp_name,
    dept:      r.dept,
    amount:    r.amount,
    note:      r.note      || '',
    status:    r.status,
    dateStr:   r.date_str,
    createdAt: r.created_at || '',
  })).sort((a, b) => {
    if (a.status === 'pending' && b.status !== 'pending') return -1;
    if (a.status !== 'pending' && b.status === 'pending') return  1;
    return b.createdAt.localeCompare(a.createdAt);
  });
};

API.getManagerDashboard = async (branchKey, weekStart) => {
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return null;
  const safe = (p) => p.catch(() => null);
  const [cedvel, mgrInfo, ackStatus, mgrSched, latePerms, avansList] = await Promise.all([
    safe(API.getCedvel(check.dept, weekStart)),
    Promise.resolve(API.getMgrInfoForBranch(branchKey)),
    safe(API.getMgrAckStatus(branchKey)),
    safe(API.getMgrWeekSchedule(branchKey, weekStart)),
    safe(API.getLatePermsForManager(branchKey)),
    safe(API.getAvansForManager(branchKey)),
  ]);
  return {
    cedvel:    cedvel    || [],
    mgrInfo:   mgrInfo   || null,
    ackStatus: ackStatus || null,
    mgrSched:  mgrSched  || null,
    latePerms: latePerms || [],
    avansList: avansList || [],
  };
};

// ══════════════════════════════════════════════════════════════════
//  TREYNİNQ MANECERİ API
// ══════════════════════════════════════════════════════════════════

//  Açarlar `auth_keys` cədvəlindədir. `ensureKey` yoxdursa yaradır, varsa
//  mövcudu qaytarır; `issueKey` köhnəni ləğv edib yenisini verir.
API.getTrainerKey = async () => ({
  key:  await T.ensureKey(T.tenantId(), 'trainer', null, 'Treninq meneceri'),
  name: U.getSetting('TRAINER_NAME') || '',
});

API.regenerateTrainerKey = async () => ({
  key: await T.issueKey(T.tenantId(), 'trainer', null, 'Treninq meneceri'),
});

API.setTrainerName = async (name) => {
  await U.setSetting('TRAINER_NAME', String(name || '').trim());
  return { success: true };
};

// ── İCRAÇI (executive) PANELİ AÇARI ──────────────────────────────
API.getExecKey = async () => ({
  key:  await T.ensureKey(T.tenantId(), 'exec', null, 'İcraçı'),
  name: U.getSetting('EXEC_NAME') || '',
});

API.regenerateExecKey = async () => ({
  key: await T.issueKey(T.tenantId(), 'exec', null, 'İcraçı'),
});

API.setExecName = async (name) => {
  await U.setSetting('EXEC_NAME', String(name || '').trim());
  return { success: true };
};

// ══════════════════════════════════════════════════════════════════
//  ƏMƏLİYYAT MENECERİ (OPS) PANELİ
// ══════════════════════════════════════════════════════════════════

function opsAuth(key) {
  const k = roleKey('ops');
  return !!k && k === key;
}

// Saha yoxlaması həm əməliyyat meneceri, həm İCRAÇI tərəfindən aparıla bilər.
// Qeydlər eyni cədvəllərə (ops_visits/ratings/emp_notes/issues) yazılır — iclas görünüşü dəyişmir.
// Yalnız yoxlama ilə bağlı funksiyalarda işlədilir; iclas/təqdimat/problem idarəsi ops-a məxsus qalır.
function opsFieldAuth(key) {
  if (!key) return { ok: false };
  const opsKey = roleKey('ops');
  if (opsKey && opsKey === key) {
    return { ok: true, role: 'ops', name: U.getSetting('OPS_NAME') || 'Əməliyyat meneceri' };
  }
  const execKey = roleKey('exec');
  if (execKey && execKey === key) {
    return { ok: true, role: 'exec', name: U.getSetting('EXEC_NAME') || 'İcraçı' };
  }
  return { ok: false };
}

// ops_visits.ops_name-də yoxlamanı KİMİN apardığı görünsün (iki müfəttiş var).
function opsInspectorLabel(auth) {
  return auth.role === 'exec' ? `${auth.name} (İcraçı)` : auth.name;
}
function opsId(prefix, i) {
  return U.newId(prefix, i || 0);
}
function opsSev(s) { return (s === 'asagi' || s === 'orta' || s === 'kritik') ? s : 'orta'; }
function opsWeekDates(weekStart) {
  const start = new Date(weekStart);
  const out = [];
  for (let d = 0; d < 7; d++) out.push(U.toYMD(new Date(start.getTime() + d * 86400000)));
  return out;
}

const OPS_DEFAULT_CATS = [
  { name: 'Təmizlik / gigiyena', icon: 'fa-spray-can-sparkles' },
  { name: 'Personal', icon: 'fa-users' },
  { name: 'Məhsul / qəhvə keyfiyyəti', icon: 'fa-mug-hot' },
  { name: 'Xidmət', icon: 'fa-face-smile' },
  { name: 'Avadanlıq', icon: 'fa-screwdriver-wrench' },
  { name: 'Stok / itki', icon: 'fa-boxes-stacked' },
  { name: 'Kassa / əməliyyat', icon: 'fa-cash-register' },
  { name: 'Müştəri rəyi', icon: 'fa-star' },
];
function opsCategories() {
  const raw = U.getSetting('OPS_CATEGORIES');
  if (!raw) return OPS_DEFAULT_CATS;
  try { const arr = JSON.parse(raw); return (Array.isArray(arr) && arr.length) ? arr : OPS_DEFAULT_CATS; }
  catch (e) { return OPS_DEFAULT_CATS; }
}

API.getOpsKey = async () => ({
  key:  await T.ensureKey(T.tenantId(), 'ops', null, 'Əməliyyat meneceri'),
  name: U.getSetting('OPS_NAME') || '',
});
API.regenerateOpsKey = async () => ({
  key: await T.issueKey(T.tenantId(), 'ops', null, 'Əməliyyat meneceri'),
});
API.setOpsName = async (name) => {
  await U.setSetting('OPS_NAME', String(name || '').trim());
  return { success: true };
};

// Saha rejimi üçün ilkin data — filiallar + filial üzrə işçilər
API.getOpsBootstrap = async (key) => {
  const auth = opsFieldAuth(key);           // ops VƏ YA icraçı
  if (!auth.ok) return null;
  const { data: emps } = await db().from('employees').select('id,name,dept,is_test').order('name');
  const byDept = {};
  for (const d of U.DEPTS) byDept[d] = [];
  for (const e of (emps || [])) {
    if (e.is_test) continue;
    if (byDept[e.dept]) byDept[e.dept].push({ id: e.id, name: e.name });
  }
  return {
    depts: U.DEPTS, employees: byDept,
    opsName: auth.name,                     // çağıranın öz adı (icraçıda icraçının adı)
    role: auth.role,                        // 'ops' | 'exec' — panel buna görə fərqlənə bilər
    categories: opsCategories(),
  };
};

// Kateqoriyalar — dəyişdirilə bilən (stabil deyil). Oxumaq icraçıya da lazımdır (yoxlama formasını qurur).
API.getOpsCategories = async (key) => {
  if (!opsFieldAuth(key).ok) return null;
  return opsCategories();
};
API.saveOpsCategories = async (key, list) => {
  if (!opsAuth(key)) return { success: false, reason: 'İcazəsiz.' };
  if (!Array.isArray(list)) return { success: false, reason: 'Yanlış format.' };
  const clean = list
    .map(c => ({ name: String((c && c.name) || '').trim().slice(0, 60), icon: String((c && c.icon) || 'fa-clipboard-check').trim().slice(0, 40) }))
    .filter(c => c.name);
  if (!clean.length) return { success: false, reason: 'Ən azı bir kateqoriya lazımdır.' };
  await U.setSetting('OPS_CATEGORIES', JSON.stringify(clean));
  return { success: true, categories: clean };
};

// Ziyarəti saxla: visit + ratings + işçi qeydləri + işarələnmiş problemlər (hamısı bir əməliyyatda)
API.saveOpsVisit = async (key, payload) => {
  const auth = opsFieldAuth(key);           // ops VƏ YA icraçı
  if (!auth.ok) return { success: false, reason: 'İcazəsiz.' };
  const p = payload || {};
  if (!p.dept || !U.DEPTS.includes(p.dept)) return { success: false, reason: 'Filial seçilməyib.' };

  const visitId = opsId('V', 0);
  const dateStr = U.getLogicalYMD(new Date());
  const opsName = opsInspectorLabel(auth);  // kim yoxladı — iclas görünüşündə görünür

  const ratings = Array.isArray(p.ratings) ? p.ratings.filter(r => r.category) : [];
  const scored  = ratings.filter(r => Number(r.score) > 0);
  const overall = scored.length
    ? Math.round((scored.reduce((s, r) => s + Number(r.score), 0) / scored.length) * 10) / 10 : 0;

  const { error: vErr } = await db().from('ops_visits').insert({
    visit_id: visitId, dept: p.dept, ops_name: opsName,
    visit_date: dateStr, overall_score: overall, summary: String(p.summary || ''), status: 'done',
  });
  if (vErr) return { success: false, reason: 'Ziyarət xətası: ' + vErr.message };

  if (ratings.length) {
    const rows = ratings.map((r, i) => ({
      rating_id: opsId('R', i), visit_id: visitId, category: String(r.category),
      score: Number(r.score) || 0, note: String(r.note || ''), photo_url: String(r.photoUrl || ''),
    }));
    const { error } = await db().from('ops_ratings').insert(rows);
    if (error) return { success: false, reason: 'Qiymət xətası: ' + error.message };
  }

  const notes = Array.isArray(p.empNotes) ? p.empNotes.filter(n => n.empId) : [];
  const noteRows = notes.filter(n => !n.isProblem).map((n, i) => ({
    note_id: opsId('EN', i), visit_id: visitId, dept: p.dept,
    emp_id: String(n.empId), emp_name: String(n.empName || ''),
    sentiment: (n.sentiment === 'pos' || n.sentiment === 'neg') ? n.sentiment : 'neutral',
    note: String(n.note || ''), photo_url: String(n.photoUrl || ''),
  }));
  if (noteRows.length) {
    const { error } = await db().from('ops_emp_notes').insert(noteRows);
    if (error) return { success: false, reason: 'Qeyd xətası: ' + error.message };
  }

  // Problemlər → ops_issues (kateqoriya problemləri + işçi problemləri birlikdə)
  const issues = [];
  (Array.isArray(p.issues) ? p.issues : []).forEach(iss => {
    if (!iss.title) return;
    issues.push({
      dept: p.dept, emp_id: String(iss.empId || ''), emp_name: String(iss.empName || ''),
      title: String(iss.title), detail: String(iss.detail || ''),
      severity: opsSev(iss.severity), photo_url: String(iss.photoUrl || ''),
    });
  });
  notes.filter(n => n.isProblem).forEach(n => {
    issues.push({
      dept: p.dept, emp_id: String(n.empId), emp_name: String(n.empName || ''),
      title: (n.note ? String(n.note).slice(0, 80) : 'İşçi problemi'),
      detail: String(n.note || ''), severity: opsSev(n.severity), photo_url: String(n.photoUrl || ''),
    });
  });
  if (issues.length) {
    const issueRows = issues.map((x, i) => ({
      issue_id: opsId('I', i), dept: x.dept, emp_id: x.emp_id, emp_name: x.emp_name,
      title: x.title, detail: x.detail, severity: x.severity, status: 'open',
      assigned_to: '', due_date: '', source_visit_id: visitId, photo_url: x.photo_url,
    }));
    const { error } = await db().from('ops_issues').insert(issueRows);
    if (error) return { success: false, reason: 'Problem xətası: ' + error.message };
  }

  return { success: true, visitId, overall };
};

// İclas — həftə üzrə filial scorecard-ları (ops balı + açıq problem sayı)
API.getOpsMeetingData = async (key, weekStart) => {
  if (!opsAuth(key)) return null;
  const dstr = opsWeekDates(weekStart);
  const { data: visits } = await db().from('ops_visits').select('dept,overall_score,visit_date').in('visit_date', dstr);
  const agg = {};
  for (const dep of U.DEPTS) agg[dep] = { visits: 0, scoreSum: 0 };
  for (const v of (visits || [])) {
    if (!agg[v.dept]) continue;
    agg[v.dept].visits++; agg[v.dept].scoreSum += Number(v.overall_score) || 0;
  }
  const { data: openIss } = await db().from('ops_issues').select('dept,status');
  const openByDept = {};
  for (const dep of U.DEPTS) openByDept[dep] = 0;
  for (const x of (openIss || [])) if (x.status !== 'resolved' && openByDept[x.dept] != null) openByDept[x.dept]++;
  const cards = U.DEPTS.map(dep => ({
    dept: dep, visits: agg[dep].visits,
    score: agg[dep].visits ? Math.round((agg[dep].scoreSum / agg[dep].visits) * 10) / 10 : 0,
    openIssues: openByDept[dep] || 0,
  }));
  return { weekStart: dstr[0], dates: dstr, cards };
};

// İclas — tək filial detalı (slayd): kateqoriya ortalamaları + işçi qeydləri + ziyarətlər
API.getOpsBranchDetail = async (key, dept, weekStart) => {
  if (!opsAuth(key) || !U.DEPTS.includes(dept)) return null;
  const dstr = opsWeekDates(weekStart);
  const { data: visits } = await db().from('ops_visits').select('*').eq('dept', dept).in('visit_date', dstr);
  const visitIds = (visits || []).map(v => v.visit_id);
  let ratings = [], notes = [], empProblems = [];
  if (visitIds.length) {
    const r = await db().from('ops_ratings').select('*').in('visit_id', visitIds);
    const n = await db().from('ops_emp_notes').select('*').in('visit_id', visitIds);
    const ip = await db().from('ops_issues').select('emp_id,emp_name,title,detail,severity').in('source_visit_id', visitIds);
    ratings = r.data || []; notes = n.data || [];
    empProblems = (ip.data || []).filter(i => i.emp_id);   // işçiyə bağlı problemlər
  }
  const catMap = {};
  for (const r of ratings) {
    if (!catMap[r.category]) catMap[r.category] = { sum: 0, c: 0 };
    if (r.score > 0) { catMap[r.category].sum += r.score; catMap[r.category].c++; }
  }
  const categories = Object.keys(catMap).map(cat => ({
    category: cat, avg: catMap[cat].c ? Math.round((catMap[cat].sum / catMap[cat].c) * 10) / 10 : 0,
  }));
  // Kateqoriya qeydləri (not yazılmış, problem işarələnməsə də) — heç bir müşahidə itməsin
  const catNotes = ratings
    .filter(r => r.note && String(r.note).trim())
    .map(r => ({ category: r.category, note: r.note, score: r.score, photoUrl: r.photo_url }));
  // İşçi qeydləri: adi qeydlər + işçi problemləri (hamısı bir yerdə görünsün)
  const empNotes = [
    ...notes.map(n => ({ empName: n.emp_name, sentiment: n.sentiment, note: n.note, photoUrl: n.photo_url, isProblem: false })),
    ...empProblems.map(i => ({ empName: i.emp_name, sentiment: 'neg', note: i.detail || i.title, isProblem: true })),
  ];
  // Kim, nə vaxt yoxlayıb (ops + icraçı ziyarətləri bir siyahıda, tarixə görə)
  const visitList = (visits || [])
    .slice()
    .sort((a, b) => String(a.visit_date).localeCompare(String(b.visit_date)))
    .map(v => ({ visitDate: v.visit_date, opsName: v.ops_name || '', overall: v.overall_score || 0, summary: v.summary || '' }));
  return { dept, visitCount: (visits || []).length, categories, catNotes, empNotes, visits: visitList };
};

// İclas — problemlər tabı (saha rejimində işarələnənlər); status filtri: open | progress | resolved | all
API.getOpsIssues = async (key, status, dept) => {
  if (!opsAuth(key)) return null;
  let q = db().from('ops_issues').select('*').order('created_at', { ascending: false });
  if (dept && U.DEPTS.includes(dept)) q = q.eq('dept', dept);
  const { data } = await q;
  let rows = data || [];
  if (status === 'open') rows = rows.filter(r => r.status !== 'resolved');
  else if (status && status !== 'all') rows = rows.filter(r => r.status === status);
  return rows.map(r => ({
    issueId: r.issue_id, dept: r.dept, empId: r.emp_id, empName: r.emp_name,
    title: r.title, detail: r.detail, severity: r.severity, status: r.status,
    assignedTo: r.assigned_to, dueDate: r.due_date, photoUrl: r.photo_url, createdAt: r.created_at,
  }));
};

// İclasda canlı yenilənmə: status / məsul / son tarix
API.updateOpsIssue = async (key, issueId, patch) => {
  if (!opsAuth(key)) return { success: false, reason: 'İcazəsiz.' };
  if (!issueId) return { success: false, reason: 'issueId yoxdur.' };
  const p = patch || {};
  const upd = {};
  if (p.status && ['open', 'progress', 'resolved'].includes(p.status)) {
    upd.status = p.status;
    upd.resolved_at = p.status === 'resolved' ? new Date().toISOString() : null;
  }
  if (typeof p.assignedTo === 'string') upd.assigned_to = p.assignedTo.trim();
  if (typeof p.dueDate === 'string') upd.due_date = p.dueDate.trim();
  if (!Object.keys(upd).length) return { success: false, reason: 'Dəyişiklik yoxdur.' };
  const { error } = await db().from('ops_issues').update(upd).eq('issue_id', issueId);
  if (error) return { success: false, reason: error.message };
  return { success: true };
};

// Foto yükləmə — base64 → Supabase Storage (bucket: ops-photos)
API.uploadOpsPhoto = async (key, base64, ext) => {
  if (!opsFieldAuth(key).ok) return { success: false, reason: 'İcazəsiz.' };   // icraçı da foto əlavə edir
  if (!base64) return { success: false, reason: 'Şəkil yoxdur.' };
  try {
    const clean = String(base64).replace(/^data:image\/\w+;base64,/, '');
    const buf = Buffer.from(clean, 'base64');
    const safeExt = (ext && /^(jpg|jpeg|png|webp)$/i.test(ext)) ? ext.toLowerCase() : 'jpg';
    // Yol müştəri ilə başlayır — bucket ortaq olsa da fayl adları qarışmır.
    // Fayl adı TƏXMİN EDİLƏ BİLMƏMƏLİDİR: bucket ictimaidir, yəni linki bilən
    // şəkli aça bilir. Əvvəl `Date.now()` + `Math.random()` idi — hər ikisi
    // proqnozlaşdırıla bilir. İndi 12 simvol crypto təsadüfü (60 bit).
    const fpath = `${T.tenantId()}/ops/` + T.randomToken(12) + '.' + safeExt;
    const { error } = await sb.storage.from('ops-photos')
      .upload(fpath, buf, { contentType: 'image/' + (safeExt === 'jpg' ? 'jpeg' : safeExt), upsert: false });
    if (error) return { success: false, reason: error.message };
    const { data } = sb.storage.from('ops-photos').getPublicUrl(fpath);
    return { success: true, url: (data && data.publicUrl) || '' };
  } catch (e) {
    return { success: false, reason: e.message };
  }
};

API.getAllTrainerItems = async () => {
  const { data } = await db().from('trainer_checklist_items').select('*').order('sort_order');
  return (data || []).map(r => ({ id: r.item_id, text: r.text, category: r.category || '', active: r.active !== false }));
};

API.getActiveTrainerItems = async () => {
  const { data } = await db().from('trainer_checklist_items').select('*').eq('active', true).order('sort_order');
  return (data || []).map(r => ({ id: r.item_id, text: r.text, category: r.category || '' }));
};

API.saveTrainerItems = async (items) => {
  const rows = (items || []).map((item, i) => ({
    item_id:    item.id || U.newId('TCI-', i),
    text:       String(item.text || '').trim(),
    category:   item.category || '',
    active:     item.active !== false,
    sort_order: i,
  }));
  //  Əvvəl nə silmənin, nə də yazmanın xətası OXUNURDU — funksiya hər halda
  //  `{success:true}` deyirdi (F-06 ilə eyni sinif səhv). İndi ikisi də yoxlanılır.
  const r = await replaceRows('trainer_checklist_items', (q) => q.neq('item_id', 'x'), rows, 'saveTrainerItems');
  if (!r.ok) return { success: false, reason: r.reason, restored: r.restored };
  return { success: true };
};

API.getEmployeesByDept = async (dept) => {
  const { data } = await db().from('employees').select('id,name,dept').order('name');
  return (data || []).filter(r => r.dept === dept).map(r => ({ id: r.id, name: r.name }));
};

API.submitTrainerLog = async (trainerKey, trainerName, dept, empId, empName, items, note) => {
  if (!roleKey('trainer') || roleKey('trainer') !== trainerKey)
    return { success: false, reason: 'İcazəsiz əməliyyat.' };
  const ts    = new Date();
  const logId = U.newId('TL-');
  await db().from('trainer_logs').insert({
    log_id:       logId,
    trainer_name: String(trainerName || 'Naməlum').trim(),
    dept,
    emp_id:       String(empId),
    emp_name:     String(empName || ''),
    date_str:     U.getLogicalYMD(ts),
    items:        items || [],
    general_note: note || '',
    created_at:   ts.toISOString(),
  });
  return { success: true };
};

API.getTodayTrainerLogs = async (trainerKey) => {
  if (!roleKey('trainer') || roleKey('trainer') !== trainerKey)
    return { logs: [] };
  const date = U.getLogicalYMD(new Date());
  const { data } = await db().from('trainer_logs').select('*').eq('date_str', date).order('created_at', { ascending: false });
  return { logs: data || [] };
};

API.getTrainerLogs = async (dateStr) => {
  const date = dateStr || U.getLogicalYMD(new Date());
  const { data } = await db().from('trainer_logs').select('*').eq('date_str', date).order('created_at', { ascending: false });
  return { date, logs: data || [] };
};

// ── İMTAHAN ──────────────────────────────────────────────────────

API.submitExam = async (trainerKey, trainerName, dept, empId, empName, score, maxScore, answers, note) => {
  if (!roleKey('trainer') || roleKey('trainer') !== trainerKey)
    return { success: false, reason: 'İcazəsiz əməliyyat.' };
  const ts     = new Date();
  const examId = U.newId('EX-');
  const { error } = await db().from('trainer_exams').insert({
    exam_id:      examId,
    trainer_name: String(trainerName || 'Naməlum').trim(),
    dept,
    emp_id:       String(empId),
    emp_name:     String(empName   || ''),
    score:        Number(score)    || 0,
    max_score:    Number(maxScore) || 100,
    answers:      answers          || [],
    note:         note             || '',
    date_str:     U.getLogicalYMD(ts),
    created_at:   ts.toISOString(),
  });
  sbErr('submitExam', error);
  return { success: !error, reason: error?.message };
};

API.giveManualXP = async (trainerKey, empId, amount) => {
  if (!roleKey('trainer') || roleKey('trainer') !== trainerKey)
    return { success: false, reason: 'İcazəsiz.' };
  const amt = parseInt(amount);
  if (!empId || isNaN(amt) || amt < 1 || amt > 500)
    return { success: false, reason: 'Məbləğ 1–500 arasında olmalıdır.' };
  const { data: emp } = await db().from('employees').select('name,dept,is_test').eq('id', String(empId)).single();
  if (!emp || emp.is_test) return { success: false, reason: 'İşçi tapılmadı.' };
  await awardXP(empId, amt, 0);
  const trainerName = U.getSetting('TRAINER_NAME') || 'Trainer';
  await db().from('xp_audit_log').insert({
    trainer_name: trainerName, emp_id: String(empId), emp_name: emp.name,
    dept: emp.dept, amount: amt, type: 'manual', stars: null,
    created_at: new Date().toISOString(),
  });
  return { success: true, xp: amt };
};

API.rateEmployee = async (trainerKey, empId, stars) => {
  if (!roleKey('trainer') || roleKey('trainer') !== trainerKey)
    return { success: false, reason: 'İcazəsiz.' };
  // Ulduz → XP xəritəsi XP_CONFIG-dədir (əvvəl burada hardcode idi)
  const xp = U.getXPConfig().ratingXP[parseInt(stars)];
  if (!empId || !xp) return { success: false, reason: 'Yanlış məlumat.' };
  const { data: emp } = await db().from('employees').select('name,dept,is_test').eq('id', String(empId)).single();
  if (!emp || emp.is_test) return { success: false, reason: 'İşçi tapılmadı.' };
  await awardXP(empId, xp, 0);
  const trainerName = U.getSetting('TRAINER_NAME') || 'Trainer';
  await db().from('xp_audit_log').insert({
    trainer_name: trainerName, emp_id: String(empId), emp_name: emp.name,
    dept: emp.dept, amount: xp, type: 'rating', stars: parseInt(stars),
    created_at: new Date().toISOString(),
  });
  return { success: true, xp };
};

// ── HADİSƏ JURNALI (oxuma) ────────────────────────────────────────
//  Yalnız admin. `detail` sütununda redaktə edilmiş arqumentlər var —
//  açar/secret yoxdur (bax audit.js), amma yenə də işçi adları, məbləğlər
//  və ID-lər var, ona görə panel açarı tələb olunur.
API.getAuditLog = async (filter) => {
  const f = filter || {};
  let q = db().from('audit_log').select('*');
  if (f.action) q = q.eq('action', String(f.action));
  if (f.role)   q = q.eq('actor_role', String(f.role));
  if (f.from)   q = q.gte('ts', String(f.from));
  if (f.to)     q = q.lte('ts', String(f.to));

  const limit = Math.min(500, Math.max(1, Number(f.limit) || 200));
  const { data, error } = await q.order('ts', { ascending: false }).limit(limit);
  if (error) {
    // Cədvəl hələ yaradılmayıbsa panel boş siyahı yox, səbəb görsün.
    return { rows: [], reason: /audit_log/i.test(error.message || '')
      ? 'Jurnal cədvəli hələ yaradılmayıb — audit-log-migration.sql işlədilməlidir.'
      : error.message };
  }
  return {
    rows: (data || []).map(r => ({
      logId: r.log_id, ts: r.ts, actorRole: r.actor_role, actorName: r.actor_name,
      action: r.action, target: r.target, detail: r.detail, ok: r.ok !== false,
      hasBefore: r.before != null,
    })),
  };
};

// Bir sətrin `before` sənədi (ayın snapshot-u böyük ola bilər — ayrıca çəkilir)
API.getAuditBefore = async (logId) => {
  const { data } = await db().from('audit_log').select('before').eq('log_id', String(logId)).maybeSingle();
  return { before: (data && data.before) || null };
};

API.getXPAuditLog = async () => {
  const { data } = await db().from('xp_audit_log')
    .select('*').order('created_at', { ascending: false }).limit(200);
  return { rows: data || [] };
};

API.gradeOpenAnswer = async (trainerKey, examId, questionId, passed) => {
  if (!roleKey('trainer') || roleKey('trainer') !== trainerKey)
    return { success: false, reason: 'İcazəsiz.' };
  if (!examId || !questionId || typeof passed !== 'boolean')
    return { success: false, reason: 'Məlumatlar natamamdır.' };

  const { data: rows, error: fetchErr } = await db().from('trainer_exams').select('*').eq('exam_id', examId).limit(1);
  if (fetchErr || !rows?.length) return { success: false, reason: 'İmtahan tapılmadı.' };

  const exam = rows[0];
  const answers = (exam.answers || []).map(a =>
    a.questionId === questionId && a.type === 'open' ? { ...a, passed } : a
  );
  const score = answers.filter(a => a.passed === true).length;

  const { error } = await db().from('trainer_exams').update({ answers, score }).eq('exam_id', examId);
  sbErr('gradeOpenAnswer', error);
  if (!error && passed) {
    const { data: empRow } = await db().from('employees').select('streak,is_test').eq('id', String(exam.emp_id)).single();
    if (empRow && !empRow.is_test) await awardXP(exam.emp_id, U.getXPConfig().openAnswerXP, empRow.streak || 0);
  }
  return { success: !error, score, answers };
};

API.getTodayExams = async (trainerKey) => {
  if (!roleKey('trainer') || roleKey('trainer') !== trainerKey)
    return { exams: [] };
  const date = U.getLogicalYMD(new Date());
  const { data } = await db().from('trainer_exams').select('*').eq('date_str', date).order('created_at', { ascending: false });
  return { exams: data || [] };
};

// Seçilmiş tarixin imtahan nəticələri (trainer paneli — tarixə görə baxış)
API.getExamResultsByDate = async (trainerKey, dateStr) => {
  if (!roleKey('trainer') || roleKey('trainer') !== trainerKey)
    return { exams: [] };
  const date = dateStr || U.getLogicalYMD(new Date());
  const { data } = await db().from('trainer_exams').select('*').eq('date_str', date).order('created_at', { ascending: false });
  return { date, exams: data || [] };
};

API.getExamLogs = async (dateStr) => {
  const date = dateStr || U.getLogicalYMD(new Date());
  const { data } = await db().from('trainer_exams').select('*').eq('date_str', date).order('created_at', { ascending: false });
  return { date, exams: data || [] };
};

// ── TƏLİM MATERİALLARI (Trainer öz materialları) ─────────────────

API.getTrainerMaterials = async () => {
  const { data } = await db().from('trainer_materials').select('*').eq('active', true).order('sort_order');
  return (data || []).map(m => ({
    materialId: m.material_id,
    title:      m.title,
    body:       m.body     || '',
    category:   m.category || '',
  }));
};

API.saveTrainerMaterial = async (trainerKey, material) => {
  if (!roleKey('trainer') || roleKey('trainer') !== trainerKey)
    return { success: false, reason: 'İcazəsiz.' };
  if (!material?.title?.trim()) return { success: false, reason: 'Başlıq boş ola bilməz.' };
  const { data: last } = await db().from('trainer_materials')
    .select('sort_order').eq('active', true).order('sort_order', { ascending: false }).limit(1);
  const sortOrder = (last?.length ? last[0].sort_order : 0) + 1;
  const id = U.newId('TM-');
  const { error } = await db().from('trainer_materials').insert({
    material_id: id,
    title:       material.title.trim(),
    body:        (material.body     || '').trim(),
    category:    (material.category || '').trim(),
    active:      true,
    sort_order:  sortOrder,
  });
  sbErr('saveTrainerMaterial', error);
  return { success: !error, materialId: id };
};

API.deleteTrainerMaterial = async (trainerKey, materialId) => {
  if (!roleKey('trainer') || roleKey('trainer') !== trainerKey)
    return { success: false };
  const { error } = await db().from('trainer_materials').update({ active: false }).eq('material_id', materialId);
  return { success: !error };
};

// ── İMTAHAN SUALLARI (Trainer öz sualları) ───────────────────────

API.getExamQuestions = async () => {
  const { data } = await db().from('exam_questions').select('*').eq('active', true).order('sort_order');
  return (data || []).map(q => ({
    questionId: q.question_id,
    text:       q.text,
    type:       q.type,
    options:    q.options  || [],
    correct:    q.correct  || '',
    category:   q.category || '',
    role:       q.role     || 'umumi',
  }));
};

API.saveExamQuestion = async (trainerKey, question) => {
  if (!roleKey('trainer') || roleKey('trainer') !== trainerKey)
    return { success: false, reason: 'İcazəsiz.' };
  if (!question?.text?.trim()) return { success: false, reason: 'Sual mətni boş ola bilməz.' };
  if (question.type === 'test') {
    const opts = (question.options || []).filter(o => o.text?.trim());
    if (opts.length < 2) return { success: false, reason: 'Test üçün ən azı 2 variant lazımdır.' };
    if (!question.correct) return { success: false, reason: 'Düzgün cavabı seçin.' };
  }
  const { data: last } = await db().from('exam_questions')
    .select('sort_order').eq('active', true).order('sort_order', { ascending: false }).limit(1);
  const sortOrder = (last?.length ? last[0].sort_order : 0) + 1;
  const id = U.newId('EQ-');
  const { error } = await db().from('exam_questions').insert({
    question_id: id,
    text:        question.text.trim(),
    type:        question.type || 'open',
    options:     question.options || [],
    correct:     question.correct || '',
    category:    (question.category || '').trim(),
    role:        ['kassir','barista','umumi'].includes(question.role) ? question.role : 'umumi',
    active:      true,
    sort_order:  sortOrder,
  });
  sbErr('saveExamQuestion', error);
  return { success: !error, questionId: id };
};

API.deleteExamQuestion = async (trainerKey, questionId) => {
  if (!roleKey('trainer') || roleKey('trainer') !== trainerKey)
    return { success: false };
  const { error } = await db().from('exam_questions').update({ active: false }).eq('question_id', questionId);
  return { success: !error };
};

// ── İŞÇİ ÖZÜ İMTAHAN ────────────────────────────────────────────

//  Bir çağırışda hər şey: imtahan açıqdırmı, işçi kimdir, bu gün veribmi.
//  `secret` OLMADAN da işləyir — trainer paneli yalnız `active` bayrağını
//  soruşur (onun öz açarı var, işçi secret-i yoxdur).
API.getExamStatus = async (secret) => {
  const active = examOpen();
  if (!secret) return { active };

  const { data: emp } = await db().from('employees')
    .select('id,name,dept').eq('secret', secret).single();
  if (!emp) return { active, known: false };

  return {
    active,
    known:     true,
    empId:     emp.id,
    empName:   emp.name,
    dept:      emp.dept,
    doneToday: await selfExamToday(emp.id, U.getLogicalYMD(new Date())),
  };
};

API.setExamStatus = async (trainerKey, active) => {
  if (!roleKey('trainer') || roleKey('trainer') !== trainerKey)
    return { success: false };
  await U.setSetting('EXAM_ACTIVE', active ? 'true' : 'false');
  return { success: true, active };
};

// ── İMTAHAN QAYDALARI (F-08) ─────────────────────────────────────
//  `submitEmployeeExam` `'public'` idi və HEÇ NƏ yoxlamırdı: `empId` sadəcə
//  arqument idi, `EXAM_ACTIVE` baxılmırdı, limit yox idi, cavabda isə DÜZGÜN
//  CAVABLAR qayıdırdı. Yəni zəncir açıq idi — sualları al, bir dəfə göndər,
//  düzgün cavabları oxu, 100% ilə SONSUZ sayda yenidən göndər. Hər dəfə XP.
//
//  Düzgün cavabların qaytarılması QƏSDƏN saxlanılır: nəticə ekranındakı
//  «harada səhv etdim» icmalı təlimin əsas faydasıdır. Fermanı bağlayan şey
//  cavabları gizlətmək yox, GÜNDƏ BİR imtahan qaydasıdır — onunla XP artıq
//  namuslu işçinin ala biləcəyi qədərdir.
function examOpen() {
  return U.getSetting('EXAM_ACTIVE') === 'true';
}

// İşçi bu MƏNTİQİ gündə artıq özü imtahan veribmi?
// Yalnız «özü» imtahanları sayılır — trainer-in keçirdiyi imtahan ayrı işdir
// və işçinin öz cəhdini bloklamamalıdır.
const SELF_EXAM_LABEL = 'Özü';

async function selfExamToday(empId, ymd) {
  const { data } = await db().from('trainer_exams')
    .select('exam_id').eq('emp_id', String(empId)).eq('date_str', ymd).eq('trainer_name', SELF_EXAM_LABEL);
  return (data || []).length > 0;
}

// Düzgün cavablar göndərilmir — test + açıq suallar birlikdə qaytarılır.
// F-08: `EXAM_ACTIVE` BURADA da yoxlanılır. Əvvəl yalnız səhifə onu soruşurdu
// (`getExamStatus`), yəni API-yə birbaşa müraciətlə bağlı imtahanın sualları
// da alınırdı. Bayraq bir yerdə deyil, HƏR qapıda yoxlanmalıdır.
//  ⚠️ ADI DƏYİŞDİ: `getExamQuestionsPublic` → `getMyExamQuestions`.
//  Köhnə ad yalan deyirdi (funksiya artıq işçinin `secret`-ini tələb edir),
//  sadəcə `getExamQuestions` isə TRAINER-in sual idarəetmə funksiyasıdır —
//  o, düzgün cavabları da qaytarır və `'staff'` olaraq qalmalıdır.
//  `getMy…` prefiksi paneldəki digər işçi funksiyaları ilə eynidir.
//  `/exam` service worker-də keşlənmir, ona görə köhnə ad qalmır.
API.getMyExamQuestions = async (secret, role) => {
  if (!examOpen()) return [];
  if (!['kassir','barista'].includes(role)) return [];
  const { data: emp } = await db().from('employees').select('id').eq('secret', secret).single();
  if (!emp) return [];
  const { data } = await db().from('exam_questions')
    .select('question_id,text,type,options,category,role')
    .eq('active', true).order('sort_order');
  return (data || [])
    .filter(q => q.role === role || q.role === 'umumi')
    .map(q => ({
      questionId: q.question_id,
      text:       q.text,
      type:       q.type,
      options:    q.type === 'test' ? (q.options || []) : [],
      category:   q.category || '',
      role:       q.role     || 'umumi',
    }));
};

// Server-side qiymətləndirmə: test → avtomatik, açıq → saxlanır (null)
//  F-08: imza `(empId, empName, dept, role, answers)` idi və funksiya `'public'`.
//  Yəni `empId` sadəcə arqument idi — istənilən şəxs istənilən işçinin adından
//  imtahan göndərə (və ona XP yaza) bilirdi. İndi kimlik `secret`-dən çıxır,
//  ad/filial isə bazadan — müştəri onları uydura bilmir.
API.submitEmployeeExam = async (secret, role, answers) => {
  if (!secret || !role || !answers?.length)
    return { success: false, reason: 'Məlumatlar natamamdır.' };
  if (!examOpen()) return { success: false, reason: 'İmtahan hazırda bağlıdır.' };

  const { data: emp } = await db().from('employees')
    .select('id,name,dept,streak,is_test').eq('secret', secret).single();
  if (!emp) return { success: false, reason: 'İşçi tapılmadı. Kartınızı yenidən açın.' };

  const ts  = new Date();
  const ymd = U.getLogicalYMD(ts);

  // Gündə bir imtahan — fermanı bağlayan qayda budur.
  if (await selfExamToday(emp.id, ymd)) {
    return { success: false, reason: 'Bu gün artıq imtahan vermisiniz. Sabah yenidən cəhd edə bilərsiniz.' };
  }

  // Sual mətni, variantlar və tip də BAZADAN götürülür — müştəri yalnız
  // «hansı suala nə cavab verdim» deyir. Əvvəl `text`/`options` göndərildiyi
  // kimi saxlanılırdı və trainer panelində göstərilirdi (uydurma sual riski).
  const qIds = [...new Set(answers.map(a => a.questionId).filter(Boolean))];
  const { data: qRows } = qIds.length
    ? await db().from('exam_questions')
        .select('question_id,text,type,options,category,correct').in('question_id', qIds)
    : { data: [] };
  const qMap = {};
  for (const q of qRows || []) qMap[q.question_id] = q;

  let score = 0, testTotal = 0;
  const graded = [];
  for (const a of answers) {
    const q = qMap[a.questionId];
    if (!q) continue;                       // silinmiş/naməlum sual — sayılmır
    if (q.type === 'test') {
      testTotal++;
      const passed = !!q.correct && a.given === q.correct;
      if (passed) score++;
      graded.push({ questionId:q.question_id, text:q.text, category:q.category || '',
                    options:q.options || [], correct:q.correct, given:a.given || null,
                    passed, type:'test' });
    } else {
      // Açıq sual — cavab mətni saxlanılır, qiyməti trainer verir
      graded.push({ questionId:q.question_id, text:q.text, category:q.category || '',
                    options:[], correct:'', given:null,
                    givenText:String(a.givenText || '').slice(0, 2000), passed:null, type:'open' });
    }
  }
  if (!graded.length) return { success: false, reason: 'Sual tapılmadı. Səhifəni yeniləyin.' };

  const examId = U.newId('EX-');
  const { error } = await db().from('trainer_exams').insert({
    exam_id:      examId,
    trainer_name: SELF_EXAM_LABEL,
    dept:         emp.dept,
    emp_id:       String(emp.id),
    emp_name:     emp.name,
    score,
    max_score:    graded.length,
    answers:      graded,
    note:         '',
    date_str:     ymd,
    created_at:   ts.toISOString(),
  });
  sbErr('submitEmployeeExam', error);
  if (!error && testTotal > 0) {
    const pct = Math.round(score / testTotal * 100);
    const xpBase = U.examXP(pct);
    if (xpBase > 0 && !emp.is_test) await awardXP(emp.id, xpBase, emp.streak || 0);
  }
  // İmtahan bitdi → trainerə push bildiriş (Telegram yox)
  if (!error) {
    const openCount = graded.filter(a => a.type === 'open').length;
    const parts = [`${emp.name} (${emp.dept}) imtahanı bitirdi.`];
    if (testTotal > 0)   parts.push(`Test: ${score}/${testTotal} düz.`);
    if (openCount > 0)   parts.push(`${openCount} açıq sual qiymət gözləyir.`);
    const pExam = U.fillPush('examDone', { metn: parts.join(' ') });
    if (pExam) await sendPushToTrainer(pExam.title, pExam.body, {
      tag: 'exam-' + examId,
      url: '/trainer?key=' + (roleKey('trainer') || ''),
    });
  }
  return { success: !error, score, maxScore: testTotal, answers: graded };
};

// ══════════════════════════════════════════════════════════════════
//  PLATFORMA API — yalnız PLATFORM_KEY ilə (səndə)
// ══════════════════════════════════════════════════════════════════
//  Bunlar müştəri kontekstindən KƏNARDA işləyir: tenant yaradır, abunəlik
//  vəziyyətini dəyişir. Dispatcher bu funksiyaları ayrıca yolla keçirir
//  (yuxarıda `role === 'platform'` şaxəsinə bax).

const platform = require('./platform');

API.platformListTenants = async () => ({ tenants: await platform.listTenants() });

API.platformCreateTenant = async (opts) => {
  try {
    const r = await platform.createTenant(opts || {});
    return { success: true, ...r };
  } catch (e) {
    console.error('[Platform] createTenant:', e.message);
    return { success: false, reason: e.message };
  }
};

API.platformUpdateTenant = async (tenantId, patch) => platform.updateTenant(tenantId, patch || {});

API.platformDeleteTenant = async (tenantId, confirmName) => platform.deleteTenant(tenantId, confirmName);

API.platformTenantKeys = async (tenantId) => platform.tenantKeys(tenantId);

API.platformStats = async () => {
  const list = await platform.listTenants();
  return {
    tenants:   list.length,
    active:    list.filter(t => t.status === 'active').length,
    suspended: list.filter(t => t.status !== 'active').length,
    employees: list.reduce((s, t) => s + t.employees, 0),
    branches:  list.reduce((s, t) => s + t.branches, 0),
    byPlan:    list.reduce((m, t) => ({ ...m, [t.plan]: (m[t.plan] || 0) + 1 }), {}),
  };
};

// ══════════════════════════════════════════════════════════════════
//  SERVER BAŞLAT
// ══════════════════════════════════════════════════════════════════

//  ⚠️ `require.main === module` — server YALNIZ birbaşa işə salınanda dinləyir
//  (`node server.js`, Railway də bunu edir). `require('./server')` edilsə
//  marşrutlar qurulur, port TUTULMUR. Bu, API funksiyalarını davranış testi ilə
//  yoxlamağa imkan verir — əvvəl yalnız mənbə mətnini oxumaq olurdu
//  (bax test-multitenant.js §12-dəki qeyd).
if (require.main === module) (async () => {
  try {
    // Müştərilər, açarlar, parametrlər və filiallar — hamısı bir dəfə keşə yüklənir.
    await T.loadAll();
    console.log('✅  Supabase bağlantısı hazırdır');

    app.listen(PORT, async () => {
      const base = `http://localhost:${PORT}`;
      console.log(`🚀  Server ${base}`);
      console.log(`🧩  Node ${process.version} · TZ ${process.env.TZ} · auth ${auth.AUTH_ENFORCE ? 'İCBARİ' : 'log-only'}`);
      console.log(`🛡️   trust proxy: ${JSON.stringify(TRUST_PROXY)} · WiFi ${U.WIFI_ENFORCE ? 'İCBARİ' : 'LOG-ONLY'} · ` +
                  `sürət limiti ${RATE_LIMIT ? 'aktiv' : 'SÖNDÜRÜLÜB'}`);
      if (!U.WIFI_ENFORCE) console.warn('⚠️  WIFI_ENFORCE=false — filial şəbəkəsi yoxlanılır, amma BLOKLAMIR.');
      if (!RATE_LIMIT)     console.warn('⚠️  RATE_LIMIT=false — PIN brute-force qoruması söndürülüb.');
      if (!T.PLATFORM_KEY) {
        console.warn('⚠️  PLATFORM_KEY təyin edilməyib — platforma paneli bağlıdır. ' +
                     'Yeni müştəri yaratmaq üçün onu env-ə əlavə et.');
      }

      const tenants = T.allTenants();
      if (!tenants.length) {
        console.warn('⚠️  Heç bir müştəri yoxdur. `node seed-tenant.js` ilə birini yarat.');
      }
      // Hər müştərinin giriş linklərini konsola yaz (yalnız lokalda faydalıdır).
      for (const t of tenants) {
        console.log(`\n🏢  ${t.name}  [${t.tenant_id}] — ${t.status}`);
        await T.run({ tenantId: t.tenant_id, role: 'system', branchId: null }, async () => {
          const ak = T.findKey(t.tenant_id, 'admin', null);
          if (ak) console.log(`   🔑 Admin:   ${base}/admin?key=${ak}`);
          const keys = await U.getBranchScheduleKeys();
          for (const [dept, key] of Object.entries(keys)) {
            console.log(`   🏪 ${dept}: ${base}/manager?key=${key}`);
          }
        });
      }

      // Avtomatik gecə bağlaması SİLİNİB — açıq smenləri admin paneldən
      // «Açıq smenlər» səhifəsində real saatla bağlayır.
    });
  } catch (e) {
    console.error('❌  Başlama xətası:', e.message);
    process.exit(1);
  }
})();

// Testlər üçün: `API` obyekti dispatcher-in çağırdığı funksiyaların eynisidir.
module.exports = { API, app };
