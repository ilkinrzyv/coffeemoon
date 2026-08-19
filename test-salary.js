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

// SALARY — Coffeemoon-un razılaşdırılmış dərəcələri. Əvvəl bunlar
// `utils.DEFAULT_SALARY`-də idi; indi ilkin dəyərlər neytraldır (yeni müştəri
// üçün 0) və konkret rəqəmlər müştərinin konfiqurasiyasından gəlir.
const { enterTenant, setLocal, SALARY } = require('./test-helpers');
enterTenant();   // müştəri kontekstini qur (filiallar, vəzifələr, parametrlər)
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
setLocal('SALARY_CONFIG', JSON.stringify({
  rates: { 'Team Leader': 30, 'Barista': 25, 'Cashier': 25, 'Cleaner': 20 },
  taxi: 10, taxiDepts: ['Sahil'], taxiShifts: ['sehersm'],
}));
check(pay('Barista', 'Sahil', 'sehersm').pay === 25, 'yeni dərəcə tətbiq olunmadı');
check(pay('Barista', 'Sahil', 'tamgun').pay === 50, 'yeni dərəcə tam gündə 2 qat olmadı');
check(pay('Barista', 'Sahil', 'sehersm').taxi === 10, 'yeni taksi qaydası tətbiq olunmadı');
check(pay('Barista', 'Gənclik', 'axsamsm').taxi === 0, 'köhnə taksi qaydası hələ işləyir');

// ── 11) Pozulmuş konfiqurasiya ──
//  DAVRANIŞ DƏYİŞİB (çox-müştəriliyə keçiddən sonra):
//  Əvvəl `DEFAULT_SALARY` Coffeemoon-un dərəcələrini (Barista 20 və s.) və
//  taksili filiallarını saxlayırdı — yəni konfiqurasiya pozulsa sistem HƏMİN
//  rəqəmləri "uydururdu". Çox müştəri olanda bu təhlükəlidir: bir restoranın
//  dərəcələri başqasına yazılardı.
//  İndi ilkin dəyərlər NEYTRALdır (0). Konfiqurasiya pozulsa maaş 0 çıxır —
//  gözə dərhal dəyir və admin düzəldir. Səhv rəqəmlə ödəniş etməkdənsə
//  görünən sıfır daha təhlükəsizdir.
console.log('\n11) Pozulmuş konfiqurasiyada geri dönüş');
setLocal('SALARY_CONFIG', '{pozuq json');
check(pay('Team Leader', 'Sahil', 'sehersm').pay === 0, 'pozulmuş JSON-da dərəcə uydurulur (0 olmalıdır)');
check(pay('Barista', 'Gənclik', 'axsamsm').taxi === 0, 'pozulmuş JSON-da taksi uydurulur (0 olmalıdır)');
setLocal('SALARY_CONFIG', JSON.stringify({ rates: { 'Barista': 21 } }));
check(pay('Barista', 'Sahil', 'sehersm').pay === 21, 'yarımçıq konfiqdə verilən dəyər işləmir');
check(pay('Cleaner', 'Sahil', 'sehersm').pay === 0, 'təyin edilməmiş vəzifə 0 qaytarmalıdır');

// ── 12) Tutulma qaydaları (cərimə / avans) ──
console.log('\n12) Tutulma qaydaları');
setLocal('SALARY_CONFIG', JSON.stringify(SALARY));   // ilkin dəyərlərə qayıt
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
setLocal('SALARY_CONFIG', JSON.stringify(SALARY));
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

// ── 18) İstirahət günü ödənişi ──
console.log('\n18) İstirahət günü ödənilir');
setLocal('SALARY_CONFIG', JSON.stringify(SALARY));
const cr = U.getSalaryConfig();
check(cr.restDayPaid === true, 'istirahət günü defolt ÖDƏNİLMƏLİDİR');
check(cr.restDayMultiplier === 1, 'defolt əmsal 1 (tam smen maaşı) olmalıdır');
for (const [pos, mebleg] of Object.entries(GOZLENILEN)) {
  const r = U.computeRestDayPay(pos, cr);
  check(r.pay === mebleg, `${pos} istirahət: gözlənilən ${mebleg}, alınan ${r.pay}`);
  check(r.taxi === 0, `${pos} istirahət günü TAKSİ ALMAMALIDIR`);
  check(r.shifts === 0, `${pos} istirahət günü işlənmiş smen sayılmamalıdır`);
}
check(U.computeRestDayPay('', cr).pay === 0, 'vəzifəsiz işçi istirahətdə də 0 alır');

// Əmsal
console.log('\n19) İstirahət əmsalı');
// Dərəcələr konfiqurasiyada açıq verilir: ilkin dəyərlər artıq neytraldır (0),
// yəni yalnız əmsalı yazsaq maaş 0 çıxardı və test əmsalı yox, boşluğu ölçərdi.
const withRates = (patch) => JSON.stringify({ rates: SALARY.rates, ...patch });
setLocal('SALARY_CONFIG', withRates({ restDayMultiplier: 0.5 }));
check(U.computeRestDayPay('Barista').pay === 10, `əmsal 0.5 → 10 ₼ olmalıdır, alınan ${U.computeRestDayPay('Barista').pay}`);
check(U.computeRestDayPay('Team Leader').pay === 11.67, `Team Leader yarım → 11.67, alınan ${U.computeRestDayPay('Team Leader').pay}`);
setLocal('SALARY_CONFIG', withRates({ restDayPaid: false }));
check(U.computeRestDayPay('Barista').pay === 0, 'söndürüləndə istirahət ödənilməməlidir');
setLocal('SALARY_CONFIG', withRates({ restDayMultiplier: 5 }));
check(U.computeRestDayPay('Barista').pay === 20, 'həddi aşan əmsal (5) ilkin dəyərə (1) qayıtmalıdır');

// İş günü ilə istirahət qarışmamalıdır
console.log('\n20) İş günü / istirahət ayrılığı');
setLocal('SALARY_CONFIG', JSON.stringify(SALARY));
check(U.computeDayPay('Barista', 'Gənclik', 'istirahetsm').pay === 20,
  'computeDayPay istirahət tipini ADİ gün kimi hesablayır — hesabatda computeRestDayPay işlədilməlidir');
check(U.computeDayPay('Barista', 'Gənclik', 'istirahetsm').taxi === 0, 'istirahət günü heç bir halda taksi almamalıdır');

// Keş zəhərlənməsi — qaytarılan konfiqurasiya dəyişdirilsə sonrakı çağırışlar təmiz qalmalıdır
console.log('\n21) Konfiqurasiya keşi referans paylaşmır');
setLocal('SALARY_CONFIG', JSON.stringify({ rates: { 'Barista': 20 }, taxi: 7 }));
const c1 = U.getSalaryConfig();
c1.rates.Barista = 999; c1.taxi = 999; c1.taxiDepts.push('ZIBIL');
const c2 = U.getSalaryConfig();
check(c2.rates.Barista === 20, `keş zəhərləndi — dərəcə 20 olmalıdır, alınan ${c2.rates.Barista}`);
check(c2.taxi === 7, `keş zəhərləndi — taksi 7 olmalıdır, alınan ${c2.taxi}`);
check(c2.taxiDepts.indexOf('ZIBIL') < 0, 'keş zəhərləndi — massivə əlavə edilən filial qaldı');
check(U.computeDayPay('Barista', 'Sahil', 'sehersm').pay === 20, 'zəhərlənmiş keş maaş hesabına sızdı');
setLocal('SALARY_CONFIG', JSON.stringify(SALARY));

// ── 22) İstirahət gününün aylıq tavanı ──
// İstirahət günü GƏLİŞ tələb etmir və cədvəli menecer yazır → tavan olmasa bütün ay
// istirahət yazılıb işləmədən tam maaş almaq olardı.
console.log('\n22) İstirahət günü aylıq tavanı');
setLocal('SALARY_CONFIG', JSON.stringify(SALARY));
const ci = U.getSalaryConfig();
check(ci.restDayMonthlyLimit === 12, `defolt tavan 12 olmalıdır, alınan ${ci.restDayMonthlyLimit}`);

// getSalaryReport-dakı istirahət döngüsünün eynisi (tarix sırası ilə, tavana qədər ödənilir)
function istirahetHesabla(gunSayi, cfg) {
  let odenildi = 0, kesildi = 0, maas = 0;
  for (let i = 0; i < gunSayi; i++) {
    const g = U.computeRestDayPay('Barista', cfg);
    if (g.pay <= 0 && !cfg.restDayPaid) continue;
    if (odenildi >= cfg.restDayMonthlyLimit) { kesildi++; continue; }
    odenildi++; maas += g.pay;
  }
  return { odenildi, kesildi, maas: U.round2(maas) };
}
const i8 = istirahetHesabla(8, ci);
check(i8.odenildi === 8 && i8.kesildi === 0, `normal ay (8 istirahət) tam ödənilməlidir, alınan ${i8.odenildi}/${i8.kesildi}`);
check(i8.maas === 160, `8 gün × 20 ₼ = 160 ₼ olmalıdır, alınan ${i8.maas}`);
const i12 = istirahetHesabla(12, ci);
check(i12.kesildi === 0, 'tavanın tam özü (12) hələ kəsilməməlidir');
const i30 = istirahetHesabla(30, ci);
check(i30.odenildi === 12 && i30.kesildi === 18, `bütün ay istirahətdə 12 ödənməli, 18 kəsilməli, alınan ${i30.odenildi}/${i30.kesildi}`);
check(i30.maas === 240, `bütün ay istirahət yazılsa da yalnız 240 ₼ ödənilməlidir, alınan ${i30.maas}`);

// Tavanın konfiqurasiyası
setLocal('SALARY_CONFIG', JSON.stringify({ restDayMonthlyLimit: 5 }));
check(U.getSalaryConfig().restDayMonthlyLimit === 5, 'verilən tavan tətbiq olunmur');
setLocal('SALARY_CONFIG', JSON.stringify({ restDayMonthlyLimit: 99 }));
check(U.getSalaryConfig().restDayMonthlyLimit === 12, 'həddi aşan tavan (99) ilkin dəyərə qayıtmalıdır');
setLocal('SALARY_CONFIG', JSON.stringify({ restDayMonthlyLimit: -1 }));
check(U.getSalaryConfig().restDayMonthlyLimit === 12, 'mənfi tavan ilkin dəyərə qayıtmalıdır');
setLocal('SALARY_CONFIG', JSON.stringify({ restDayMonthlyLimit: 31 }));
check(istirahetHesabla(31, U.getSalaryConfig()).kesildi === 0, 'tavan 31 = limitsiz olmalıdır');
setLocal('SALARY_CONFIG', JSON.stringify({ restDayMonthlyLimit: 0 }));
const i0 = istirahetHesabla(5, U.getSalaryConfig());
check(i0.odenildi === 0 && i0.maas === 0, 'tavan 0-da heç bir istirahət günü ödənilməməlidir');
setLocal('SALARY_CONFIG', JSON.stringify(SALARY));

// ── 23) Avans hansı aya tutulur ──
// Pul qərar anında verilir. Tələb tarixi ilə bağlasaq, iyulda istənib avqustda
// təsdiqlənən avans artıq ödənilmiş iyula düşür və tutulma İTİR.
console.log('\n23) Avans qərar ayına tutulur');
const IYUL = ['2026-07-01', '2026-08-01'], AVQ = ['2026-08-01', '2026-09-01'];
const av = (id, teleb, qerar) => ({ avans_id: id, emp_id: 'E1', amount: 50, status: 'approved', date_str: teleb, decided_ymd: qerar });

check(U.avansAitYMD(av('A', '2026-07-31', '2026-08-02')) === '2026-08-02', 'qərar günü varsa o üstün olmalıdır');
check(U.avansAitYMD(av('A', '2026-07-31', null)) === '2026-07-31', 'qərar günü yoxdursa tələb günü işlədilməlidir');
check(U.avansAitYMD(null) === '', 'boş sətir çökdürməməlidir');

// Əsas ssenari: 31 iyulda istənib 2 avqustda təsdiqlənən avans
const gec = av('AV-GEC', '2026-07-31', '2026-08-02');
check(U.pickAvansForMonth([gec], ...IYUL).length === 0, 'gec təsdiqlənən avans hələ İYULA tutulur — pul itir');
check(U.pickAvansForMonth([gec], ...AVQ).length === 1, 'gec təsdiqlənən avans AVQUSTA düşmür');

// Köhnə sətirlər (miqrasiyadan əvvəl) — davranış DƏYİŞMƏMƏLİDİR
const kohne = { avans_id: 'AV-KOHNE', emp_id: 'E1', amount: 40, status: 'approved', date_str: '2026-07-15' };
check(U.pickAvansForMonth([kohne], ...IYUL).length === 1, 'qərar günü olmayan köhnə avans öz ayında qalmalıdır');
check(U.pickAvansForMonth([kohne], ...AVQ).length === 0, 'köhnə avans başqa aya sürüşməməlidir');

// İki sorğunun birləşməsi: eyni sətir hər ikisindən gəlsə də BİR dəfə sayılmalıdır
const ikiqat = U.pickAvansForMonth([gec, gec, { ...gec }], ...AVQ);
check(ikiqat.length === 1, `təkrar sətir ikiqat tutulur — alınan ${ikiqat.length}`);

// Eyni ay içində qərar verilən adi avans
const adi = av('AV-ADI', '2026-08-05', '2026-08-06');
check(U.pickAvansForMonth([adi], ...AVQ).length === 1, 'adi avans öz ayında tutulmalıdır');
check(U.pickAvansForMonth([adi], ...IYUL).length === 0, 'adi avans keçmiş aya düşməməlidir');

// Qarışıq dəst — heç nə itməsin, heç nə ikiqat olmasın
const hamisi = [gec, kohne, adi];
const cem = U.pickAvansForMonth(hamisi, ...IYUL).length + U.pickAvansForMonth(hamisi, ...AVQ).length;
check(cem === 3, `hər avans dəqiq bir aya düşməlidir — alınan ${cem}/3`);
check(U.pickAvansForMonth([], ...AVQ).length === 0, 'boş siyahı çökdürməməlidir');
check(U.pickAvansForMonth(null, ...AVQ).length === 0, 'null siyahı çökdürməməlidir');

console.log(`\n${'═'.repeat(50)}\nNƏTİCƏ: ${pass} keçdi, ${fail} uğursuz`);
process.exit(fail ? 1 : 0);
