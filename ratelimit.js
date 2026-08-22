'use strict';
// ══════════════════════════════════════════════════════════════════════════
//  SÜRƏT LİMİTİ (sürüşən deyil, sabit pəncərə)
// ══════════════════════════════════════════════════════════════════════════
//  Əvvəl layihədə heç bir limit yox idi: 10 000 variantlı PIN-i və panel
//  açarlarını istənilən sürətlə sınamaq olurdu.
//
//  NİYƏ AYRICA MODUL: məntiq kiçikdir, amma səhvi bahalıdır — çox boş
//  buraxsa mənasız olur, çox sıxsa bütün filialı işə buraxmır. Ayrıca modul
//  olduğu üçün `now` yeridilə bilir və `test-ratelimit.js` onu saat
//  gözləmədən, dəqiq sərhədlərlə yoxlayır.
//
//  NİYƏ ASILILIQ ƏLAVƏ EDİLMİR: `express-rate-limit` bu iş üçün ağırdır və
//  `npm ci` zəncirinə yeni paket gətirmək deploy riskidir. Sayğac yaddaşdadır.
//
//  ⚠️ İNSTANSİYA BAŞINA: bir Railway instansiyası üçün nəzərdə tutulub. İki
//  instansiyaya keçəndə ümumi hədd instansiya sayına vurulur (pisləşmə deyil,
//  sadəcə zəifləmə) — o vaxt Redis/Postgres sayğacına köçürülməlidir.
// ══════════════════════════════════════════════════════════════════════════

// Ehtiyat qapı: `RATE_LIMIT=false` (Railway Variables) — `AUTH_ENFORCE` ilə
// eyni naxış. Limit səhvən iş axınını dayandırsa deploy gözləmədən söndürülür.
const ENABLED = process.env.RATE_LIMIT !== 'false';

// 'bucket|açar' → { n, reset }
const _hits = new Map();

// Yaddaş tavanı: təsadüfi/zərərli axın Map-i şişirtməsin.
const MAX_KEYS = 5000;

function _slot(bucket, key, windowMs, now) {
  const k = bucket + '|' + key;
  let e = _hits.get(k);
  // Pəncərə bitibsə sayğac sıfırdan başlayır (sabit pəncərə).
  if (!e || now >= e.reset) { e = { n: 0, reset: now + windowMs }; _hits.set(k, e); }
  return e;
}

function _sweep(now) {
  if (_hits.size <= MAX_KEYS) return;
  for (const [k, v] of _hits) if (now >= v.reset) _hits.delete(k);
  // Hamısı hələ aktivdirsə (real hücum) ən köhnələri at — Map sıra saxlayır.
  while (_hits.size > MAX_KEYS) _hits.delete(_hits.keys().next().value);
}

function _retryAfter(e, now) {
  return Math.max(1, Math.ceil((e.reset - now) / 1000));
}

// Sayğacı ARTIRIR. `limit` daxildir: `limit` sayda çağırış keçir, sonrakı düşür.
function hit(bucket, key, limit, windowMs, now = Date.now()) {
  if (!ENABLED || !key) return { ok: true };
  const e = _slot(bucket, key, windowMs, now);
  e.n++;
  _sweep(now);
  return e.n <= limit ? { ok: true, used: e.n } : { ok: false, used: e.n, retryAfter: _retryAfter(e, now) };
}

// Sayğacı ARTIRMADAN yoxlayır — «bu açar hazırda bloklanıbmı?».
// Əməliyyatdan ƏVVƏL, nəticəsi hələ bilinmədən çağırılır.
function peek(bucket, key, limit, windowMs, now = Date.now()) {
  if (!ENABLED || !key) return { ok: true };
  const e = _slot(bucket, key, windowMs, now);
  return e.n < limit ? { ok: true, used: e.n } : { ok: false, used: e.n, retryAfter: _retryAfter(e, now) };
}

// Yalnız testlər üçün.
function __reset() { _hits.clear(); }
function __size()  { return _hits.size; }

module.exports = { hit, peek, ENABLED, MAX_KEYS, __reset, __size };
