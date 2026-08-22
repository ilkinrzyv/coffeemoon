'use strict';
// ══════════════════════════════════════════════════════════════════════════
//  AÇAR GENERATORU — TESTLƏR
// ══════════════════════════════════════════════════════════════════════════
//  Bu testlərin cavab verdiyi sual: "açarı təxmin etmək olarmı?"
//
//  Tarixçə (F-03): açarlar `Math.random()` ilə yaradılırdı. V8-in generatoru
//  kriptoqrafik deyil — daxili vəziyyəti bir neçə ardıcıl çıxışdan geri
//  hesablana bilir. Çox-müştərili sistemdə bu konkret hücum idi: zərərli bir
//  müştəri admini `regenerateAdminKey`-i ardıcıl çağırıb nümunə toplayır,
//  vəziyyəti bərpa edir və eyni proses daxilində BAŞQA müştərilər üçün verilən
//  açarları qabaqcadan hesablayır.
//
//  ⚠️ ƏSAS TEST 2-dədir: `Math.random()` süni şəkildə SABİT edilir. Generator
//  ondan asılı olsaydı bütün açarlar eyni çıxardı. Yəni bu test geriyə
//  sürüşməni (kimsə yenidən `Math.random()` yazsa) həqiqətən tutur.
//
//      node test-keys.js
// ══════════════════════════════════════════════════════════════════════════

// tenant.js `./db`-ni require edir → Supabase açarları tələb olunmasın deyə taxta.
require.cache[require.resolve('./db')] = {
  id: require.resolve('./db'), filename: require.resolve('./db'), loaded: true,
  exports: { from: () => ({ select: () => ({}) }) },
};
const T = require('./tenant');

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else      { fail++; console.log(`  ✗ ${label}${detail ? '\n      → ' + detail : ''}`); }
}
const section = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 54 - t.length))}`);

console.log('\n══ AÇAR GENERATORU TESTLƏRİ ══');

// ══════════════════════════════════════════════════════════════════════════
section('1. Format və uzunluq');
{
  const k = T.randomKey('AK');
  ok(k.startsWith('AK'), 'prefiks qorunur', k);
  ok(k.length === 18, 'panel açarı 18 simvoldur (2 prefiks + 16)', 'uzunluq=' + k.length);
  ok(T.randomKey('E', 17).length === 18, 'işçi secret-i 18 simvoldur', String(T.randomKey('E', 17).length));
  ok(T.randomToken(12).length === 12, 'randomToken istənilən uzunluğu verir');
  ok(T.randomKey('').length === 16, 'prefikssiz də işləyir');
}

// ══════════════════════════════════════════════════════════════════════════
section('2. ⚠️ Math.random()-dan ASILI DEYİL (F-03-ün özü)');
{
  const original = Math.random;
  Math.random = () => 0.42;           // tam sabit — köhnə generator eyni açar verərdi
  let acarlar;
  try {
    acarlar = new Set();
    for (let i = 0; i < 200; i++) acarlar.add(T.randomKey('AK'));
  } finally {
    Math.random = original;
  }
  ok(acarlar.size === 200,
     'Math.random() sabit olsa da 200 açarın hamısı FƏRQLİDİR',
     'unikal: ' + acarlar.size + '/200');
}

// ══════════════════════════════════════════════════════════════════════════
section('3. Təkrarlanma yoxdur');
{
  const N = 20000;
  const set = new Set();
  for (let i = 0; i < N; i++) set.add(T.randomKey('SK'));
  ok(set.size === N, `${N} açarın hamısı unikaldır`, 'unikal: ' + set.size);
}

// ══════════════════════════════════════════════════════════════════════════
section('4. Əlifba və paylanma');
{
  const ELIFBA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const say = {};
  let kenar = null;
  for (let i = 0; i < 5000; i++) {
    for (const ch of T.randomToken(16)) {
      if (!ELIFBA.includes(ch)) kenar = ch;
      say[ch] = (say[ch] || 0) + 1;
    }
  }
  ok(!kenar, 'yalnız gözlənilən 32 simvol işlədilir', kenar && 'kənar simvol: ' + kenar);
  ok(Object.keys(say).length === 32, '32 simvolun HAMISI istifadə olunur', 'görünən: ' + Object.keys(say).length);
  ok(!/[IO]/.test(ELIFBA), '`I` və `O` yoxdur (əl ilə köçürəndə 1/0 ilə qarışmasın)');

  // Modulo sürüşməsi olsaydı bəzi simvollar sistematik olaraq daha tez düşərdi.
  // 80 000 simvol / 32 = orta 2500. ±25% aralığı təsadüfi dalğalanma üçün genişdir,
  // amma sürüşməni (məs. bəzi simvolların 2 qat çox düşməsi) tutmağa kifayətdir.
  const deyerler = Object.values(say);
  const orta = deyerler.reduce((a, b) => a + b, 0) / deyerler.length;
  const min = Math.min(...deyerler), max = Math.max(...deyerler);
  ok(min > orta * 0.75 && max < orta * 1.25,
     'paylanma bərabərdir (modulo sürüşməsi yoxdur)',
     `orta ${Math.round(orta)}, min ${min}, max ${max}`);
}

// ══════════════════════════════════════════════════════════════════════════
section('5. Kənar hallar');
{
  // ⚠️ Bunlar sadəcə «kənar hal» deyil — səhv dəyər QISA açar verməməlidir.
  //    İlk yazılışda `Math.max(1, …)` vardı və mənfi dəyər 1 simvollu açar
  //    qaytarırdı; testi yazanda tutuldu.
  ok(T.randomToken(0).length     === 16,  '0 → ilkin uzunluğa (16) düşür');
  ok(T.randomToken(-5).length    === 16,  'mənfi dəyər ilkin uzunluğa düşür');
  ok(T.randomToken(3).length     === 16,  'həddən qısa dəyər (3) ilkin uzunluğa düşür');
  ok(T.randomToken(NaN).length   === 16,  'NaN ilkin uzunluğa düşür');
  ok(T.randomToken(null).length  === 16,  'null ilkin uzunluğa düşür');
  ok(T.randomToken('abc').length === 16,  'rəqəm olmayan dəyər ilkin uzunluğa düşür');
  ok(T.randomToken(500).length   === 128, 'çox böyük dəyər 128-ə kəsilir');
  // Ən vacibi: HEÇ BİR giriş 8 simvoldan qısa açar verə bilməz.
  let enQisa = 99;
  for (const v of [0, -1, -999, 1, 3, 7, NaN, null, undefined, '', 'x', {}, [], Infinity, -Infinity])
    enQisa = Math.min(enQisa, T.randomToken(v).length);
  ok(enQisa >= 8, 'heç bir giriş 8 simvoldan qısa açar verə bilmir', 'ən qısa: ' + enQisa);
}

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(62)}`);
console.log(fail === 0
  ? `🎉  BÜTÜN TESTLƏR KEÇDİ  (${pass}/${pass})`
  : `❌  ${fail} TEST UĞURSUZ  (${pass}/${pass + fail} keçdi)`);
console.log(`${'═'.repeat(62)}\n`);
process.exit(fail === 0 ? 0 : 1);
