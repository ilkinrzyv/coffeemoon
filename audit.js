'use strict';
// ══════════════════════════════════════════════════════════════════════════
//  HADİSƏ JURNALI  (audit_log)
// ══════════════════════════════════════════════════════════════════════════
//  Bu vaxta qədər «kim nə vaxt nəyi dəyişdi» sualının cavabı YALNIZ
//  `xp_audit_log`-da vardı. Cərimənin silinməsi, ayın yenidən açılması,
//  açarın yenilənməsi, maaş dərəcəsinin dəyişməsi, işçinin filialının
//  dəyişməsi — hamısı izsiz idi. İşçi «mən bunu imzalamamışam» desə,
//  yaxud iki idarəçi bir-birini günahlandırsa, sistemin deyəcək sözü yox idi.
//
//  ⚠️ ƏSAS QƏRAR: jurnal YAZILMANIN ÖZÜNDƏN doğur, funksiyanın yadına
//  düşməsindən yox.
//  ─────────────────────────────────────────────────────────────────────
//  «Hər mutasiya funksiyasında `audit(...)` çağır» yanaşması qaçılmaz olaraq
//  sürüşür: yeni funksiya yazılır, çağırış unudulur, jurnalda BOŞLUQ yaranır
//  və bunu heç kim görmür. Bu layihədə həmin naxış artıq bir neçə dəfə baş
//  verib (F-06 səssiz `error`, F-10 sxem dreyfi).
//
//  Ona görə mənbə `tdb.js`-dir — bütün yazmalar onsuz da oradan keçir.
//  Sorğu boyu hansı cədvəllərə nə yazıldığı kontekstdə toplanır; dispatcher
//  sorğunun sonunda BİR sətir yazır. Yeni funksiya heç nə etmədən jurnala düşür.
//
//  `before`/`after` isə avtomatik ola bilməz (yazmadan əvvəlki dəyəri yalnız
//  funksiyanın özü bilir) — onu vacib yerlərdə `auditDetail()` ilə əlavə edirik.
// ══════════════════════════════════════════════════════════════════════════

//  Bu funksiyalar jurnala DÜŞMÜR. Səbəb hər biri üçün ayrıdır:
//    · davamiyyət və nahar — öz cədvəlləri onsuz da hadisənin ÖZÜDÜR
//      (vaxt möhürü, cihaz izi, işçi). İkinci dəfə yazmaq gündə yüzlərlə
//      sətir əlavə edir və heç bir yeni məlumat vermir.
//    · kiosk siqnalı — hər 5 dəqiqədən bir gəlir, sırf texniki.
//    · push abunəliyi — brauzer avtomatik yeniləyir, insan qərarı deyil.
const SKIP = new Set([
  'validateAndLog',        // → attendance (öz izi var: timestamp + device_id)
  'logLunch',              // → nahar
  'kioskIpQeyd',           // → scan_devices.last_ip (5 dəqiqəlik siqnal)
  'savePushSubscription',
  'dropPushSubscription',
  'bindDevice',
]);

//  Jurnalın öz cədvəli sayılmır — əks halda hər yazma özünü yazardı.
const SELF_TABLE = 'audit_log';

// ── Redaktə ───────────────────────────────────────────────────────────────
//  ⚠️ Arqumentlərdə AÇAR VƏ SECRET var: panellər öz açarını həm `X-CM-Key`
//  başlığında, həm də çox vaxt birinci arqument kimi göndərir
//  (`approveLatePerm(branchKey, …)`, `saveProfile(secret, …)`).
//  Jurnal uzun müddət saxlanılan cədvəldir — ora açar düşsə, jurnalı oxuya
//  bilən hər kəs həmin panelə girə bilər.
//
//  Redaktə ŞƏKLƏ görə YOX, BƏRABƏRLİYƏ görə edilir: sorğunun öz açarı ilə
//  üst-üstə düşən hər sətir gizlədilir. Şəklə güvənmək olmazdı, çünki
//  `U.newId` ID-ləri açarlarla eyni əlifbadadır (`FN-MT544NCCM2XY54`) —
//  şəkil süzgəci ya açarı buraxardı, ya da faydalı ID-ni silərdi.
const MAX_STR   = 200;     // bundan uzun sətir saxlanılmır (base64 şəkil, JSON)
const MAX_JSON  = 4000;    // bütün arqumentlərin cəmi
const MAX_DEPTH = 4;

function redact(value, secret, depth = 0) {
  if (value == null) return value;
  if (depth > MAX_DEPTH) return '…';

  if (typeof value === 'string') {
    if (secret && value === secret) return '***';
    if (/^data:/.test(value)) return '<data URI ' + value.length + ' simvol>';
    if (value.length > MAX_STR) return value.slice(0, MAX_STR) + '… (' + value.length + ' simvol)';
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    // Uzun massivlər (cədvəl batch-ləri) tam saxlanılmır — sayı kifayətdir.
    if (value.length > 20) return `<${value.length} element>`;
    return value.map(v => redact(v, secret, depth + 1));
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact(v, secret, depth + 1);
    return out;
  }
  return String(value);
}

//  Arqumentləri jurnal üçün mətnə çevirir. Xəta atmır — jurnal heç vaxt
//  əsas əməliyyatı sındırmamalıdır.
function summarize(args, secret) {
  try {
    const clean = (args || []).map(a => redact(a, secret));
    let s = JSON.stringify(clean);
    if (s.length > MAX_JSON) s = s.slice(0, MAX_JSON) + '…';
    return s;
  } catch (_) {
    return '<oxunmadı>';
  }
}

// ── Yazma izi (tdb.js doldurur) ───────────────────────────────────────────
//  `[{ table, op }]` → `"cedvel:delete×1, cedvel:insert×1"`
function formatWrites(writes) {
  const say = new Map();
  for (const w of writes || []) {
    if (w.table === SELF_TABLE) continue;
    const k = `${w.table}:${w.op}`;
    say.set(k, (say.get(k) || 0) + 1);
  }
  return [...say.entries()].map(([k, n]) => (n > 1 ? `${k}×${n}` : k)).join(', ');
}

function hasRealWrite(writes) {
  return (writes || []).some(w => w.table !== SELF_TABLE);
}

module.exports = { SKIP, SELF_TABLE, redact, summarize, formatWrites, hasRealWrite, MAX_STR, MAX_JSON };
