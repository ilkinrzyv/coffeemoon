'use strict';
// ══════════════════════════════════════════════════════════════════
//  Maaş qaydalarının testi —  işlət:  node test-salary.js
// ══════════════════════════════════════════════════════════════════
//  Bu, insanların aldığı puldur — hər qayda ayrıca yoxlanılır.
//  Razılaşdırılmış qaydalar:
//   · 1 smen maaşı: Team Leader 23.33 · Barista/Cashier 20 · Cleaner 18.33
//   · Tam gün = 2 smen → maaş 2 qat
//   · Mövcud "Axşam Full" və "Səhər Full" = 1 smen (2 qat DEYİL)
//   · Taksi 7 AZN — yalnız Ağ Şəhər və Gənclik, yalnız Axşam / Axşam Full / Tam gün
//   · Taksi tam gündə də SABİT 7 (iki qat olmur)
// ══════════════════════════════════════════════════════════════════

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://test.local';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test';

const U = require('./utils');

let pass = 0, fail = 0;
function check(ok, label) { if (ok) pass++; else { fail++; console.log('  ✗ ' + label); } }
function pay(pos, dept, shift) { return U.computeDayPay(pos, dept, shift); }

// ── 1) Bir smen dərəcələri ──
console.log('1) Bir smen maaşı');
const GOZLENILEN = { 'Team Leader': 23.33, 'Barista': 20, 'Cashier': 20, 'Cleaner': 18.33 };
for (const [pos, mebleg] of Object.entries(GOZLENILEN)) {
  const r = pay(pos, 'Sahil', 'sehersm');
  check(r.pay === mebleg, `${pos}: gözlənilən ${mebleg}, alınan ${r.pay}`);
  check(r.shifts === 1, `${pos}: səhər smeni 1 smen olmalıdır`);
}

// ── 2) Tam gün = 2 qat ──
console.log('\n2) Tam gün iki qat');
for (const [pos, mebleg] of Object.entries(GOZLENILEN)) {
  const r = pay(pos, 'Sahil', 'tamgun');
  check(r.pay === U.round2(mebleg * 2), `${pos} tam gün: gözlənilən ${U.round2(mebleg * 2)}, alınan ${r.pay}`);
  check(r.shifts === 2, `${pos} tam gün 2 smen sayılmalıdır`);
}
check(pay('Team Leader', 'Sahil', 'tamgun').pay === 46.66, 'Team Leader tam gün 46.66 olmalıdır');
check(pay('Cleaner', 'Sahil', 'tamgun').pay === 36.66, 'Cleaner tam gün 36.66 olmalıdır');

// ── 3) Mövcud Full smenlər 1 smendir (2 qat DEYİL) ──
console.log('\n3) Axşam Full / Səhər Full = 1 smen');
for (const t of ['fullsm', 'seherfullsm']) {
  const r = pay('Barista', 'Sahil', t);
  check(r.pay === 20, `${t}: 20 olmalıdır (2 qat deyil), alınan ${r.pay}`);
  check(r.shifts === 1, `${t}: 1 smen olmalıdır`);
}

// ── 4) Taksi — filial şərti ──
console.log('\n4) Taksi: yalnız Ağ Şəhər və Gənclik');
for (const d of ['Ağ Şəhər', 'Gənclik']) {
  check(pay('Barista', d, 'axsamsm').taxi === 7, `${d} axşam → taksi 7 olmalıdır`);
}
for (const d of ['Elmlər', 'Sahil']) {
  check(pay('Barista', d, 'axsamsm').taxi === 0, `${d} axşam → taksi OLMAMALIDIR`);
  check(pay('Barista', d, 'tamgun').taxi === 0, `${d} tam gün → taksi OLMAMALIDIR`);
}

// ── 5) Taksi — smen şərti ──
console.log('\n5) Taksi: yalnız Axşam / Axşam Full / Tam gün');
const taksiVar = ['axsamsm', 'fullsm', 'tamgun'];
const taksiYox = ['sehersm', 'seherfullsm'];
for (const t of taksiVar) check(pay('Barista', 'Gənclik', t).taxi === 7, `Gənclik ${t} → taksi 7 olmalıdır`);
for (const t of taksiYox) check(pay('Barista', 'Gənclik', t).taxi === 0, `Gənclik ${t} → taksi OLMAMALIDIR`);

// ── 6) Taksi tam gündə iki qat OLMUR ──
console.log('\n6) Taksi tam gündə sabit qalır');
const tg = pay('Team Leader', 'Gənclik', 'tamgun');
check(tg.taxi === 7, `tam gün taksi 7 olmalıdır (2 qat deyil), alınan ${tg.taxi}`);
check(U.round2(tg.pay + tg.taxi) === 53.66, `Team Leader Gənclik tam gün cəmi 53.66 olmalıdır, alınan ${U.round2(tg.pay + tg.taxi)}`);

// ── 7) Vəzifəsi olmayan → 0 ──
console.log('\n7) Vəzifə təyin edilməyibsə');
check(pay('', 'Sahil', 'sehersm').pay === 0, 'vəzifəsiz işçi 0 maaş almalıdır');
check(pay('Naməlum Vəzifə', 'Sahil', 'tamgun').pay === 0, 'tanınmayan vəzifə 0 olmalıdır');
check(pay('', 'Gənclik', 'axsamsm').taxi === 7, 'vəzifəsiz olsa da taksi şərtə görə verilir');

// ── 8) İstirahət / boş gün ──
console.log('\n8) İstirahət və boş smen');
check(pay('Barista', 'Gənclik', 'istirahetsm').taxi === 0, 'istirahət günü taksi olmamalıdır');
check(pay('Barista', 'Gənclik', '').taxi === 0, 'smensiz gün taksi almamalıdır');
check(U.shiftMultiplier('istirahetsm') === 1, 'istirahət çoxaldıcısı 1 olmalıdır');

// ── 9) Tam gün saatları səhər+axşamdan hesablanır ──
console.log('\n9) Tam gün saatları');
const tgA = U.getShiftInfo('Gənclik', 'tamgun');     // A qrupu: 07:30 + axşam 16:00+9saat = 01:00
const tgB = U.getShiftInfo('Sahil', 'tamgun');       // B qrupu: 07:30 + axşam 15:00+8saat = 23:00
check(tgA && tgA.durH === 17.5, `Gənclik tam gün 17.5 saat olmalıdır, alınan ${tgA && tgA.durH}`);
check(tgB && tgB.durH === 15.5, `Sahil tam gün 15.5 saat olmalıdır, alınan ${tgB && tgB.durH}`);
check(tgA && tgA.label === 'Tam gün (07:30-01:00)', `Gənclik etiketi səhv: ${tgA && tgA.label}`);
check(tgB && tgB.label === 'Tam gün (07:30-23:00)', `Sahil etiketi səhv: ${tgB && tgB.label}`);
// Gecikmə həddi səhər smeni ilə eyni olmalıdır
check(U.getLateLimit('Sahil', 'tamgun', 8 * 60) === U.getLateLimit('Sahil', 'sehersm', 8 * 60),
  'tam günün gecikmə həddi səhər smeni ilə eyni olmalıdır');

// ── 10) Konfiqurasiya dəyişikliyi tətbiq olunur ──
console.log('\n10) Dərəcə dəyişikliyi');
U.setSetting('SALARY_CONFIG', JSON.stringify({
  rates: { 'Team Leader': 30, 'Barista': 25, 'Cashier': 25, 'Cleaner': 20 },
  taxi: 10, taxiDepts: ['Sahil'], taxiShifts: ['sehersm'],
})).catch(() => {});
check(pay('Barista', 'Sahil', 'sehersm').pay === 25, 'yeni dərəcə tətbiq olunmadı');
check(pay('Barista', 'Sahil', 'tamgun').pay === 50, 'yeni dərəcə tam gündə 2 qat olmadı');
check(pay('Barista', 'Sahil', 'sehersm').taxi === 10, 'yeni taksi qaydası tətbiq olunmadı');
check(pay('Barista', 'Gənclik', 'axsamsm').taxi === 0, 'köhnə taksi qaydası hələ işləyir');

// ── 11) Pozulmuş konfiqurasiya ──
console.log('\n11) Pozulmuş konfiqurasiyada geri dönüş');
U.setSetting('SALARY_CONFIG', '{pozuq json').catch(() => {});
check(pay('Team Leader', 'Sahil', 'sehersm').pay === 23.33, 'pozulmuş JSON-da ilkin dərəcəyə qayıtmır');
U.setSetting('SALARY_CONFIG', JSON.stringify({ rates: { 'Barista': 21 } })).catch(() => {});
check(pay('Barista', 'Sahil', 'sehersm').pay === 21, 'yarımçıq konfiqdə verilən dəyər işləmir');
check(pay('Cleaner', 'Sahil', 'sehersm').pay === 18.33, 'yarımçıq konfiqdə çatışmayan vəzifə ilkin dəyərlə tamamlanmır');
check(pay('Barista', 'Gənclik', 'axsamsm').taxi === 7, 'yarımçıq konfiqdə taksi ilkin qayda ilə işləməlidir');

// ── 12) Tutulma qaydaları (cərimə / avans) ──
console.log('\n12) Tutulma qaydaları');
U.setSetting('SALARY_CONFIG', '').catch(() => {});   // ilkin dəyərlərə qayıt
const d = U.getSalaryConfig();
check(d.fineStatuses.includes('unpaid'), 'ödənilməmiş cərimə defolt tutulmalıdır');
check(!d.fineStatuses.includes('paid'), 'ödənilmiş cərimə defolt tutulmamalıdır');
check(!d.fineStatuses.includes('waived'), 'BAĞIŞLANMIŞ cərimə heç vaxt tutulmamalıdır');
check(d.avansStatuses.includes('approved') && d.avansStatuses.includes('paid'), 'təsdiqlənmiş+ödənilmiş avans tutulmalıdır');
check(!d.avansStatuses.includes('pending') && !d.avansStatuses.includes('rejected'), 'gözləyən/rədd edilən avans tutulmamalıdır');
check(d.mgrFinesOnlyAcked === false, 'menecer cəriməsi defolt olaraq hamısı tutulur');

// Net hesab: brüt − cərimə − avans
console.log('\n13) Net ödəniş riyaziyyatı');
const g1 = U.computeDayPay('Team Leader', 'Gənclik', 'tamgun');   // 46.66 + 7
const brut = U.round2(g1.pay + g1.taxi);
check(brut === 53.66, `brüt 53.66 olmalıdır, alınan ${brut}`);
check(U.round2(brut - 30 - 150) === -126.34, 'tutulma brütdən çox olsa MƏNFİ çıxmalıdır (borc)');
check(U.round2(brut - 30) === 23.66, 'cərimə çıxılması səhvdir');

// ── 14) Taksi limiti ──
console.log('\n14) Aylıq taksi limiti');
U.setSetting('SALARY_CONFIG', '').catch(() => {});
const c0 = U.getSalaryConfig();
check(c0.taxiMonthlyLimit === 13, `ümumi limit 13 olmalıdır, alınan ${c0.taxiMonthlyLimit}`);
check(U.taxiLimitFor(null, c0) === 13, 'fərdi limit yoxdursa ümumi limit işləməlidir');
check(U.taxiLimitFor(undefined, c0) === 13, 'undefined → ümumi limit');
check(U.taxiLimitFor('', c0) === 13, 'boş sətir → ümumi limit');
check(U.taxiLimitFor(20, c0) === 20, 'fərdi limit üstün olmalıdır');
check(U.taxiLimitFor(0, c0) === 0, 'fərdi limit 0 olsa taksi ümumiyyətlə verilməməlidir');

// Hansı günlər limitə sayılır
console.log('\n15) Limitə hansı günlər sayılır');
check(U.isTaxiDay('Gənclik', 'axsamsm', c0) === true, 'Gənclik axşam taksili gündür');
check(U.isTaxiDay('Gənclik', 'tamgun', c0) === true, 'Gənclik tam gün taksili gündür');
check(U.isTaxiDay('Gənclik', 'fullsm', c0) === true, 'Gənclik Axşam Full taksili gündür');
check(U.isTaxiDay('Gənclik', 'sehersm', c0) === false, 'səhər smeni limitə sayılmamalıdır');
check(U.isTaxiDay('Sahil', 'axsamsm', c0) === false, 'taksisiz filialda limit tətbiq olunmamalıdır');
check(U.isTaxiDay('Elmlər', 'tamgun', c0) === false, 'Elmlərdə tam gün də taksisizdir');

// Limit aşımı simulyasiyası (hesabatdakı məntiqin eynisi)
console.log('\n16) Limitdən sonrakı günlər taksi qazanmır');
function ayHesabla(gunSayi, limit) {
  let taksi = 0, verildi = 0, kesildi = 0;
  for (let i = 0; i < gunSayi; i++) {
    const g = U.computeDayPay('Barista', 'Gənclik', 'axsamsm', c0);
    if (g.taxi > 0) { if (verildi >= limit) kesildi++; else { verildi++; taksi += g.taxi; } }
  }
  return { taksi: U.round2(taksi), verildi, kesildi };
}
const a13 = ayHesabla(13, 13);
check(a13.taksi === 91 && a13.kesildi === 0, `13 gün → 91 ₼, kəsilmə yox (alınan ${a13.taksi}, ${a13.kesildi})`);
const a16 = ayHesabla(16, 13);
check(a16.taksi === 91, `16 gün → yenə 91 ₼ olmalıdır, alınan ${a16.taksi}`);
check(a16.verildi === 13 && a16.kesildi === 3, `16 gündə 13 ödənməli, 3 kəsilməli (alınan ${a16.verildi}/${a16.kesildi})`);
const a20 = ayHesabla(20, 20);
check(a20.taksi === 140, `fərdi limit 20 olsa 140 ₼ olmalıdır, alınan ${a20.taksi}`);

// ── 17) Həftə kilidi ──
console.log('\n17) Keçmiş həftə kilidi');
check(U.weekStartYMD(new Date(2026, 6, 30)) === '2026-07-27', `30 İyul 2026 (cümə axşamı) həftə başı 27 İyul olmalıdır, alınan ${U.weekStartYMD(new Date(2026, 6, 30))}`);
check(U.weekStartYMD(new Date(2026, 6, 27)) === '2026-07-27', 'bazar ertəsinin özü həftə başıdır');
check(U.weekStartYMD(new Date(2026, 7, 2)) === '2026-07-27', 'bazar günü (2 Avqust) hələ həmin həftəyə aiddir');
check(U.weekStartYMD(new Date(2026, 7, 3)) === '2026-08-03', 'növbəti bazar ertəsi yeni həftədir');
// Kilid şərti: tarix < həftə başı → menecerə qadağa
const hb = U.weekStartYMD(new Date(2026, 6, 30));
check('2026-07-26' < hb, 'ötən həftənin günü kilidlənməlidir');
check(!('2026-07-27' < hb), 'cari həftənin ilk günü açıq olmalıdır');
check(!('2026-08-05' < hb), 'gələcək tarixlər açıq olmalıdır');

console.log(`\n${'═'.repeat(50)}\nNƏTİCƏ: ${pass} keçdi, ${fail} uğursuz`);
process.exit(fail ? 1 : 0);
