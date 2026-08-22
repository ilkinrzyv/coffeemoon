'use strict';
// ══════════════════════════════════════════════════════════════════════════
//  AY PƏNCƏRƏSİ ↔ MƏNTİQİ GÜN — UYĞUNLUQ TESTLƏRİ
// ══════════════════════════════════════════════════════════════════════════
//  Bu testlərin cavab verdiyi sual: "bu qeyd hansı aya aiddir?"
//  Sistem bu suala İKİ ayrı yerdə cavab verirdi və cavablar UYĞUN GƏLMİRDİ:
//
//    1. SQL süzgəci  — `gte('timestamp', '2026-08-01')`
//    2. Qruplaşdırma — `getLogicalYMD(d)` (gün 03:00-da kəsilir)
//
//  Postgres 1-ci variantı SESSİYA saat qurşağında (Supabase-də UTC) şərh edir.
//  Bakı UTC+4 olduğu üçün həmin sərhəd əslində yerli 04:00-a düşürdü, məntiqi
//  gün isə 03:00-da kəsilir. Uyğunsuzluq ayın 1-i 03:00–04:00 arasındakı BİR
//  SAATLIQ zolaqdır — və məhz orada gecə smeninin qeydləri olur. 1 avqust
//  03:30-da gələn işçi `getLogicalYMD`-ə görə AVQUSTA aid olsa da İYUL
//  sorğusuna düşürdü — avqust hesabatında YOX idi (F-07).
//
//  ⚠️ ƏSAS TEST 3-dədir: sərhəd ətrafındakı HƏR SAAT üçün iki cavabın eyni
//  olduğu yoxlanılır. Bu, konkret bir tarixi yox, QAYDANI qoruyur.
//
//      node test-period.js
// ══════════════════════════════════════════════════════════════════════════

process.env.TZ = process.env.TZ || 'Asia/Baku';

require.cache[require.resolve('./db')] = {
  id: require.resolve('./db'), filename: require.resolve('./db'), loaded: true,
  exports: { from: () => ({ select: () => ({}) }) },
};
const T = require('./tenant');
const U = require('./utils');

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else      { fail++; console.log(`  ✗ ${label}${detail ? '\n      → ' + detail : ''}`); }
}
const section = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 52 - t.length))}`);

// Gün kəsimi saatını dəyişmək üçün DISCIPLINE_CONFIG yazırıq
function seed(dayCutoffHour) {
  T.__testSeed({
    tenants:  [{ tenant_id: 'cm', name: 'Test', status: 'active', plan: 'pro' }],
    settings: dayCutoffHour === undefined ? [] : [
      { tenant_id: 'cm', key: 'DISCIPLINE_CONFIG', value: JSON.stringify({ dayCutoffHour }) },
    ],
  });
}
const inCm = (fn) => T.run({ tenantId: 'cm' }, fn);

console.log('\n══ AY PƏNCƏRƏSİ TESTLƏRİ ══');

// ══════════════════════════════════════════════════════════════════════════
section('1. İki forma qaytarılır');
seed(3);
inCm(() => {
  const p = U.ayPencere(2026, 8);
  ok(p.startYmd === '2026-08-01' && p.endYmd === '2026-09-01',
     'TEXT sütunlar üçün YMD sətri', p.startYmd + ' → ' + p.endYmd);
  // 03:00 Bakı = 23:00 əvvəlki gün UTC
  ok(p.startIso === '2026-07-31T23:00:00.000Z',
     'TIMESTAMPTZ üçün ISO — sərhəd gün kəsimindədir (03:00 Bakı)', p.startIso);
  ok(p.endIso === '2026-08-31T23:00:00.000Z', 'bitiş sərhədi də kəsim saatındadır', p.endIso);
  ok(p.startYmd !== p.startIso, 'iki forma QƏSDƏN fərqlidir — sütun tipləri fərqlidir');
});

// ══════════════════════════════════════════════════════════════════════════
section('2. Ay/il keçidi və yanlış giriş');
inCm(() => {
  const dek = U.ayPencere(2026, 12);
  ok(dek.endYmd === '2027-01-01', 'dekabr → yanvar (il artır)', dek.endYmd);
  ok(new Date(dek.endIso).getFullYear() === 2027, 'ISO-da da il artır');
  const yan = U.ayPencere(2026, 1);
  ok(yan.startYmd === '2026-01-01', 'yanvar düzgün başlayır');
  for (const [y, m] of [[2026, 0], [2026, 13], [0, 5], [NaN, 5], ['x', 'y'], [null, null]]) {
    if (U.ayPencere(y, m) !== null) { ok(false, `yanlış giriş null qaytarmalıdır: ${y}/${m}`); return; }
  }
  ok(true, 'yanlış ay/il üçün null qaytarılır');
});

// ══════════════════════════════════════════════════════════════════════════
section('3. ⚠️ ƏSAS: pəncərə ilə məntiqi gün EYNİ cavabı verir');
//  Sərhəd ətrafındakı hər saat üçün iki sual verilir:
//    (a) SQL pəncərəsi bu qeydi avqusta salırmı?
//    (b) `getLogicalYMD` bu qeydi avqusta salırmı?
//  Cavablar FƏRQLƏNSƏ, qeyd ya hesabatdan düşür, ya iki dəfə sayılır.
for (const kesim of [3, 0, 5]) {
  seed(kesim);
  inCm(() => {
    const p = U.ayPencere(2026, 8);
    const bas = new Date(p.startIso).getTime();
    const son = new Date(p.endIso).getTime();
    let ferqli = 0, yoxlanan = 0, numune = null;

    // İyul 31 00:00-dan avqust 2 00:00-a qədər hər 15 dəqiqə
    // + avqust 31 00:00-dan sentyabr 2 00:00-a qədər hər 15 dəqiqə
    const araliqlar = [
      [new Date(2026, 6, 31, 0, 0), new Date(2026, 7, 2, 0, 0)],
      [new Date(2026, 7, 31, 0, 0), new Date(2026, 8, 2, 0, 0)],
    ];
    for (const [a, b] of araliqlar) {
      for (let t = a.getTime(); t < b.getTime(); t += 15 * 60 * 1000) {
        const d = new Date(t);
        const pencereDaxil = t >= bas && t < son;              // (a) SQL cavabı
        const mentiqiAy    = U.getLogicalYMD(d).slice(0, 7);   // (b) qruplaşdırma cavabı
        const mentiqiDaxil = mentiqiAy === '2026-08';
        yoxlanan++;
        if (pencereDaxil !== mentiqiDaxil) {
          ferqli++;
          if (!numune) numune = `${d.toString().slice(0, 24)} → pəncərə:${pencereDaxil} məntiqi:${mentiqiDaxil}`;
        }
      }
    }
    ok(ferqli === 0,
       `kəsim ${String(kesim).padStart(2, '0')}:00 — ${yoxlanan} vaxt nöqtəsinin hamısında iki cavab EYNİDİR`,
       numune);
  });
}

// ══════════════════════════════════════════════════════════════════════════
section('4. Köhnə davranış həqiqətən səhv idi (reqressiya sübutu)');
seed(3);
inCm(() => {
  // ƏVVƏLKİ kod: `.gte('timestamp', '2026-08-01')` — UTC-də şərh olunur
  const kohneBas = new Date('2026-08-01T00:00:00.000Z').getTime();
  const p = new Date(U.ayPencere(2026, 8).startIso).getTime();
  ok(p !== kohneBas, 'yeni sərhəd köhnədən FƏRQLİDİR (yəni düzəliş real dəyişiklikdir)');
  // Fərq 1 saatdır, 4 yox: iki sürüşmə qismən bir-birini əvəz edir.
  //   UTC şərhi sərhədi 4 saat İRƏLİ (yerli 04:00-a) aparır,
  //   gün kəsimi isə 3 saat GERİ (yerli 03:00-a) çəkir → net 1 saat.
  // Yəni təsir zolağı ayın 1-i 03:00–04:00-dır. (İlk qiymətləndirməm 4 saat
  // idi — bu test onu düzəltdi.)
  ok(Math.round((kohneBas - p) / 3600000) === 1,
     'köhnə və yeni sərhəd arasındakı fərq 1 saatdır (03:00–04:00 zolağı)',
     'fərq: ' + ((kohneBas - p) / 3600000) + ' saat');

  // 1 avqust 03:30 Bakı — bu, hadisənin tam mərkəzindəki hal
  const gelis = new Date(2026, 7, 1, 3, 30);
  ok(U.getLogicalYMD(gelis) === '2026-08-01', 'məntiqi gün: 1 avqust');
  ok(gelis.getTime() >= p, 'YENİ pəncərə onu avqusta salır ✓');
  ok(gelis.getTime() < kohneBas, 'KÖHNƏ pəncərə onu avqustdan KƏNARDA saxlayırdı ✗');
});

// ══════════════════════════════════════════════════════════════════════════
section('5. Gecə smeni — gün sərhədinin hər iki tərəfi');
seed(3);
inCm(() => {
  const hallar = [
    [new Date(2026, 7, 1,  1, 0), '2026-07-31', 'avqust 1, 01:00 → iyul 31 (gecə smeni)'],
    [new Date(2026, 7, 1,  2, 59), '2026-07-31', 'avqust 1, 02:59 → hələ iyul 31'],
    [new Date(2026, 7, 1,  3, 0), '2026-08-01', 'avqust 1, 03:00 → avqust 1 (kəsim)'],
    [new Date(2026, 7, 1,  7, 30), '2026-08-01', 'avqust 1, 07:30 → avqust 1 (səhər smeni)'],
    [new Date(2026, 8, 1,  1, 0), '2026-08-31', 'sentyabr 1, 01:00 → avqust 31'],
  ];
  let hamisi = true;
  for (const [d, gozlenilen, ad] of hallar) {
    const alinan = U.getLogicalYMD(d);
    if (alinan !== gozlenilen) { hamisi = false; console.log(`      → ${ad}: ${alinan}`); }
  }
  ok(hamisi, 'məntiqi gün hər beş halda düzgündür');

  // Sentyabr 1, 01:00 → avqust 31 → AVQUST pəncərəsində olmalıdır
  const p = U.ayPencere(2026, 8);
  const t = new Date(2026, 8, 1, 1, 0).getTime();
  ok(t < new Date(p.endIso).getTime(), 'sentyabr 1 01:00 hələ AVQUST pəncərəsindədir');
});

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(62)}`);
console.log(fail === 0
  ? `🎉  BÜTÜN TESTLƏR KEÇDİ  (${pass}/${pass})`
  : `❌  ${fail} TEST UĞURSUZ  (${pass}/${pass + fail} keçdi)`);
console.log(`${'═'.repeat(62)}\n`);
process.exit(fail === 0 ? 0 : 1);
