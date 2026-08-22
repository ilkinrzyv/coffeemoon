'use strict';
// ══════════════════════════════════════════════════════════════════════════
//  SÜRƏT LİMİTİ TESTLƏRİ
// ══════════════════════════════════════════════════════════════════════════
//  Bu testlərin cavab verdiyi sual: "limit HƏM hücumu dayandırır, HƏM də
//  normal iş axınını buraxır?"
//
//  Səhvin qiyməti hər iki tərəfdə yüksəkdir:
//    · çox boş → PIN brute-force yenə mümkündür (F-05);
//    · çox sıx → bir filialın BÜTÜN işçiləri (hamısı eyni IP-dədir) səhər
//      növbəsində gəliş qeyd edə bilmir.
//  Ona görə sərhədlər dəqiq yoxlanılır: `limit`-inci cəhd KEÇMƏLİ,
//  `limit+1` DÜŞMƏLİDİR.
//
//  Vaxt yeridilir (`now` parametri) — heç bir gözləmə yoxdur.
//
//      node test-ratelimit.js
// ══════════════════════════════════════════════════════════════════════════

const RL = require('./ratelimit');

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else      { fail++; console.log(`  ✗ ${label}${detail ? '\n      → ' + detail : ''}`); }
}
const section = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 56 - t.length))}`);

console.log('\n══ SÜRƏT LİMİTİ TESTLƏRİ ══');

if (!RL.ENABLED) {
  console.error('\n💥  RATE_LIMIT=false mühitdədir — testlər mənasızdır. Dəyişəni silib təkrar işlət.');
  process.exit(1);
}

// ══════════════════════════════════════════════════════════════════════════
section('1. hit(): sərhəd dəqiq yerdədir');
RL.__reset();
{
  const T0 = 1_000_000;
  let sonuncuOk = true;
  for (let i = 1; i <= 5; i++) sonuncuOk = RL.hit('t', 'ip1', 5, 60_000, T0).ok;
  ok(sonuncuOk, '5 limitdə 5-ci cəhd KEÇİR');
  const altinci = RL.hit('t', 'ip1', 5, 60_000, T0);
  ok(!altinci.ok, '6-cı cəhd DÜŞÜR');
  ok(altinci.retryAfter === 60, 'retryAfter pəncərənin qalanını verir', String(altinci.retryAfter));
}

// ══════════════════════════════════════════════════════════════════════════
section('2. peek(): sayğacı ARTIRMIR');
RL.__reset();
{
  const T0 = 2_000_000;
  RL.hit('t', 'ip1', 3, 60_000, T0);            // n = 1
  for (let i = 0; i < 10; i++) RL.peek('t', 'ip1', 3, 60_000, T0);
  const r = RL.hit('t', 'ip1', 3, 60_000, T0);  // n = 2 olmalıdır, 12 yox
  ok(r.ok && r.used === 2, '10 peek-dən sonra sayğac hələ 2-dir', 'used=' + r.used);
}

// ══════════════════════════════════════════════════════════════════════════
section('3. peek() bloklanmanı hit()-dən ƏVVƏL görür');
RL.__reset();
{
  const T0 = 3_000_000;
  for (let i = 1; i <= 3; i++) RL.hit('pin', 'ip1', 3, 60_000, T0);
  ok(!RL.peek('pin', 'ip1', 3, 60_000, T0).ok,
     'limit dolduqdan sonra peek bloklayır (növbəti sorğu icra edilmir)');
  ok(RL.peek('pin', 'ip2', 3, 60_000, T0).ok, 'başqa IP təsirlənmir');
}

// ══════════════════════════════════════════════════════════════════════════
section('4. Pəncərə bitəndə sayğac sıfırlanır');
RL.__reset();
{
  const T0 = 4_000_000, PENCERE = 600_000;
  for (let i = 1; i <= 5; i++) RL.hit('t', 'ip1', 5, PENCERE, T0);
  ok(!RL.peek('t', 'ip1', 5, PENCERE, T0 + PENCERE - 1).ok, 'pəncərə bitməmiş hələ bloklu');
  ok(RL.peek('t', 'ip1', 5, PENCERE, T0 + PENCERE).ok, 'pəncərə bitən kimi açılır');
  const r = RL.hit('t', 'ip1', 5, PENCERE, T0 + PENCERE);
  ok(r.ok && r.used === 1, 'yeni pəncərədə sayğac 1-dən başlayır', 'used=' + r.used);
}

// ══════════════════════════════════════════════════════════════════════════
section('5. Bucket-lər bir-birinə qarışmır');
RL.__reset();
{
  const T0 = 5_000_000;
  for (let i = 1; i <= 5; i++) RL.hit('api', 'ip1', 5, 60_000, T0);
  ok(!RL.peek('api', 'ip1', 5, 60_000, T0).ok, 'api bucket-i doldu');
  ok(RL.peek('pin', 'ip1', 5, 60_000, T0).ok, 'eyni IP-nin pin bucket-i toxunulmamış qalıb');
}

// ══════════════════════════════════════════════════════════════════════════
section('6. Boş açar limitə düşmür (IP təyin edilməyibsə bloklamırıq)');
RL.__reset();
{
  const T0 = 6_000_000;
  let hamisiOk = true;
  for (let i = 0; i < 50; i++) if (!RL.hit('t', '', 5, 60_000, T0).ok) hamisiOk = false;
  ok(hamisiOk, 'boş açarla 50 çağırış da keçir');
  ok(RL.__size() === 0, 'boş açar üçün yaddaşda qeyd saxlanmır', 'size=' + RL.__size());
}

// ══════════════════════════════════════════════════════════════════════════
section('7. Yaddaş tavanı — Map sonsuz şişmir');
RL.__reset();
{
  const T0 = 7_000_000;
  // Vaxtı keçmiş qeydlərlə doldur, sonra təzələrini əlavə et
  for (let i = 0; i < RL.MAX_KEYS + 500; i++) RL.hit('t', 'kohne' + i, 100, 1000, T0);
  RL.hit('t', 'teze', 100, 60_000, T0 + 5000);   // köhnələr artıq vaxtı keçib
  ok(RL.__size() <= RL.MAX_KEYS + 1, `Map tavanda saxlanılır (${RL.__size()} ≤ ${RL.MAX_KEYS + 1})`);

  // Hamısı AKTİV olsa belə tavan gözlənilməlidir (real hücum ssenarisi)
  RL.__reset();
  for (let i = 0; i < RL.MAX_KEYS + 500; i++) RL.hit('t', 'aktiv' + i, 100, 600_000, T0);
  ok(RL.__size() <= RL.MAX_KEYS, `aktiv qeydlərdə də tavan işləyir (${RL.__size()} ≤ ${RL.MAX_KEYS})`);
}

// ══════════════════════════════════════════════════════════════════════════
section('8. Real ssenarilər (server.js-dəki hədlərlə)');
RL.__reset();
{
  const RATE = { apiPerMin: 600, publicPerMin: 60, pinFails: 30, pinWindowMs: 600_000 };
  const T0 = 8_000_000;

  // (a) Səhər növbəsi: 15 işçi, hər biri 2 dəfə skan edir (giriş + səhv cəhd yox).
  //     Hamısı EYNİ filial IP-sindədir. Bloklanmamalıdır.
  let bloklandi = false;
  for (let i = 0; i < 30; i++) if (!RL.hit('api', 'filial-ip', RATE.apiPerMin, 60_000, T0).ok) bloklandi = true;
  ok(!bloklandi, 'səhər növbəsi (30 skan / 1 dəq, tək IP) bloklanmır');

  // (b) Admin paneli açılışı: ~40 sorğu bir neçə saniyəyə
  bloklandi = false;
  for (let i = 0; i < 40; i++) if (!RL.hit('api', 'admin-ip', RATE.apiPerMin, 60_000, T0).ok) bloklandi = true;
  ok(!bloklandi, 'admin paneli açılışı (40 sorğu) bloklanmır');

  // (c) Filialda gün ərzində səhv PIN: 29 səhv cəhd hələ buraxılır
  //     (10 saniyəlik pəncərə səbəbindən vaxtı keçmiş kod normal haldır)
  for (let i = 0; i < 29; i++) RL.hit('pin', 'filial-ip', RATE.pinFails, RATE.pinWindowMs, T0);
  ok(RL.peek('pin', 'filial-ip', RATE.pinFails, RATE.pinWindowMs, T0).ok,
     '29 səhv PIN-dən sonra filial hələ işləyir');

  // (d) Brute-force: 30-cu səhvdən sonra qapı bağlanır
  RL.hit('pin', 'filial-ip', RATE.pinFails, RATE.pinWindowMs, T0);
  const bloklu = RL.peek('pin', 'filial-ip', RATE.pinFails, RATE.pinWindowMs, T0);
  ok(!bloklu.ok, '30 səhv PIN-dən sonra bloklanır');
  ok(bloklu.retryAfter > 0 && bloklu.retryAfter <= 600,
     'blok müddəti 10 dəqiqəni keçmir', String(bloklu.retryAfter));

  // (e) Hücumçunun saatda edə biləcəyi cəhd sayı — PIN sahəsinin (10 000) yanında
  const saatlıqCehd = RATE.pinFails * (3600_000 / RATE.pinWindowMs);
  ok(saatlıqCehd <= 200, `saatda ən çox ${saatlıqCehd} cəhd (limitsiz hal ilə müqayisədə minlərlə dəfə az)`);
}

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(62)}`);
console.log(fail === 0
  ? `🎉  BÜTÜN TESTLƏR KEÇDİ  (${pass}/${pass})`
  : `❌  ${fail} TEST UĞURSUZ  (${pass}/${pass + fail} keçdi)`);
console.log(`${'═'.repeat(62)}\n`);
process.exit(fail === 0 ? 0 : 1);
