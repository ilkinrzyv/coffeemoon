'use strict';
// ══════════════════════════════════════════════════════════════════════════
//  YARIŞ · SORĞU SAYI · AÇARSIZ SPAM  (F-24, F-22, F-19)
// ══════════════════════════════════════════════════════════════════════════
//  Üçü də «xəta vermir, sadəcə pisdir» sinfindəndir — ona görə testlər
//  DAVRANIŞI yox, ÖLÇÜNÜ yoxlayır: neçə sorğu getdi, neçə bal itdi, neçə
//  bildiriş çıxdı.
//
//  ⚠️ ƏSAS TESTLƏR:
//    §1 — iki XP hadisəsi eyni anda gəlsə HEÇ BİRİ itmir (F-24).
//    §2 — kartın açılışı 14 artıq sorğu atmır (F-22).
//    §3 — açarsız cihaz qeydiyyatı sonsuz sətir/bildiriş yaratmır (F-19).
//
//      node test-perf.js
// ══════════════════════════════════════════════════════════════════════════

process.env.TZ = process.env.TZ || 'Asia/Baku';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://test.local';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test';

const fake = require('./test-fakedb').install();
const T = require('./tenant');
const U = require('./utils');
const ratelimit = require('./ratelimit');
const { API } = require('./server');

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else      { fail++; console.log(`  ✗ ${label}${detail ? '\n      → ' + detail : ''}`); }
}
const section = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 52 - t.length))}`);

T.__testSeed({
  tenants:  [{ tenant_id: 'cm', name: 'Test', status: 'active', plan: 'pro',
               brand: { displayName: 'Test' } }],
  branches: [{ tenant_id: 'cm', branch_id: 'elmler', name: 'Elmlər', active: true, sort_order: 0 }],
  positions:[{ tenant_id: 'cm', name: 'Barista', active: true, sort_order: 0 }],
  authKeys: [{ key: 'TK-CM', tenant_id: 'cm', role: 'trainer', branch_id: null }],
});
//  XP-ni real yolla veririk: `giveManualXP` → `awardXP`. Daxili funksiyanı
//  ixrac etmək əvəzinə həqiqi API çağırılır, yəni test real axını yoxlayır.
const XP = (id, n) => API.giveManualXP('TK-CM', id, n);
const inCm = (fn) => T.run({ tenantId: 'cm', role: 'admin', branchId: null }, fn);
const emp = (id) => (fake.store.employees || []).find(e => e.id === id);

//  Sorğu sayğacı — `./db`-nin `from`-unu sarıyırıq (taxta bazanın özünü yox).
function sayğac() {
  const sb = require('./db');
  const orig = sb.from;
  const say = { n: 0, cedvel: 0 };
  sb.from = (t) => { say.n++; if (t === 'cedvel') say.cedvel++; return orig(t); };
  say.bitir = () => { sb.from = orig; return say; };
  return say;
}

console.log('\n══ PERFORMANS / YARIŞ TESTLƏRİ ══');

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('1. ⚠️ F-24 — paralel XP itmir');
{
  const bir = () => ({ employees: [{ tenant_id: 'cm', id: 'E1', name: 'Aysel', dept: 'Elmlər', secret: 'S1', xp: 0, streak: 0 }],
                       xp_audit_log: [], push_subscriptions: [], settings: [] });
  fake.reset(bir());

  ok(emp('E1').xp === 0, 'başlanğıc 0');

  //  ⚠️ PARALEL: köhnə kodda ikisi də eyni köhnə dəyəri oxuyub bir-birinin
  //  üstündən yazırdı → 100 yerinə 50 qalırdı. Sakit itki.
  fake.reset({ employees: [{ tenant_id: 'cm', id: 'E1', name: 'Aysel', dept: 'Elmlər', secret: 'S1', xp: 0, streak: 0 }] });
  fake.reset(bir());
  await inCm(() => Promise.all([XP('E1', 50), XP('E1', 50)]));
  ok(emp('E1').xp === 100, 'iki paralel mükafatın HƏR İKİSİ sayıldı (50+50)', 'xp=' + emp('E1').xp);

  //  Beş paralel
  fake.reset(bir());
  await inCm(() => Promise.all([1,2,3,4,5].map(() => XP('E1', 10))));
  ok(emp('E1').xp === 50, 'beş paralel mükafat → 50', 'xp=' + emp('E1').xp);

  //  `xp` NULL olan köhnə sətir (miqrasiyadan əvvəl) — `= 0` şərti NULL-a
  //  uyğun gəlmir, ona görə kod ayrıca `is('xp', null)` işlədir.
  fake.reset({ ...bir(), employees: [{ tenant_id: 'cm', id: 'E1', name: 'Aysel', dept: 'Elmlər', secret: 'S1', xp: null, streak: 0 }] });
  await inCm(() => XP('E1', 25));
  ok(emp('E1').xp === 25, 'NULL `xp` olan sətrə də yazılır', 'xp=' + emp('E1').xp);
}

// ══════════════════════════════════════════════════════════════════════════
section('2. ⚠️ F-22 — kart açılışında sorğu sayı');
{
  const gunler = [];
  for (let d = 0; d < 14; d++) {
    const dd = new Date(Date.now() + d * 86400000);
    gunler.push(U.toYMD(dd));
  }
  fake.reset({
    employees: [{ tenant_id: 'cm', id: 'E1', name: 'Aysel', dept: 'Elmlər', secret: 'S1', xp: 0, streak: 3 }],
    cedvel: gunler.map((ds, i) => ({ tenant_id: 'cm', cedvel_id: 'C' + i, emp_id: 'E1',
                                     dept: 'Elmlər', date_str: ds, shift_type: 'sehersm' })),
    attendance: [], nahar: [], announcements: [], fines: [], mgr_fines: [], avans: [],
  });

  const c = sayğac();
  let dash;
  try { dash = await inCm(() => API.getDashboardData('S1')); } finally { c.bitir(); }

  ok(!!dash, 'kart məlumatı gəldi');
  ok(dash.weekSchedule.length === 7 && dash.nextWeekSchedule.length === 7, 'iki həftə quruldu');
  ok(dash.weekSchedule.some(d => d.shiftType === 'sehersm'), 'smenlər düzgün oxundu',
     JSON.stringify(dash.weekSchedule.map(d => d.shiftType)));

  //  ⚠️ Köhnə kod `getEmployeeShift`-i 14 dəfə çağırırdı — TƏK BAŞINA 14
  //  `cedvel` sorğusu. İndi bir dəfə (+ iki `getCedvel` + hesabatın biri).
  //  Rəqəmlər ilk yazılışda təxmini idi, test onları düzəltdi: real ölçü 4/13.
  ok(c.cedvel <= 5, `cedvel sorğusu ${c.cedvel} (əvvəl ~18 idi)`, 'cedvel=' + c.cedvel);
  ok(c.n <= 15, `ümumi sorğu ${c.n} (audit «~25» demişdi)`, 'ümumi=' + c.n);
  console.log(`      ℹ️  sorğu: ${c.n} ümumi, ${c.cedvel} cedvel`);

  //  Rəqəmdən daha davamlısı QAYDADIR: gün başına sorğu OLMAMALIDIR.
  //  `getDashboardData` içində tək-gün variantı çağırılsa N+1 geri qayıdır.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'server.js'), 'utf8');
  const bas = src.indexOf('API.getDashboardData');
  const son = src.indexOf('\n};', bas);
  const dashFn = (bas >= 0 && son > bas) ? src.slice(bas, son) : '';
  ok(!!dashFn, 'getDashboardData tapıldı');
  ok(dashFn && !dashFn.includes('U.getEmployeeShift('),
     'gün-gün `getEmployeeShift` çağırışı qalmayıb (N+1 qaydası)');
  ok(dashFn.includes('U.getEmployeeShifts('), 'toplu variant işlədilir');
}

// ══════════════════════════════════════════════════════════════════════════
section('2b. getEmployeeShifts — getEmployeeShift ilə eyni cavab');
{
  //  Təkrar sətirdə hər ikisi ƏN BÖYÜK `cedvel_id`-ni seçməlidir.
  fake.reset({ cedvel: [
    { tenant_id: 'cm', cedvel_id: 'C-A', emp_id: 'E1', date_str: '2026-08-25', shift_type: 'sehersm' },
    { tenant_id: 'cm', cedvel_id: 'C-B', emp_id: 'E1', date_str: '2026-08-25', shift_type: 'axsamsm' },
    { tenant_id: 'cm', cedvel_id: 'C-C', emp_id: 'E1', date_str: '2026-08-26', shift_type: 'istirahetsm' },
  ] });
  const tek = await inCm(() => U.getEmployeeShift('E1', '2026-08-25'));
  const cox = await inCm(() => U.getEmployeeShifts('E1', ['2026-08-25', '2026-08-26', '2026-08-27']));
  ok(tek === 'axsamsm', 'tək variant sonuncu sətri seçir', String(tek));
  ok(cox['2026-08-25'] === tek, 'çoxlu variant EYNİ cavabı verir', cox['2026-08-25']);
  ok(cox['2026-08-26'] === 'istirahetsm', 'digər gün də düzgün');
  ok(!('2026-08-27' in cox), 'cədvəli olmayan gün xəritədə yoxdur');
  ok(Object.keys(await inCm(() => U.getEmployeeShifts('E1', []))).length === 0, 'boş siyahı → boş xəritə');
}

// ══════════════════════════════════════════════════════════════════════════
section('3. ⚠️ F-19 — açarsız cihaz qeydiyyatı spam etmir');
{
  ratelimit.__reset();
  fake.reset({ scan_devices: [], settings: [] });

  //  Normal hal: ilk cihaz qeydə alınır
  const r1 = await inCm(() => API.checkScanDevice('SCN-001'));
  ok(r1.pending === true, 'yeni cihaz qeydə alınır', JSON.stringify(r1));
  ok((fake.store.scan_devices || []).length === 1, 'bir sətir yarandı');

  //  Eyni cihaz təkrar — yeni sətir yaranmır
  await inCm(() => API.checkScanDevice('SCN-001'));
  ok((fake.store.scan_devices || []).length === 1, 'eyni cihaz təkrar sətir yaratmır');

  //  ⚠️ Hücum: hər dəfə YENİ uydurma ID. Köhnə kodda hər biri bir sətir +
  //  bir Telegram mesajı demək idi — hədsiz.
  for (let i = 0; i < 60; i++) await inCm(() => API.checkScanDevice('SCN-SAXTA-' + i));
  const say = (fake.store.scan_devices || []).length;
  ok(say <= 20, `gözləyən cihaz sayı tavanla məhdudlaşdı (${say})`, 'sətir: ' + say);

  const sonuncu = await inCm(() => API.checkScanDevice('SCN-SAXTA-999'));
  ok(sonuncu.pending === false, 'hədd dolanda yeni qeyd qəbul edilmir', JSON.stringify(sonuncu));
  ok(/əlaqə saxlayın/i.test(sonuncu.reason || ''), 'istifadəçiyə nə etməli olduğu deyilir', sonuncu.reason);

  //  Təsdiqlənmiş cihaz həddin arxasında qalmır
  fake.store.scan_devices.push({ tenant_id: 'cm', device_id: 'SCN-OK', branch: 'Elmlər', status: 'active', label: 'Kiosk' });
  const aktiv = await inCm(() => API.checkScanDevice('SCN-OK'));
  ok(aktiv.allowed === true, 'təsdiqlənmiş kiosk hədddən təsirlənmir', JSON.stringify(aktiv));
}

// ══════════════════════════════════════════════════════════════════════════
section('3b. Telegram bildirişi boğulur');
{
  //  Bildirişin sayını `sendTelegramMsg` səviyyəsində sayırıq.
  ratelimit.__reset();
  fake.reset({ scan_devices: [], settings: [
    { tenant_id: 'cm', key: 'TG_TOKEN', value: 'x' },
    { tenant_id: 'cm', key: 'TG_ADMIN_CHAT', value: '-100' },
  ] });

  //  ⚠️ İlk yazılışda `U.sendTelegramMsg`-i casusladım və nəticə 0 çıxdı —
  //  yəni test heç nə yoxlamırdı. Səbəb: `sendTgTemplate` utils.js-in İÇİNDƏ
  //  həmin funksiyanı birbaşa çağırır, ixrac olunan obyekt üzərindən yox.
  //  Server isə `U.sendTgTemplate` çağırır → casus MƏHZ orada işləyir.
  let gonderilen = 0;
  const orig = U.sendTgTemplate;
  U.sendTgTemplate = async () => { gonderilen++; return true; };
  try {
    for (let i = 0; i < 15; i++) await inCm(() => API.checkScanDevice('SCN-TG-' + i));
  } finally {
    U.sendTgTemplate = orig;
  }
  ok(gonderilen > 0, 'bildiriş mexanizmi işləyir (casus tutur)', 'göndərilən: ' + gonderilen);
  ok(gonderilen <= 5, `15 yeni cihaza qarşı ən çoxu 5 bildiriş (${gonderilen})`, 'göndərilən: ' + gonderilen);
  ok((fake.store.scan_devices || []).length === 15,
     'bildiriş boğulsa da QEYDLƏR yazılır (admin paneldə görünür)',
     'sətir: ' + (fake.store.scan_devices || []).length);
}

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(62)}`);
console.log(fail === 0
  ? `🎉  BÜTÜN TESTLƏR KEÇDİ  (${pass}/${pass})`
  : `❌  ${fail} TEST UĞURSUZ  (${pass}/${pass + fail} keçdi)`);
console.log(`${'═'.repeat(62)}\n`);
process.exit(fail === 0 ? 0 : 1);

})().catch(e => { console.error('\n💥  Test çöküb:', e); process.exit(1); });
