'use strict';
// ══════════════════════════════════════════════════════════════════════════
//  ÇOX-MÜŞTƏRİLİ İZOLYASİYA TESTLƏRİ
// ══════════════════════════════════════════════════════════════════════════
//  Bu testlərin cavab verdiyi sual: "bir müştəri başqasının datasını görə
//  bilərmi?" Bazaya qoşulmur — Supabase klienti taxta ilə əvəzlənir və hər
//  sorğunun HANSI filtrlə getdiyi yoxlanılır.
//
//    node test-multitenant.js
// ══════════════════════════════════════════════════════════════════════════

process.env.TZ = process.env.TZ || 'Asia/Baku';

// ── Supabase klientini taxta ilə əvəzlə (require keşindən əvvəl) ─────────
const calls = [];
function builder(table, op) {
  const rec = { table, op, filters: [], payload: null, opts: null };
  calls.push(rec);
  const chain = new Proxy({}, {
    get(_, prop) {
      if (prop === 'then') return undefined;               // await edilməsin
      if (prop === '__rec') return rec;
      return (...args) => {
        if (['eq','neq','in','gte','lte','lt','gt','is'].includes(prop)) {
          rec.filters.push([prop, args[0], args[1]]);
        }
        return chain;
      };
    },
  });
  return chain;
}
const fakeSb = {
  from: (table) => ({
    select: (...a) => builder(table, 'select'),
    insert: (rows, o) => { const c = builder(table, 'insert'); c.__rec.payload = rows; c.__rec.opts = o; return c; },
    upsert: (rows, o) => { const c = builder(table, 'upsert'); c.__rec.payload = rows; c.__rec.opts = o; return c; },
    update: (row, o)  => { const c = builder(table, 'update'); c.__rec.payload = row;  c.__rec.opts = o; return c; },
    delete: (o)       => { const c = builder(table, 'delete'); c.__rec.opts = o; return c; },
  }),
};
require.cache[require.resolve('./db')] = { id: require.resolve('./db'), filename: require.resolve('./db'), loaded: true, exports: fakeSb };

const T   = require('./tenant');
const tdb = require('./tdb');
const db  = tdb.db;

// ── Test qurğusu ─────────────────────────────────────────────────────────
let pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else      { fail++; console.log(`  ✗ ${label}${detail ? '\n      → ' + detail : ''}`); }
}
function throws(fn, label) {
  try { fn(); ok(false, label, 'xəta atılmalı idi, atılmadı'); }
  catch (_) { ok(true, label); }
}
const last = () => calls[calls.length - 1];
const filterOf = (rec, col) => rec.filters.find(f => f[1] === col);
const section = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 58 - t.length))}`);

// İki uydurma müştəri ilə keşi doldur
function seedCaches() {
  const t = (id, name) => ({ tenant_id: id, name, status: 'active', plan: 'pro',
                             brand: { displayName: name }, locale: 'az', currency: 'AZN' });
  const store = T.__testSeed;
  store({
    tenants: [t('cm', 'Coffeemoon'), t('pl', "Joe's Pizza"), { ...t('sus', 'Bağlı Kafe'), status: 'suspended' }],
    authKeys: [
      { key: 'AK-CM', tenant_id: 'cm', role: 'admin',   branch_id: null },
      { key: 'SK-CM-ELM', tenant_id: 'cm', role: 'manager', branch_id: 'elmler' },
      { key: 'AK-PL', tenant_id: 'pl', role: 'admin',   branch_id: null },
    ],
    branches: [
      { tenant_id: 'cm', branch_id: 'elmler',  name: 'Elmlər',  active: true, wifi_ips: '10.0.0.', tg_chat_id: '-100111', waste_limit: 3.5, mgr_name: 'Aysel' },
      { tenant_id: 'cm', branch_id: 'agseher', name: 'Ağ Şəhər', active: true, wifi_ips: '', tg_chat_id: '', waste_limit: 3.0 },
      { tenant_id: 'pl', branch_id: 'nizami',  name: 'Nizami',  active: true, wifi_ips: '192.168.1.', tg_chat_id: '-100222', waste_limit: 5.0 },
    ],
    positions: [
      { tenant_id: 'cm', name: 'Barista', active: true, sort_order: 0 },
      { tenant_id: 'cm', name: 'Cashier', active: true, sort_order: 1 },
      { tenant_id: 'pl', name: 'Ofisiant', active: true, sort_order: 0 },
    ],
    settings: [
      { tenant_id: 'cm', key: 'TG_ENABLED', value: 'true' },
      { tenant_id: 'cm', key: 'TG_TOKEN',   value: 'cm-token' },
      { tenant_id: 'pl', key: 'TG_TOKEN',   value: 'pl-token' },
    ],
  });
}

(async () => {
  console.log('\n══ ÇOX-MÜŞTƏRİLİ İZOLYASİYA TESTLƏRİ ══');
  seedCaches();
  const U = require('./utils');   // keşlər dolandan sonra yüklənir

  // ══════════════════════════════════════════════════════════════════════
  section('1. Kontekstsiz sorğu bloklanır (fail-closed)');
  throws(() => db().from('employees').select('*'),
         'kontekst yoxdursa db() xəta atır');
  throws(() => T.tenantId(), 'tenantId() kontekstsiz xəta atır');
  ok(T.tenantIdOrNull() === null, 'tenantIdOrNull() kontekstsiz null qaytarır');

  // ══════════════════════════════════════════════════════════════════════
  section('2. SELECT-ə tenant filtri avtomatik qoşulur');
  await T.run({ tenantId: 'cm' }, async () => {
    db().from('employees').select('*');
    const f = filterOf(last(), 'tenant_id');
    ok(!!f && f[2] === 'cm', "select-ə .eq('tenant_id','cm') əlavə olundu",
       f ? `tapıldı: ${JSON.stringify(f)}` : 'tenant_id filtri YOXDUR');

    db().from('attendance').select('*').eq('emp_id', 'E1').gte('timestamp', 'x');
    const r = last();
    ok(r.filters.some(x => x[1] === 'tenant_id'), 'uzun zəncirdə də filtr qalır');
    ok(r.filters.some(x => x[1] === 'emp_id'), 'çağıranın öz filtrləri itmir');
  });

  // ══════════════════════════════════════════════════════════════════════
  section('3. INSERT / UPSERT sətrə tenant_id yazır');
  await T.run({ tenantId: 'cm' }, async () => {
    db().from('attendance').insert({ emp_id: 'E1', type: 'GƏLİŞ' });
    ok(last().payload.tenant_id === 'cm', 'insert (tək sətir) tenant_id alır');

    db().from('cedvel').insert([{ emp_id: 'E1' }, { emp_id: 'E2' }]);
    ok(last().payload.every(r => r.tenant_id === 'cm'), 'insert (massiv) hər sətrə tenant_id yazır');

    // ƏN VACİB: çağıran özü başqa müştəri yazmağa çalışsa üstələnməlidir
    db().from('attendance').insert({ emp_id: 'X', tenant_id: 'pl' });
    ok(last().payload.tenant_id === 'cm',
       'çağıranın verdiyi yad tenant_id ÜSTƏLƏNİR (başqasına yazmaq olmur)',
       `alındı: ${last().payload.tenant_id}`);

    db().from('scan_devices').upsert({ device_id: 'D1' }, { onConflict: 'device_id' });
    ok(last().opts.onConflict === 'tenant_id,device_id',
       'upsert-in onConflict hədəfinə tenant_id əlavə olunur',
       `alındı: ${last().opts.onConflict}`);
  });

  // ══════════════════════════════════════════════════════════════════════
  section('4. UPDATE / DELETE yalnız öz sətirlərinə toxunur');
  await T.run({ tenantId: 'pl' }, async () => {
    db().from('employees').update({ name: 'Yeni' }).eq('id', 'E1');
    const f = filterOf(last(), 'tenant_id');
    ok(!!f && f[2] === 'pl', 'update tenant filtri ilə məhdudlaşır');
    ok(!('tenant_id' in last().payload),
       'update payload-undan tenant_id silinir (sətir başqasına köçürülə bilmir)');

    db().from('checklist_items').delete().neq('item_id', 'x');
    const fd = filterOf(last(), 'tenant_id');
    ok(!!fd && fd[2] === 'pl', "kütləvi delete də yalnız öz müştərisini silir");
  });

  // ══════════════════════════════════════════════════════════════════════
  section('5. Platforma cədvəlləri db() ilə açılmır');
  await T.run({ tenantId: 'cm' }, async () => {
    throws(() => db().from('tenants').select('*'), 'db().from("tenants") xəta atır');
    throws(() => db().from('auth_keys').select('*'), 'db().from("auth_keys") xəta atır');
  });

  // ══════════════════════════════════════════════════════════════════════
  section('6. Paralel sorğular bir-birinin kontekstini oğurlamır');
  //  Bu, AsyncLocalStorage-ın əsl sınağıdır: iki müştəri eyni anda işləsə
  //  və aralarında await olsa, hər biri öz tenant-ında qalmalıdır.
  const results = await Promise.all([
    T.run({ tenantId: 'cm' }, async () => {
      await new Promise(r => setTimeout(r, 15));
      db().from('employees').select('*');
      const a = filterOf(last(), 'tenant_id')[2];
      await new Promise(r => setTimeout(r, 5));
      db().from('avans').select('*');
      return [a, filterOf(last(), 'tenant_id')[2]];
    }),
    T.run({ tenantId: 'pl' }, async () => {
      await new Promise(r => setTimeout(r, 5));
      db().from('employees').select('*');
      const a = filterOf(last(), 'tenant_id')[2];
      await new Promise(r => setTimeout(r, 15));
      db().from('avans').select('*');
      return [a, filterOf(last(), 'tenant_id')[2]];
    }),
  ]);
  ok(JSON.stringify(results[0]) === '["cm","cm"]', 'cm sorğusu await-lardan sonra da cm qalır', JSON.stringify(results[0]));
  ok(JSON.stringify(results[1]) === '["pl","pl"]', 'pl sorğusu await-lardan sonra da pl qalır', JSON.stringify(results[1]));

  // ══════════════════════════════════════════════════════════════════════
  section('7. Filiallar/vəzifələr müştəriyə görə dəyişir (hardcode qalmayıb)');
  await T.run({ tenantId: 'cm' }, async () => {
    ok(JSON.stringify(U.DEPTS) === '["Elmlər","Ağ Şəhər"]', 'U.DEPTS cm-in filiallarını verir', JSON.stringify(U.DEPTS));
    ok(JSON.stringify(U.POSITIONS) === '["Barista","Cashier"]', 'U.POSITIONS cm-in vəzifələri', JSON.stringify(U.POSITIONS));
    ok(U.deptToSlug('Elmlər') === 'elmler', 'deptToSlug bazadan işləyir');
  });
  await T.run({ tenantId: 'pl' }, async () => {
    ok(JSON.stringify(U.DEPTS) === '["Nizami"]', 'U.DEPTS pl-in filiallarını verir', JSON.stringify(U.DEPTS));
    ok(JSON.stringify(U.POSITIONS) === '["Ofisiant"]', 'U.POSITIONS pl-in vəzifələri', JSON.stringify(U.POSITIONS));
    ok(U.deptToSlug('Elmlər') === '', 'pl "Elmlər" filialını GÖRMÜR');
  });

  // ══════════════════════════════════════════════════════════════════════
  section('8. WiFi IP və Telegram müştəriyə görə ayrılır');
  //  DİQQƏT: IP artıq ARQUMENTDƏN yox, tenant kontekstindən (`clientIp`) oxunur —
  //  serverin `req.ip`-i oraya qoyur. Arqument yalnız diaqnostika üçün qalıb.
  await T.run({ tenantId: 'cm', clientIp: '10.0.0.5' }, async () => {
    ok(U.checkWifiIp('Elmlər', '').ok, 'cm: öz IP-si qəbul olunur');
    ok(U.getTelegramSettings().token === 'cm-token', 'cm öz Telegram tokenini alır');
    ok(U.deptChatId(U.getTelegramSettings(), 'Elmlər') === '-100111', 'filial chat id-si branches-dən gəlir');
  });
  await T.run({ tenantId: 'cm', clientIp: '192.168.1.9' }, async () => {
    ok(!U.checkWifiIp('Elmlər', '').ok, 'cm: yad şəbəkə rədd olunur');
  });
  await T.run({ tenantId: 'pl', clientIp: '192.168.1.9' }, async () => {
    ok(U.getTelegramSettings().token === 'pl-token', 'pl öz Telegram tokenini alır');
    ok(U.checkWifiIp('Nizami', '').ok, 'pl: öz IP-si qəbul olunur');
  });

  // ── F-04: IP saxtalaşdırıla bilməz, boş IP keçmir ────────────────────────
  section('8b. WiFi qoruması saxtalaşdırılmır (F-04)');
  //  ƏVVƏLKİ DAVRANIŞ (dəlik): IP-ni brauzer arqument kimi göndərirdi və
  //  boş IP `{ ok: true }` sayılırdı → ipify yavaşlayanda qoruma öz-özünə sönürdü.
  await T.run({ tenantId: 'cm', clientIp: '' }, async () => {
    ok(!U.checkWifiIp('Elmlər', '').ok, 'boş IP QƏBUL EDİLMİR (fail-closed)');
    ok(!U.checkWifiIp('Elmlər', '10.0.0.5').ok,
       'arqumentlə «düzgün» IP göndərmək qorumanı KEÇMİR');
  });
  await T.run({ tenantId: 'cm', clientIp: '10.0.0.5' }, async () => {
    ok(U.checkWifiIp('Elmlər', '203.0.113.7').ok,
       'yanlış arqument düzgün server IP-sini POZMUR');
  });
  //  Kontekstdən kənarda (fon işi, CLI) da fail-closed olmalıdır
  await T.run({ tenantId: 'cm' }, async () => {
    ok(!U.checkWifiIp('Elmlər', '10.0.0.5').ok, 'kontekstsiz sorğu da rədd olunur');
  });

  // ══════════════════════════════════════════════════════════════════════
  section('9. Açar → müştəri həlli');
  ok(T.resolveKeySync('AK-CM').tenantId === 'cm', 'admin açarı cm-ə aparır');
  ok(T.resolveKeySync('AK-PL').tenantId === 'pl', 'admin açarı pl-ə aparır');
  ok(T.resolveKeySync('YOXDUR') === null, 'tanınmayan açar null qaytarır');
  const mgr = T.branchByKey('SK-CM-ELM');
  ok(mgr.valid && mgr.dept === 'Elmlər' && mgr.tenantId === 'cm', 'menecer açarı filialı və müştərini verir');
  ok(T.branchByKey('AK-CM').valid === false, 'admin açarı menecer açarı kimi keçmir');
  ok(T.findKey('cm', 'admin', null) === 'AK-CM', 'tərs indeks açarı tapır');

  // ══════════════════════════════════════════════════════════════════════
  section('10. Abunəlik vəziyyəti');
  ok(T.tenantUsable('cm').ok, 'aktiv müştəri buraxılır');
  ok(!T.tenantUsable('sus').ok, 'dayandırılmış müştəri bloklanır');
  ok(!T.tenantUsable('yoxdur').ok, 'olmayan müştəri bloklanır');

  // ══════════════════════════════════════════════════════════════════════
  section('11. Şablon injeksiyası (apostroflu ad paneli sındırmır)');
  //  Produksiyada bir dəfə baş verib: apostroflu dəyər JS sətrinə düşəndə
  //  skript qırılır və panel tam açılmır. Brend adları artıq müştəridən
  //  gəldiyi üçün bu, indi daha kritikdir.
  const srv = require('./tpl');
  const evil = `Joe's "Diner" </script><script>alert(1)</script>`;
  const js   = srv.jsLiteral(evil);
  ok(!js.includes("'") || js.startsWith('"'), 'JS literal dırnaqla bağlanır');
  ok(!/<\/script/i.test(js), '</script> qaçırılır — skript qırılmır');
  ok(eval(js) === evil, 'qaçırılmış dəyər eyni ilə geri oxunur');

  const html = srv.htmlEscape(evil);
  ok(!html.includes('<') && !html.includes('"'), 'HTML kontekstində teq və dırnaq neytrallaşır');

  const tpl = srv.replaceVars(`<div><?= n ?></div><script>var N = <?= n_js ?>;</script>`, { n: evil });
  ok(!tpl.includes('<script>alert'), 'şablonda injeksiya baş vermir');
  ok(tpl.includes('var N = "Joe'), 'JS dəyəri düzgün yerləşir');

  // ══════════════════════════════════════════════════════════════════════
  section('12. server.js-də sızma nöqtələri (mənbə yoxlaması)');
  //  Bu iki səhv 2026-08-21 auditində tapıldı. Davranış testi ilə tutmaq üçün
  //  server.js-i require etmək lazım gələrdi (o isə dərhal `app.listen` edir),
  //  ona görə mənbə mətni yoxlanılır — geriyə sürüşməni tutmağa kifayətdir.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'server.js'), 'utf8');

  //  (a) Push abunəlikləri: xam `sb` filtrsiz oxuyurdu. `emp_id` dəyərləri
  //      ('EXEC', 'TRAINER', 'MGR-<Filial>') müştərilər arasında eynidir, ona
  //      görə bir müştərinin bildirişi hamıya gedirdi.
  const pushFn = /async function sendPushToEmployee[\s\S]*?\n}/.exec(src);
  ok(!!pushFn, 'sendPushToEmployee tapıldı');
  ok(pushFn && /await db\(\)\s*\n?\s*\.from\('push_subscriptions'\)/.test(pushFn[0]),
     'sendPushToEmployee abunəlikləri db() ilə oxuyur (xam sb yox)');
  ok(pushFn && !/await sb\s*\n?\s*\.from\(/.test(pushFn[0]),
     'sendPushToEmployee-də xam sb sorğusu qalmayıb');

  //  (b) Aylıq hesabat keşi: açar yalnız "il-ay" idi → A müştərisinin hesabatı
  //      60 saniyə ərzində B müştərisinə qaytarılırdı.
  const ckey = /const cacheKey\s*=\s*(.+);/.exec(src);
  ok(!!ckey, 'getMonthlyReport keş açarı tapıldı');
  ok(ckey && /tenantId\(\)/.test(ckey[1]),
     'hesabat keşi müştəri üzrə açarlanır', ckey && ckey[1]);

  //  Ümumi qayda: server.js-də `tenants` cədvəlindən başqa xam sb sorğusu olmamalıdır.
  const xamSb = [...src.matchAll(/await sb\s*\n?\s*\.from\('([a-z_]+)'\)/g)].map(m => m[1]);
  ok(xamSb.every(t => tdb.GLOBAL_TABLES.has(t)),
     'server.js-də scope edilməmiş sorğu yoxdur', xamSb.join(', '));

  //  (c) F-04: real IP mənbəyi. `trust proxy` `true` OLMAMALIDIR — o, müştərinin
  //      öz X-Forwarded-For başlığını qəbul edərdi və WiFi qoruması saxtalaşardı.
  ok(/app\.set\('trust proxy'/.test(src), 'trust proxy təyin olunub');
  ok(!/app\.set\('trust proxy',\s*true\s*\)/.test(src),
     "trust proxy `true` DEYİL (əks halda IP saxtalaşdırıla bilər)");
  ok(/clientIp:\s*ip\b/.test(src), 'serverin gördüyü IP tenant kontekstinə qoyulur');
  ok(!/if \(clientIp\) \{ const wc = U\.checkWifiIp/.test(src),
     'logLunch-da WiFi yoxlaması şərtsizdir (IP gəlməsə də atlanmır)');

  //  (d) F-20: təhlükəsizlik başlıqları və xəta sızması
  for (const h of ['X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy']) {
    ok(src.includes(`'${h}'`), `${h} başlığı göndərilir`);
  }
  ok(!/camera=\(\)/.test(src), 'Permissions-Policy kameranı BAĞLAMIR (QR oxuyucu işləməlidir)');
  ok(!/res\.status\(500\)\.json\(\{ error: e\.message \}\)/.test(src),
     'xam xəta mətni müştəriyə qaytarılmır');
  ok(/ratePeek\('pin'/.test(src) && /rateHit\('api'/.test(src),
     'sürət limiti dispatcher-ə qoşulub');

  //  (e) Kiosk IP-si TƏKLİFDİR, avtomatik qəbul EDİLMİR.
  //      Cihaz ID-si QR kodun içindədir (`CMQR:<cihazID>:<pəncərə>`), yəni QR
  //      fotosu olan hər kəsdə o var. Avtomatik qəbul etsək, həmin adam evdən
  //      bir sorğu ilə filialın IP-sini özününkü ilə əvəz edib girə bilər.
  //      Bu yoxlama həmin qaydanı gələcək dəyişikliklərdən qoruyur.
  const qeydFn = /async function kioskIpQeyd[\s\S]*?\n}/.exec(src);
  ok(!!qeydFn, 'kioskIpQeyd tapıldı');
  ok(qeydFn && /from\('scan_devices'\)\s*\n?\s*\.update/.test(qeydFn[0]),
     'kiosk IP-si yalnız scan_devices-ə yazılır');
  ok(qeydFn && !/from\('branches'\)/.test(qeydFn[0]),
     'kiosk IP-si `branches.wifi_ips`-ə AVTOMATİK yazılmır (təsdiq admindədir)');
  ok(!/saveBranchIPs[\s\S]{0,400}kioskIpQeyd|kioskIpQeyd[\s\S]{0,400}saveBranchIPs/.test(src),
     'icazəli siyahını yalnız admin dəyişir');

  //  (f) F-03: açar mintləyən fayllarda `Math.random()` KOD olaraq qalmamalıdır.
  //      (Davranış testi `test-keys.js` §2-dədir — bu, sadəcə ikinci qapıdır:
  //      kimsə tenant.js-də başqa yerdə Math.random yazsa dərhal görünsün.)
  for (const f of ['tenant.js', 'migrate-to-multitenant.js']) {
    const t = require('fs').readFileSync(require('path').join(__dirname, f), 'utf8')
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');   // şərhlər sayılmır
    ok(!/Math\.random/.test(t), `${f}: açar yaradılışında Math.random yoxdur`);
  }

  // ══════════════════════════════════════════════════════════════════════
  section('13. upsert ON CONFLICT ↔ sxem uyğunluğu');
  //  F-06: `onConflict:'endpoint'` tdb tərəfindən `'tenant_id,endpoint'`-a
  //  çevrilir, amma bazada belə unikal indeks yox idi → Postgres 42P10 verirdi,
  //  kod isə xətanı oxumadan `{ok:true}` deyirdi. Aylarla görünməz qaldı.
  //
  //  Bu yoxlama qaydanı avtomatlaşdırır: server.js-də işlədilən HƏR münaqişə
  //  hədəfi üçün sxemdə MƏHZ həmin sütunlar üzrə unikal indeks (və ya ilkin
  //  açar) olmalıdır. Postgres ON CONFLICT-də sütunları dəqiq uyğunlaşdırır —
  //  yalnız `(endpoint)` üzrə indeks `(tenant_id, endpoint)` üçün kifayət etmir.
  const sxem = require('fs').readFileSync(require('path').join(__dirname, 'schema-v3-multitenant.sql'), 'utf8');

  // Sxemdəki bütün unikal sütun dəstləri: "cedvel" → Set{"tenant_id,cedvel_id", ...}
  const unikal = {};
  const eleve = (tbl, cols) => {
    const key = cols.split(',').map(s => s.trim().toLowerCase()).filter(Boolean).join(',');
    (unikal[tbl] = unikal[tbl] || new Set()).add(key);
  };
  for (const m of sxem.matchAll(/CREATE TABLE (\w+)\s*\(([\s\S]*?)\n\);/g)) {
    const pk = /PRIMARY KEY\s*\(([^)]+)\)/i.exec(m[2]);
    if (pk) eleve(m[1], pk[1]);
    for (const u of m[2].matchAll(/UNIQUE\s*\(([^)]+)\)/gi)) eleve(m[1], u[1]);
  }
  for (const m of sxem.matchAll(/CREATE UNIQUE INDEX \w+\s+ON (\w+)\s*\(([^)]+)\)/gi)) eleve(m[1], m[2]);

  // server.js-dəki upsert-lərin münaqişə hədəfləri
  const hedefler = [];
  for (const m of src.matchAll(/\.from\('(\w+)'\)\s*\.upsert\(/g)) {
    const pencere = src.slice(m.index, m.index + 800);
    const oc = /onConflict:\s*'([^']+)'/.exec(pencere);
    if (oc) hedefler.push({ table: m[1], cols: oc[1] });
  }
  ok(hedefler.length >= 3, `upsert münaqişə hədəfləri tapıldı (${hedefler.length} ədəd)`);

  for (const h of hedefler) {
    // tdb.js-in etdiyi çevirmənin eynisi
    const parcalar = h.cols.split(',').map(s => s.trim());
    const scoped = (parcalar[0] === 'tenant_id' ? parcalar : ['tenant_id', ...parcalar])
      .map(s => s.toLowerCase()).join(',');
    ok((unikal[h.table] || new Set()).has(scoped),
       `${h.table}: ON CONFLICT (${scoped}) üçün sxemdə unikal indeks var`,
       `sxemdə olanlar: ${[...(unikal[h.table] || [])].join(' | ') || 'heç nə'}`);
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log(`\n${'═'.repeat(62)}`);
  console.log(fail === 0
    ? `🎉  BÜTÜN TESTLƏR KEÇDİ  (${pass}/${pass})`
    : `❌  ${fail} TEST UĞURSUZ  (${pass}/${pass + fail} keçdi)`);
  console.log(`${'═'.repeat(62)}\n`);
  process.exit(fail === 0 ? 1 && 0 : 1);
})().catch(e => {
  console.error('\n💥  Test çöküb:', e);
  process.exit(1);
});
