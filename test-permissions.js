'use strict';
// ══════════════════════════════════════════════════════════════════════════
//  FİLİAL İCAZƏLƏRİ — TESTLƏR  (F-13, F-14)
// ══════════════════════════════════════════════════════════════════════════
//  Bu testlərin cavab verdiyi sual: "etibarlı açar SAHİBİ nəyə toxuna bilər?"
//
//  Sistem iki sualı qarışdırırdı:
//    1. Bu açar etibarlıdırmı?          ← yoxlanılırdı
//    2. Bu SƏTİR həmin açarındırmı?     ← YOXLANILMIRDI
//
//  F-13  `approveLatePerm` yalnız 1-ci sualı verirdi. Yəni Elmlər filialının
//        meneceri Sahil filialının gec gəliş icazəsini təsdiqləyə bilirdi.
//
//  F-14  `updateAvansStatus` heç filial açarı da ALMIRDI (imza `(avansId, status)`)
//        və auth səviyyəsi `'staff'` idi — yəni İSTƏNİLƏN panel açarı (trainer,
//        ops, icraçı, başqa filialın meneceri) istənilən avansı təsdiqləyə və
//        «Ödənildi» işarələyə bilirdi. Bu, puldur.
//
//  ⚠️ Bunlar DAVRANIŞ testləridir: `server.js` həqiqətən require edilir və
//  funksiyalar çağırılır (baza `test-fakedb.js` ilə əvəzlənib). Əvvəl yalnız
//  mənbə mətnini oxumaq olurdu.
//
//      node test-permissions.js
// ══════════════════════════════════════════════════════════════════════════

process.env.TZ = process.env.TZ || 'Asia/Baku';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://test.local';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test';

const fake = require('./test-fakedb').install();   // `./db`-ni require-dan ƏVVƏL əvəz edir
const T = require('./tenant');
const { API } = require('./server');               // artıq port tutmur (require.main)

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else      { fail++; console.log(`  ✗ ${label}${detail ? '\n      → ' + detail : ''}`); }
}
const section = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 52 - t.length))}`);

// ── İki filial, iki menecer açarı ────────────────────────────────────────
const KEY_ELM = 'SK-ELMLER', KEY_SAH = 'SK-SAHIL';
T.__testSeed({
  tenants: [{ tenant_id: 'cm', name: 'Test', status: 'active', plan: 'pro' }],
  authKeys: [
    { key: KEY_ELM, tenant_id: 'cm', role: 'manager', branch_id: 'elmler' },
    { key: KEY_SAH, tenant_id: 'cm', role: 'manager', branch_id: 'sahil'  },
    { key: 'TK-CM', tenant_id: 'cm', role: 'trainer', branch_id: null     },
  ],
  branches: [
    { tenant_id: 'cm', branch_id: 'elmler', name: 'Elmlər', active: true, sort_order: 0 },
    { tenant_id: 'cm', branch_id: 'sahil',  name: 'Sahil',  active: true, sort_order: 1 },
  ],
});
const inCm = (fn) => T.run({ tenantId: 'cm', role: 'system', branchId: null }, fn);

const SEED = {
  employees: [
    { tenant_id: 'cm', id: 'E-ELM', name: 'Aysel', dept: 'Elmlər', secret: 'S-ELM' },
    { tenant_id: 'cm', id: 'E-SAH', name: 'Rəşad', dept: 'Sahil',  secret: 'S-SAH' },
  ],
  late_perms: [
    { tenant_id: 'cm', perm_id: 'LP-ELM', emp_id: 'E-ELM', emp_name: 'Aysel', dept: 'Elmlər',
      date_str: '2026-08-25', requested_time: '10:00', status: 'pending' },
    { tenant_id: 'cm', perm_id: 'LP-SAH', emp_id: 'E-SAH', emp_name: 'Rəşad', dept: 'Sahil',
      date_str: '2026-08-25', requested_time: '10:00', status: 'pending' },
  ],
  avans: [
    { tenant_id: 'cm', avans_id: 'AV-ELM', emp_id: 'E-ELM', emp_name: 'Aysel', dept: 'Elmlər',
      amount: 100, status: 'pending', date_str: '2026-08-25' },
    { tenant_id: 'cm', avans_id: 'AV-SAH', emp_id: 'E-SAH', emp_name: 'Rəşad', dept: 'Sahil',
      amount: 250, status: 'pending', date_str: '2026-08-25' },
  ],
  push_subscriptions: [],
  settings: [],
};
const row = (t, idCol, id) => (fake.store[t] || []).find(r => r[idCol] === id);

console.log('\n══ FİLİAL İCAZƏSİ TESTLƏRİ ══');

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('1. Öz filialı — normal iş pozulmur');
{
  fake.reset(SEED);
  const r = await inCm(() => API.approveLatePerm(KEY_ELM, 'LP-ELM', 'approved'));
  ok(r.success, 'Elmlər meneceri ÖZ filialının icazəsini təsdiqləyir', JSON.stringify(r));
  ok(row('late_perms', 'perm_id', 'LP-ELM').status === 'approved', 'status bazada dəyişdi');

  fake.reset(SEED);
  const a = await inCm(() => API.updateAvansStatus(KEY_SAH, 'AV-SAH', 'approved'));
  ok(a.success, 'Sahil meneceri ÖZ filialının avansını təsdiqləyir', JSON.stringify(a));
  ok(row('avans', 'avans_id', 'AV-SAH').status === 'approved', 'status bazada dəyişdi');
  ok(!!row('avans', 'avans_id', 'AV-SAH').decided_ymd, 'qərar günü yazıldı (maaş tutulması üçün)');
}

// ══════════════════════════════════════════════════════════════════════════
section('2. ⚠️ BAŞQA filial — bloklanır (F-13 / F-14-ün özü)');
{
  fake.reset(SEED);
  const r = await inCm(() => API.approveLatePerm(KEY_ELM, 'LP-SAH', 'approved'));
  ok(!r.success, 'F-13: Elmlər meneceri Sahil-in icazəsini TƏSDİQLƏYƏ BİLMİR', JSON.stringify(r));
  ok(row('late_perms', 'perm_id', 'LP-SAH').status === 'pending',
     'Sahil-in sətri TOXUNULMAMIŞ qaldı', row('late_perms', 'perm_id', 'LP-SAH').status);

  fake.reset(SEED);
  const a = await inCm(() => API.updateAvansStatus(KEY_ELM, 'AV-SAH', 'paid'));
  ok(!a.success, 'F-14: Elmlər meneceri Sahil-in avansını «Ödənildi» edə BİLMİR', JSON.stringify(a));
  ok(row('avans', 'avans_id', 'AV-SAH').status === 'pending', '250 ₼-lik sətir toxunulmamış qaldı');
}

// ══════════════════════════════════════════════════════════════════════════
section('3. Menecer olmayan açar');
{
  fake.reset(SEED);
  const a = await inCm(() => API.updateAvansStatus('TK-CM', 'AV-ELM', 'approved'));
  ok(!a.success, 'trainer açarı avansa toxuna bilmir', JSON.stringify(a));

  const b = await inCm(() => API.updateAvansStatus('YOXDUR', 'AV-ELM', 'approved'));
  ok(!b.success, 'tanınmayan açar rədd olunur');

  const c = await inCm(() => API.approveLatePerm('TK-CM', 'LP-ELM', 'approved'));
  ok(!c.success, 'trainer açarı gec gəliş icazəsinə toxuna bilmir');
  ok(row('late_perms', 'perm_id', 'LP-ELM').status === 'pending', 'sətir toxunulmamış qaldı');
}

// ══════════════════════════════════════════════════════════════════════════
section('4. İşçi filial dəyişəndə: siyahı ilə təsdiq UYĞUN qalır');
{
  //  `getAvansForManager` sətri İKİ mənbədən tapır: sətrin `dept`-i VƏ işçinin
  //  CARİ filialı. İşçi Sahil→Elmlər keçəndə köhnə avans sətrində `dept`
  //  hələ 'Sahil'-dir. Əgər təsdiq yoxlaması yalnız `dept`-ə baxsaydı, Elmlər
  //  meneceri siyahıda GÖRDÜYÜ sətri təsdiqləyə bilməzdi (görünməz sınma).
  fake.reset(SEED);
  fake.store.employees.find(e => e.id === 'E-SAH').dept = 'Elmlər';

  const list = await inCm(() => API.getAvansForManager(KEY_ELM));
  ok(list.some(x => x.avansId === 'AV-SAH'), 'köçmüş işçinin avansı Elmlər siyahısında GÖRÜNÜR');

  const a = await inCm(() => API.updateAvansStatus(KEY_ELM, 'AV-SAH', 'approved'));
  ok(a.success, 'və Elmlər meneceri onu təsdiqləyə BİLİR', JSON.stringify(a));

  // Əks tərəf: köhnə filial artıq toxuna bilməməlidir? Sətrin `dept`-i hələ
  // 'Sahil' olduğu üçün Sahil meneceri də görür — bu, MÖVCUD siyahı qaydasıdır
  // və qəsdən dəyişilmir. Vacib olan: siyahı ilə təsdiq eyni cavabı verir.
  fake.reset(SEED);
  fake.store.employees.find(e => e.id === 'E-SAH').dept = 'Elmlər';
  const l2 = await inCm(() => API.getAvansForManager(KEY_SAH));
  const gorunur = l2.some(x => x.avansId === 'AV-SAH');
  const b = await inCm(() => API.updateAvansStatus(KEY_SAH, 'AV-SAH', 'approved'));
  ok(gorunur === b.success, 'GÖRÜNÜR ⇔ TOXUNA BİLİR (iki qayda ayrılmır)',
     `görünür=${gorunur}, toxuna bilir=${b.success}`);
}

// ══════════════════════════════════════════════════════════════════════════
section('5. Köhnə panel (keşdə qalmış imza)');
{
  fake.reset(SEED);
  // Köhnə manager.html `updateAvansStatus(avansId, status)` göndərirdi.
  const r = await inCm(() => API.updateAvansStatus('AV-ELM', 'approved'));
  ok(!r.success, 'köhnə imza qəbul edilmir');
  ok(/köhnə versiya/i.test(r.reason || ''), 'nə etmək lazım olduğu deyilir', r.reason);
  ok(row('avans', 'avans_id', 'AV-ELM').status === 'pending', 'heç nə dəyişmədi');

  // ⚠️ Ən vacibi: köhnə imzada 1-ci arqument avansId idi. Əgər onu filial
  // açarı kimi qəbul etsəydik, `validateBranchScheduleKey` onsuz da rədd edərdi
  // — amma səbəb aydın olmazdı. Yuxarıdakı mesaj həmin halı ayırır.
  const r2 = await inCm(() => API.updateAvansStatus('AV-ELM', 'rejected'));
  ok(!r2.success && /köhnə versiya/i.test(r2.reason || ''), 'rədd üçün də eyni mesaj');
}

// ══════════════════════════════════════════════════════════════════════════
section('6. Siyasət cədvəli');
{
  const fs = require('fs'), path = require('path');
  const src = fs.readFileSync(path.join(__dirname, 'auth.js'), 'utf8');
  const m = /updateAvansStatus:\s*'(\w+)'/.exec(src);
  ok(!!m, 'updateAvansStatus siyahıdadır');
  ok(m && m[1] !== 'staff',
     "updateAvansStatus artıq 'staff' DEYİL (istənilən panel açarı puldan keçirdi)", m && m[1]);
  ok(m && m[1] === 'self', "səviyyə 'self' — funksiya öz filial açarını özü yoxlayır", m && m[1]);
}

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(62)}`);
console.log(fail === 0
  ? `🎉  BÜTÜN TESTLƏR KEÇDİ  (${pass}/${pass})`
  : `❌  ${fail} TEST UĞURSUZ  (${pass}/${pass + fail} keçdi)`);
console.log(`${'═'.repeat(62)}\n`);
process.exit(fail === 0 ? 0 : 1);

})().catch(e => { console.error('\n💥  Test çöküb:', e); process.exit(1); });
