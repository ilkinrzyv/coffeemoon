'use strict';
// ══════════════════════════════════════════════════════════════════════════
//  KİOSK QR TOKENİ — YOXLAMA TESTLƏRİ
// ══════════════════════════════════════════════════════════════════════════
//  Bu testlərin cavab verdiyi sual: "işçi həqiqətən kiosk ekranının
//  qarşısındadırmı?"
//
//  Tarixçə: ƏVVƏL skan edilən QR serverə ÜMUMİYYƏTLƏ göndərilmirdi — bütün
//  yoxlama telefonun içində idi, yəni brauzer konsolundan bir çağırışla
//  tamamilə keçilirdi. İndi token serverə gəlir və burada yoxlanılır.
//
//  ⚠️ Qəsdən yoxlanılan sərhədlər:
//    · vaxt pəncərəsi SERVERİN saatı ilə ölçülür (telefonun saatı deyil);
//    · cihaz bu MÜŞTƏRİYƏ aid və admin tərəfindən TƏSDİQLƏNMİŞ olmalıdır;
//    · kioskun filialı ilə işçinin filialı üst-üstə düşməlidir.
//
//      node test-qr.js
// ══════════════════════════════════════════════════════════════════════════

process.env.TZ = process.env.TZ || 'Asia/Baku';

// ── Supabase klientini taxta ilə əvəzlə (require keşindən ƏVVƏL) ─────────
//  test-multitenant.js-dəki taxtadan fərqi: bu, real formada `{ data }`
//  qaytarır, çünki `verifyKioskQr` cavabın MƏZMUNUNA baxır.
let _devices = {};        // tenant_id → { device_id → sətir }
const fakeSb = {
  from(table) {
    const q = { table, filters: {} };
    const chain = {
      select: () => chain,
      eq: (col, val) => { q.filters[col] = val; return chain; },
      single: () => Promise.resolve({ data: lookup(q) }),
      maybeSingle: () => Promise.resolve({ data: lookup(q) }),
      then: (res) => res({ data: lookup(q) }),
    };
    return chain;
  },
};
function lookup(q) {
  if (q.table !== 'scan_devices') return null;
  const t = _devices[q.filters.tenant_id] || {};
  return t[q.filters.device_id] || null;
}
require.cache[require.resolve('./db')] = {
  id: require.resolve('./db'), filename: require.resolve('./db'), loaded: true, exports: fakeSb,
};

const T = require('./tenant');
const U = require('./utils');

// ── Test qurğusu ─────────────────────────────────────────────────────────
let pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else      { fail++; console.log(`  ✗ ${label}${detail ? '\n      → ' + detail : ''}`); }
}
const section = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 54 - t.length))}`);

// İki müştəri, hərəsində bir kiosk
T.__testSeed({
  tenants: [
    { tenant_id: 'cm', name: 'Coffeemoon', status: 'active', plan: 'pro' },
    { tenant_id: 'pl', name: 'Pizza',      status: 'active', plan: 'pro' },
  ],
  branches: [
    { tenant_id: 'cm', branch_id: 'elmler',  name: 'Elmlər',   active: true },
    { tenant_id: 'cm', branch_id: 'agseher', name: 'Ağ Şəhər', active: true },
    { tenant_id: 'pl', branch_id: 'nizami',  name: 'Nizami',   active: true },
  ],
});
_devices = {
  cm: {
    'DEV-ELM': { device_id: 'DEV-ELM', branch: 'Elmlər',   status: 'active'  },
    'DEV-AGS': { device_id: 'DEV-AGS', branch: 'Ağ Şəhər', status: 'active'  },
    'DEV-GOZ': { device_id: 'DEV-GOZ', branch: 'Elmlər',   status: 'pending' },
    'DEV-BLK': { device_id: 'DEV-BLK', branch: 'Elmlər',   status: 'blocked' },
  },
  pl: {
    'DEV-NIZ': { device_id: 'DEV-NIZ', branch: 'Nizami', status: 'active' },
  },
};

// Cari (və ya sürüşdürülmüş) pəncərə ilə token qurur
const tokenFor = (dev, offset = 0) =>
  `CMQR:${dev}:${Math.floor(Date.now() / U.QR_STEP_MS) + offset}`;

const inCm = (fn) => T.run({ tenantId: 'cm' }, fn);
const inPl = (fn) => T.run({ tenantId: 'pl' }, fn);

(async () => {
  console.log('\n══ KİOSK QR TOKENİ TESTLƏRİ ══');

  // ══════════════════════════════════════════════════════════════════════
  section('1. Düzgün token qəbul olunur');
  await inCm(async () => {
    const r = await U.verifyKioskQr(tokenFor('DEV-ELM'), 'Elmlər');
    ok(r.ok, 'cari pəncərə + aktiv cihaz + uyğun filial');
    ok(r.device && r.device.device_id === 'DEV-ELM', 'cihaz qaytarılır (audit izi üçün)');
  });

  // ══════════════════════════════════════════════════════════════════════
  section('2. Vaxt pəncərəsi — serverin saatı ilə');
  await inCm(async () => {
    ok((await U.verifyKioskQr(tokenFor('DEV-ELM', -1), 'Elmlər')).ok, 'bir əvvəlki pəncərə keçir (±1 tolerans)');
    ok((await U.verifyKioskQr(tokenFor('DEV-ELM',  1), 'Elmlər')).ok, 'bir sonrakı pəncərə keçir (kiosk saatı bir az irəlidirsə)');
    ok(!(await U.verifyKioskQr(tokenFor('DEV-ELM', -2), 'Elmlər')).ok, 'iki pəncərə köhnə token RƏDD (~60 san+)');
    ok(!(await U.verifyKioskQr(tokenFor('DEV-ELM', 99), 'Elmlər')).ok, 'gələcək token RƏDD');
    // ⚠️ Bu, QR-ın əsas məhdudiyyətidir: şəkil çəkilib göndərilə bilər.
    // Ona görə WiFi yoxlaması QR ilə BİRLİKDƏ qalır (ayrıca test: test-multitenant §8b).
    ok(U.QR_TOLERANS === 1, 'tolerans ±1 pəncərədir — token ən çoxu ~60 saniyə yaşayır');
  });

  // ══════════════════════════════════════════════════════════════════════
  section('3. Cihazın vəziyyəti');
  await inCm(async () => {
    ok(!(await U.verifyKioskQr(tokenFor('DEV-GOZ'), 'Elmlər')).ok, 'təsdiq gözləyən cihaz RƏDD');
    ok(!(await U.verifyKioskQr(tokenFor('DEV-BLK'), 'Elmlər')).ok, 'bloklanmış cihaz RƏDD');
    ok(!(await U.verifyKioskQr(tokenFor('YOXDUR'),  'Elmlər')).ok, 'tanınmayan cihaz RƏDD');
  });

  // ══════════════════════════════════════════════════════════════════════
  section('4. Filial uyğunluğu');
  await inCm(async () => {
    const r = await U.verifyKioskQr(tokenFor('DEV-AGS'), 'Elmlər');
    ok(!r.ok, 'başqa filialın kiosku RƏDD');
    ok(/Ağ Şəhər/.test(r.reason || ''), 'səbəbdə hansı filial olduğu yazılır', r.reason);
  });

  // ══════════════════════════════════════════════════════════════════════
  section('5. Müştəri izolyasiyası');
  //  `pl` müştərisinin kiosku `cm` işçisini qeyd edə BİLMƏMƏLİDİR.
  //  Bunu tdb.js təmin edir (sorğuya tenant_id əlavə olunur) — burada
  //  həmin qorumanın QR yolunda da işlədiyi təsdiqlənir.
  await inCm(async () => {
    ok(!(await U.verifyKioskQr(tokenFor('DEV-NIZ'), 'Elmlər')).ok, 'cm: başqa müştərinin cihazını görmür');
  });
  await inPl(async () => {
    ok((await U.verifyKioskQr(tokenFor('DEV-NIZ'), 'Nizami')).ok, 'pl: öz cihazını görür');
    ok(!(await U.verifyKioskQr(tokenFor('DEV-ELM'), 'Nizami')).ok, 'pl: cm-in cihazını görmür');
  });

  // ══════════════════════════════════════════════════════════════════════
  section('6. Yanlış formatlar');
  await inCm(async () => {
    const pis = ['', null, undefined, 'salam', 'CMQR', 'CMQR:', 'CMQR:DEV-ELM',
                 'CMQR:DEV-ELM:abc', 'CMQR::123', 'XXQR:DEV-ELM:1',
                 '1234',                       // köhnə 4 rəqəmli PIN
                 'cmqr:DEV-ELM:1'];            // kiçik hərf — prefiks dəqiq olmalıdır
    let hamisiRedd = true, kecen = null;
    for (const t of pis) {
      const r = await U.verifyKioskQr(t, 'Elmlər');
      if (r.ok) { hamisiRedd = false; kecen = JSON.stringify(t); }
    }
    ok(hamisiRedd, `${pis.length} yanlış formatın hamısı RƏDD olunur`, kecen && 'keçdi: ' + kecen);
  });

  // ══════════════════════════════════════════════════════════════════════
  section('7. Hər rəddin oxunaqlı səbəbi var');
  await inCm(async () => {
    const hallar = [
      ['boş token',        ''],
      ['köhnə token',      tokenFor('DEV-ELM', -5)],
      ['tanınmayan cihaz', tokenFor('YOXDUR')],
      ['aktiv olmayan',    tokenFor('DEV-BLK')],
      ['yad filial',       tokenFor('DEV-AGS')],
    ];
    let hamisi = true;
    for (const [ad, t] of hallar) {
      const r = await U.verifyKioskQr(t, 'Elmlər');
      const yaxsi = !r.ok && typeof r.reason === 'string' && r.reason.length > 10 && !/undefined/.test(r.reason);
      if (!yaxsi) { hamisi = false; console.log(`      → ${ad}: ${JSON.stringify(r)}`); }
    }
    ok(hamisi, 'hər halda istifadəçiyə aydın mətn qaytarılır (heç birində "undefined" yoxdur)');
  });

  console.log(`\n${'═'.repeat(62)}`);
  console.log(fail === 0
    ? `🎉  BÜTÜN TESTLƏR KEÇDİ  (${pass}/${pass})`
    : `❌  ${fail} TEST UĞURSUZ  (${pass}/${pass + fail} keçdi)`);
  console.log(`${'═'.repeat(62)}\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('\n💥  Test çöküb:', e); process.exit(1); });
