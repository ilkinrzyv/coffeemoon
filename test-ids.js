'use strict';
// ══════════════════════════════════════════════════════════════════════════
//  ID GENERATORU — TESTLƏR  (F-12)
// ══════════════════════════════════════════════════════════════════════════
//  Bu testlərin cavab verdiyi sual: "iki sətir eyni ID ala bilərmi?"
//
//  Tarixçə: hər cədvəl öz ID-sini özü qururdu, ən pisi bu idi —
//
//      'E' + Date.now().toString(36).toUpperCase().slice(-5)
//
//  `slice(-5)` vaxt möhürünün son 5 simvolunu saxlayır → 36⁵ ms, yəni
//  **16 saat 47 dəqiqə**dən bir tam dövr edir. Yəni yarım gün ara ilə
//  yaradılan iki işçinin ID-si üst-üstə düşə bilirdi:
//    · eyni müştəridə — `(tenant_id,id)` ilkin açarı insert-i rədd edir
//      (işçi əlavə olunmur, admin səbəbini görmür);
//    · fərqli müştərilərdə — ilkin açar toqquşmur, eyni `emp_id` iki
//      müştəridə rahat yaşayır və QLOBAL unikal indeksləri sındırır (F-11).
//
//  ⚠️ ƏSAS TEST 4-dədir: köhnə generatorun formulu burada canlandırılır və bir
//  dövr ara ilə HƏQİQƏTƏN toqquşduğu göstərilir, yeninin isə toqquşmadığı.
//  Yəni test qaydanı deyil, konkret səhvi tutur.
//
//      node test-ids.js
// ══════════════════════════════════════════════════════════════════════════

process.env.TZ = process.env.TZ || 'Asia/Baku';

// utils.js → tdb.js → db.js zənciri Supabase açarları istəyir; taxta qoyuruq.
require.cache[require.resolve('./db')] = {
  id: require.resolve('./db'), filename: require.resolve('./db'), loaded: true,
  exports: { from: () => ({ select: () => ({}) }) },
};
const U = require('./utils');

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else      { fail++; console.log(`  ✗ ${label}${detail ? '\n      → ' + detail : ''}`); }
}
const section = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 52 - t.length))}`);

// Vaxtı dondurmaq üçün — eyni millisaniyədə nə baş verdiyini görmək lazımdır.
function atTime(ms, fn) {
  const original = Date.now;
  Date.now = () => ms;
  try { return fn(); } finally { Date.now = original; }
}

const ELIFBA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

console.log('\n══ ID GENERATORU TESTLƏRİ ══');

// ══════════════════════════════════════════════════════════════════════════
section('1. Format');
{
  const id = U.newId('FN-');
  ok(id.startsWith('FN-'), 'prefiks qorunur', id);
  ok(id.length === 3 + 8 + 6, 'prefiks + 8 (vaxt) + 6 (təsadüfi)', 'uzunluq=' + id.length);

  const seqli = U.newId('C', 7);
  ok(seqli.length === 1 + 8 + 2 + 6, 'sıra nömrəsi 2 simvol əlavə edir', seqli);

  ok(U.newId('').length === 14, 'prefikssiz də işləyir');
  ok(U.newId().length === 14, 'arqumentsiz də işləyir');

  // Quyruq yalnız açar əlifbasından olmalıdır (`I`/`O` yoxdur — əl ilə oxunur).
  const quyruq = U.newId('X').slice(-6);
  ok([...quyruq].every(c => ELIFBA.includes(c)), 'təsadüfi quyruq düzgün əlifbadandır', quyruq);
  ok(!/[IOÜ]/.test(quyruq), '`I`/`O` yoxdur (1/0 ilə qarışmasın)');
}

// ══════════════════════════════════════════════════════════════════════════
section('2. Eyni millisaniyədə toqquşmur');
{
  // Vaxt DONDURULUB — yəni fərqi YALNIZ təsadüfi quyruq yaradır.
  const N = 2000;
  const set = atTime(1_800_000_000_000, () => {
    const s = new Set();
    for (let i = 0; i < N; i++) s.add(U.newId('E'));
    return s;
  });
  ok(set.size === N, `eyni ms-də ${N} ID-nin hamısı unikaldır`, 'unikal: ' + set.size);
}

// ══════════════════════════════════════════════════════════════════════════
section('3. Batch: `seq` unikallığa ZƏMANƏT verir');
{
  // Təsadüfə heç güvənmədən: eyni ms + fərqli sıra → mütləq fərqli ID.
  // (`saveCedvel` 1000+ sətri BİR insert-lə yazır; bir toqquşma bütün
  //  cədvəl saxlamasını sındırardı, ona görə burada ehtimal yetmir.)
  const N = 5000;
  const set = atTime(1_800_000_000_000, () => {
    const s = new Set();
    for (let i = 0; i < N; i++) s.add(U.newId('C', i));
    return s;
  });
  ok(set.size === N, `eyni ms-də ${N} sıralı ID unikaldır`, 'unikal: ' + set.size);

  // Quyruğu süni şəkildə eyniləşdirsək belə `seq` fərqi saxlamalıdır.
  const a = atTime(1_800_000_000_000, () => U.newId('C', 3));
  const b = atTime(1_800_000_000_000, () => U.newId('C', 4));
  ok(a.slice(0, 11) !== b.slice(0, 11), 'sıra hissəsi ID-nin sabit yerindədir', a + ' / ' + b);
}

// ══════════════════════════════════════════════════════════════════════════
section('4. ⚠️ KÖHNƏ FORMUL toqquşur, YENİSİ yox (F-12-nin özü)');
{
  //  Köhnə generator — olduğu kimi.
  const kohne = (ms) => 'E' + new Date(ms).getTime().toString(36).toUpperCase().slice(-5);

  const DOVR = Math.pow(36, 5);                       // 60 466 176 ms = 16 saat 47 dəq
  const t1 = 1_800_000_000_000;
  const t2 = t1 + DOVR;                               // tam bir dövr sonra

  ok(kohne(t1) === kohne(t2),
     `köhnə formul ${(DOVR / 3600000).toFixed(1)} saat sonra EYNİ ID verir (səhv)`,
     kohne(t1) + ' = ' + kohne(t2));

  // Dövr həqiqətən bu qədər qısadır — «bir dəfə də olsa baş verməz» deyilə bilməz.
  ok(DOVR < 24 * 3600 * 1000,
     'köhnə dövr BİR GÜNDƏN qısadır', (DOVR / 3600000).toFixed(2) + ' saat');

  const y1 = atTime(t1, () => U.newId('E'));
  const y2 = atTime(t2, () => U.newId('E'));
  ok(y1 !== y2, 'yeni generator həmin iki anda FƏRQLİ ID verir', y1 + ' ≠ ' + y2);
  ok(y1.slice(1, 9) !== y2.slice(1, 9),
     'fərq təsadüfdən yox, KƏSİLMƏMİŞ vaxt möhüründən gəlir', y1.slice(1, 9) + ' ≠ ' + y2.slice(1, 9));
}

// ══════════════════════════════════════════════════════════════════════════
section('5. Math.random()-dan asılı deyil');
{
  // Köhnə ID-lərin quyruğu `Math.random()` idi. Onu sabitləyirik: generator
  // ondan asılı olsaydı bütün ID-lər eyni çıxardı.
  const original = Math.random;
  Math.random = () => 0.42;
  let set;
  try {
    set = atTime(1_800_000_000_000, () => {
      const s = new Set();
      for (let i = 0; i < 500; i++) s.add(U.newId('AV-'));
      return s;
    });
  } finally {
    Math.random = original;
  }
  ok(set.size === 500, 'Math.random() sabit olsa da 500 ID-nin hamısı fərqlidir', 'unikal: ' + set.size);
}

// ══════════════════════════════════════════════════════════════════════════
section('6. Xronoloji sıralanma (cedvel_id buna güvənir)');
{
  //  `getEmployeeShift` və `getCedvel` `cedvel_id` üzrə `order()` edir:
  //  təkrar sətirdə "sonuncu qalib" qaydası ID-nin sıralanmasından asılıdır.
  //  Vaxt möhürü kəsilmədiyi və `padStart` ilə sabit uzunluqda olduğu üçün
  //  leksikoqrafik sıra = xronoloji sıra.
  const anlar = [1_700_000_000_000, 1_800_000_000_000, 1_800_000_000_001,
                 1_900_000_000_000, 2_500_000_000_000];
  const idler = anlar.map(ms => atTime(ms, () => U.newId('C')));
  const sirali = [...idler].sort();
  ok(JSON.stringify(idler) === JSON.stringify(sirali),
     'ID-lər zaman sırası ilə leksikoqrafik sıralanır', idler.join('  '));

  // Vaxt hissəsi həmişə 8 simvoldur → uzunluq sürüşməsi sıranı pozmur.
  ok(idler.every(id => id.length === 1 + 8 + 6), 'vaxt hissəsi sabit uzunluqdadır (padStart)');

  // 2059-a qədər 8 simvol bəs edir; ondan sonra artacaq, amma sıra pozulmayacaq
  // (o vaxta qədər 9-cu simvol ƏLAVƏ olunur, kəsilmə yoxdur).
  ok(Math.pow(36, 8) > 2_800_000_000_000, '8 simvol 2059-cu ilə qədər bəs edir');
}

// ══════════════════════════════════════════════════════════════════════════
section('7. Kənar hallar (səhv `seq` ID-ni pozmur)');
{
  const t = 1_800_000_000_000;

  //  Sonlu OLMAYAN dəyər sıra nömrəsi ola bilməz. Bu, testin tapdığı səhvdir:
  //  `Infinity.toString(36)` → "Infinity", `NaN.toString(36)` → "NaN", yəni ID-nin
  //  içinə hərfi söz düşürdü. İndi belə dəyərdə sıra hissəsi sadəcə yazılmır.
  for (const bad of [null, undefined, NaN, Infinity, -Infinity, 'abc', {}]) {
    const id = atTime(t, () => U.newId('X', bad));
    ok(id.length === 1 + 8 + 6, `seq=${String(bad)} → sıra hissəsi yazılmır (${id})`);
  }
  for (const good of [0, 3, -3, 1.7, 41, 1295, 5000]) {
    const id = atTime(t, () => U.newId('X', good));
    ok(id.length >= 1 + 8 + 2 + 6 && /^X[0-9A-Z]+$/.test(id),
       `seq=${good} → düzgün ID (${id})`);
  }

  //  Ən vacibi: ID-nin İÇİNDƏ hərfi söz qalmasın.
  const zibil = [null, undefined, NaN, Infinity, -Infinity, 'abc', {}, [], 1e21]
    .map(v => atTime(t, () => U.newId('X', v)));
  ok(!zibil.some(id => /INFINITY|NAN|UNDEFINED|OBJECT|E\+/i.test(id)),
     'heç bir ID-nin içində hərfi söz yoxdur', zibil.join(' '));
}

// ══════════════════════════════════════════════════════════════════════════
section('8. server.js-də kəsilmiş vaxt möhürü qalmayıb');
{
  const src = require('fs').readFileSync(require('path').join(__dirname, 'server.js'), 'utf8');

  //  ID təyin edən sətirlərdə `Date.now()` OLMAMALIDIR — hamısı `U.newId`-dən keçir.
  //  (500 xətasındakı `ref` kodu ID deyil, loga istinaddır — o, sətir adı ilə
  //   `const ref =` olduğu üçün bu süzgəcə düşmür.)
  const idSetirler = src.split('\n').filter(l =>
    /\b([a-z_]*_id|[a-zA-Z]*Id|id)\s*[:=]\s*[^=]/.test(l) && /Date\.now\(\)/.test(l));
  ok(idSetirler.length === 0,
     'ID yaradan heç bir sətirdə birbaşa Date.now() yoxdur',
     idSetirler.join('\n      → '));

  //  Kəsilmiş vaxt möhürü — səhvin özü.
  const kesilmis = [...src.matchAll(/Date\.now\(\)\.toString\(36\)[^;\n]*\.slice\(\s*-/g)];
  const idKesilmis = kesilmis.filter(m => !/const ref\s*=/.test(
    src.slice(src.lastIndexOf('\n', m.index) + 1, m.index + 40)));
  ok(idKesilmis.length === 0,
     'ID-lərdə `Date.now().toString(36).slice(-n)` qalmayıb',
     idKesilmis.map(m => m[0]).join(' | '));

  ok((src.match(/U\.newId\(/g) || []).length >= 20,
     'kanonik generator hər yerdə işlədilir', (src.match(/U\.newId\(/g) || []).length + ' çağırış');
}

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(62)}`);
console.log(fail === 0
  ? `🎉  BÜTÜN TESTLƏR KEÇDİ  (${pass}/${pass})`
  : `❌  ${fail} TEST UĞURSUZ  (${pass}/${pass + fail} keçdi)`);
console.log(`${'═'.repeat(62)}\n`);
process.exit(fail === 0 ? 0 : 1);
