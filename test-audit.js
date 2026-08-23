'use strict';
// ══════════════════════════════════════════════════════════════════════════
//  HADİSƏ JURNALI · AYIN SNAPSHOT-U · SİL+YAZ  (audit_log, F-16, F-17)
// ══════════════════════════════════════════════════════════════════════════
//  Üç ayrı problem, bir ailə: «sənəd itir».
//
//    audit_log  — «kim nə vaxt nəyi dəyişdi» heç yerdə yazılmırdı.
//    F-16       — ay yenidən açılanda snapshot SİLİNİRDİ.
//    F-17       — sil+yaz atomik deyildi; insert sınsa köhnə data itirdi.
//
//  ⚠️ ƏSAS TESTLƏR:
//    §2 — jurnal funksiyanın yadına düşməsindən ASILI DEYİL (tdb.js-dən doğur).
//    §3 — açar/secret jurnala DÜŞMÜR.
//    §5 — ay açılıb yenidən bağlananda KÖHNƏ rəqəmlər hələ də tapılır.
//    §6 — insert sınanda silinən sətirlər GERİ QAYIDIR.
//
//      node test-audit.js
// ══════════════════════════════════════════════════════════════════════════

process.env.TZ = process.env.TZ || 'Asia/Baku';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://test.local';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test';

const fake = require('./test-fakedb').install();
const T = require('./tenant');
const audit = require('./audit');
const { API } = require('./server');

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else      { fail++; console.log(`  ✗ ${label}${detail ? '\n      → ' + detail : ''}`); }
}
const section = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 52 - t.length))}`);

const KEY_ELM = 'SK-ELMLER-ACARI';
T.__testSeed({
  tenants:  [{ tenant_id: 'cm', name: 'Test', status: 'active', plan: 'pro' }],
  authKeys: [{ key: KEY_ELM, tenant_id: 'cm', role: 'manager', branch_id: 'elmler' }],
  branches: [{ tenant_id: 'cm', branch_id: 'elmler', name: 'Elmlər', active: true, sort_order: 0 }],
  positions: [{ tenant_id: 'cm', name: 'Barista', active: true, sort_order: 0 }],
});
const inCm = (fn) => T.run({ tenantId: 'cm', role: 'admin', branchId: null }, fn);

const SEED = {
  employees: [{ tenant_id: 'cm', id: 'E1', name: 'Aysel', dept: 'Elmlər', secret: 'S1', position: 'Barista' }],
  positions: [{ tenant_id: 'cm', name: 'Barista', sort_order: 0, active: true }],
  salary_periods: [], audit_log: [], cedvel: [], checklist_items: [],
};
const log = () => fake.store.audit_log || [];

console.log('\n══ HADİSƏ JURNALI TESTLƏRİ ══');

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('1. Redaktə (audit.js — sırf funksiya)');
{
  const SIR = 'SK-ELMLER-ACARI';
  ok(audit.redact(SIR, SIR) === '***', 'sorğunun öz açarı gizlədilir');
  ok(audit.redact('FN-MT544NCCM2XY54', SIR) === 'FN-MT544NCCM2XY54',
     'ID-lər GİZLƏDİLMİR (açarla eyni əlifbadadır — şəklə görə süzsək itərdilər)');
  ok(audit.redact({ secret: SIR, id: 'E1' }, SIR).secret === '***', 'iç-içə obyektdə də');
  ok(/data URI/.test(audit.redact('data:image/jpeg;base64,AAAA', SIR)), 'base64 şəkil saxlanılmır');

  const uzun = 'x'.repeat(audit.MAX_STR + 50);
  ok(audit.redact(uzun, SIR).length < uzun.length, 'uzun sətir kəsilir');
  ok(/<25 element>/.test(JSON.stringify(audit.redact(new Array(25).fill(1), SIR))),
     'uzun massiv yalnız sayı ilə yazılır');

  ok(audit.summarize([SIR, 'FN-1', 5], SIR) === '["***","FN-1",5]', 'bütöv arqument siyahısı',
     audit.summarize([SIR, 'FN-1', 5], SIR));
  ok(audit.summarize([{ a: { b: { c: { d: { e: 1 } } } } }], SIR).includes('…'), 'dərinlik məhdudur');
  ok(audit.hasRealWrite([{ table: 'audit_log', op: 'insert' }]) === false,
     'jurnalın öz yazması «yazma» sayılmır (rekursiya olmaz)');
  ok(audit.formatWrites([{ table: 'cedvel', op: 'delete' }, { table: 'cedvel', op: 'insert' },
                         { table: 'cedvel', op: 'insert' }]) === 'cedvel:delete, cedvel:insert×2',
     'hədəf sütunu yığcam yazılır');
}

// ══════════════════════════════════════════════════════════════════════════
section('2. ⚠️ Jurnal YAZMADAN doğur (funksiya heç nə etmir)');
{
  //  Bu, dizaynın özüdür: heç bir API funksiyasında `audit(...)` çağırışı yoxdur.
  //  `tdb.js` yazmanı qeyd edir, dispatcher sətri yazır. Yəni yeni funksiya
  //  yazan adam jurnalı UNUDA BİLMİR.
  const fs = require('fs'), path = require('path');
  const tdbSrc = fs.readFileSync(path.join(__dirname, 'tdb.js'), 'utf8');
  for (const op of ['insert', 'upsert', 'update', 'delete']) {
    ok(new RegExp(`${op}:[^\\n]*noteWrite\\(table, '${op}'\\)`).test(tdbSrc),
       `tdb.${op} yazmanı qeyd edir`);
  }
  ok(!/noteWrite/.test(fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8').replace(/\/\/[^\n]*/g, '')),
     'server.js-də əl ilə `noteWrite` çağırışı YOXDUR (mənbə tək nöqtədir)');

  // Kontekst yazmaları həqiqətən toplayır
  const ctx = { tenantId: 'cm', role: 'admin', branchId: null, writes: [] };
  await T.run(ctx, async () => {
    await require('./tdb').db().from('cedvel').insert({ cedvel_id: 'C1', emp_id: 'E1', date_str: '2026-08-25' });
    await require('./tdb').db().from('cedvel').select('*');
  });
  ok(ctx.writes.length === 1 && ctx.writes[0].table === 'cedvel' && ctx.writes[0].op === 'insert',
     'yalnız YAZMA qeyd olunur, oxuma yox', JSON.stringify(ctx.writes));
}

// ══════════════════════════════════════════════════════════════════════════
section('3. ⚠️ Açar jurnala DÜŞMÜR');
{
  //  Panellər öz açarını həm başlıqda, həm birinci arqument kimi göndərir.
  //  Jurnal uzun müddət saxlanılan cədvəldir — ora açar düşsə, jurnalı oxuyan
  //  hər kəs həmin panelə girə bilər.
  const summary = audit.summarize([KEY_ELM, 'AV-1', 'approved'], KEY_ELM);
  ok(!summary.includes(KEY_ELM), 'açar mətndə görünmür', summary);
  ok(summary.includes('AV-1') && summary.includes('approved'), 'faydalı hissə qalır', summary);
}

// ══════════════════════════════════════════════════════════════════════════
section('4. F-16 — ay yenidən açılanda sətir SİLİNMİR');
{
  fake.reset({ ...SEED, salary_periods: [{
    tenant_id: 'cm', period: '2026-07', closed_at: '2026-08-01T00:00:00Z', closed_by: 'admin',
    config: {}, rows: [{ empId: 'E1', net: 900 }], totals: { cemi: 900 },
  }] });

  const before = await inCm(() => API.getClosedSalaryMonths());
  ok(before.length === 1 && before[0].period === '2026-07', 'ay bağlı görünür');

  const r = await inCm(() => API.reopenSalaryMonth(2026, 7));
  ok(r.success, 'ay açılır', JSON.stringify(r));
  ok((fake.store.salary_periods || []).length === 1, 'SƏTİR BAZADA QALDI (əvvəl DELETE idi)');
  ok(fake.store.salary_periods[0].reopened_at, '`reopened_at` işarələndi');
  ok(fake.store.salary_periods[0].totals.cemi === 900, 'köhnə rəqəmlər toxunulmadan durur');

  const after = await inCm(() => API.getClosedSalaryMonths());
  ok(after.length === 0, 'amma «bağlı aylar» siyahısında görünmür');

  const iki = await inCm(() => API.reopenSalaryMonth(2026, 7));
  ok(!iki.success, 'təkrar açmaq olmur', JSON.stringify(iki));

  ok(log().some(l => l.action === 'reopenSalaryMonth'), 'jurnalda iz var');
}

// ══════════════════════════════════════════════════════════════════════════
section('5. ⚠️ Yenidən bağlayanda KÖHNƏ snapshot itmir');
{
  //  Sətir eyni açarla (tenant_id, period) yenidən yazılır. Köhnə rəqəmlər
  //  üstündən yazılmamışdan ƏVVƏL jurnala köçürülür — «mart iki dəfə bağlanıb,
  //  birinci dəfə rəqəmlər bunlar idi» sualının cavabı budur.
  //  Real bağlama üçün minimal iş günü lazımdır (gəliş + çıxış + cədvəl),
  //  yoxsa `closeSalaryMonth` «ödəniləcək heç nə yoxdur» deyib dayanır.
  fake.reset({
    employees: [{ tenant_id: 'cm', id: 'E1', name: 'Aysel', dept: 'Elmlər', secret: 'S1', position: 'Barista' }],
    cedvel: [{ tenant_id: 'cm', cedvel_id: 'C1', emp_id: 'E1', dept: 'Elmlər',
               date_str: '2026-07-06', shift_type: 'sehersm' }],
    attendance: [
      { tenant_id: 'cm', id: 1, emp_id: 'E1', dept: 'Elmlər', type: 'GƏLİŞ',
        timestamp: '2026-07-06T03:30:00.000Z', shift_type: 'sehersm' },
      { tenant_id: 'cm', id: 2, emp_id: 'E1', dept: 'Elmlər', type: 'CIXIS',
        timestamp: '2026-07-06T12:30:00.000Z', shift_type: 'sehersm' }],
    fines: [], mgr_fines: [], avans: [], audit_log: [],
    //  Ay bir dəfə bağlanıb, sonra AÇILIB — sətir hələ də oradadır.
    salary_periods: [{
      tenant_id: 'cm', period: '2026-07', closed_at: '2026-08-01T00:00:00Z', closed_by: 'admin',
      config: {}, rows: [{ empId: 'E1', net: 900 }], totals: { cemi: 900 },
      reopened_at: '2026-08-10T00:00:00Z', reopened_by: 'admin',
    }],
  });

  const r = await inCm(() => API.closeSalaryMonth(2026, 7));
  ok(r.success, 'açılmış ay yenidən bağlana bilir', JSON.stringify(r));
  ok((fake.store.salary_periods || []).length === 1, 'sətir təkrarlanmır, üstündən yazılır');
  ok(!fake.store.salary_periods[0].reopened_at, 'yeni bağlamada `reopened_at` təmizlənir');

  const kohneIz = log().find(l => /closeSalaryMonth/.test(l.action) && l.before);
  ok(!!kohneIz, '⚠️ köhnə snapshot jurnala köçürüldü (üstündən yazılmadan ƏVVƏL)');
  ok(kohneIz && kohneIz.before.totals.cemi === 900,
     'köhnə cəmi (900) hələ də tapılır — «birinci dəfə rəqəmlər bunlar idi»',
     kohneIz && JSON.stringify(kohneIz.before.totals));
}

// ══════════════════════════════════════════════════════════════════════════
section('6. ⚠️ F-17 — insert sınanda köhnə data GERİ QAYIDIR');
{
  fake.reset({ ...SEED, checklist_items: [
    { tenant_id: 'cm', item_id: 'CI-1', text: 'Barı sil', category: 'Bar', sort_order: 1, active: true },
    { tenant_id: 'cm', item_id: 'CI-2', text: 'Zibili at', category: 'Zal', sort_order: 2, active: true },
  ] });

  // Normal iş pozulmur
  const good = await inCm(() => API.saveChecklistItems([{ text: 'Yeni element', category: 'Bar' }]));
  ok(good.success, 'normal saxlama işləyir');
  ok(fake.store.checklist_items.length === 1, 'siyahı əvəz olundu');

  //  İndi insert-i SÜNİ ŞƏKİLDƏ sındırırıq — bu, əsl ssenaridir (unikal indeks
  //  toqquşması, şəbəkə kəsilməsi, Supabase timeout).
  fake.reset({ ...SEED, checklist_items: [
    { tenant_id: 'cm', item_id: 'CI-1', text: 'Barı sil', category: 'Bar', sort_order: 1, active: true },
    { tenant_id: 'cm', item_id: 'CI-2', text: 'Zibili at', category: 'Zal', sort_order: 2, active: true },
  ] });

  const sb = require('./db');
  const original = sb.from;
  let insertSayi = 0;
  sb.from = (table) => {
    const real = original(table);
    if (table !== 'checklist_items') return real;
    return {
      ...real,
      insert: (rows, o) => {
        insertSayi++;
        // BİRİNCİ insert sınır (yeni data), İKİNCİSİ keçir (geri qaytarma)
        if (insertSayi === 1) return { then: (res) => res({ data: null, error: { message: 'şəbəkə kəsildi' } }) };
        return real.insert(rows, o);
      },
    };
  };

  let res;
  try {
    res = await inCm(() => API.saveChecklistItems([{ text: 'Yeni element', category: 'Bar' }]));
  } finally {
    sb.from = original;
  }

  ok(!res.success, 'xəta qaytarılır (səssiz uğur yoxdur)', JSON.stringify(res));
  ok(res.restored === true, 'cavabda «bərpa olundu» deyilir', JSON.stringify(res));
  ok(/qorundu/i.test(res.reason || ''), 'mesaj istifadəçiyə nə baş verdiyini deyir', res.reason);

  const qalan = (fake.store.checklist_items || []).map(r => r.item_id).sort();
  ok(qalan.length === 2 && qalan[0] === 'CI-1' && qalan[1] === 'CI-2',
     '⚠️ KÖHNƏ İKİ ELEMENT GERİ QAYITDI (əvvəl siyahı BOŞ qalardı)', qalan.join(', '));
}

// ══════════════════════════════════════════════════════════════════════════
section('7. NUL baytı qalmayıb');
{
  //  `savePositions`-da süzgəc `neq('name', '\\0')` idi — görünməz NUL baytı.
  //  Fayl `grep` üçün «binary» sayılırdı və PostgREST-ə NUL göndərmək etibarsızdır.
  const fs = require('fs');
  for (const f of ['server.js', 'utils.js', 'tenant.js', 'tdb.js', 'auth.js', 'audit.js']) {
    const buf = fs.readFileSync(require('path').join(__dirname, f));
    ok(!buf.includes(0), `${f}: NUL baytı yoxdur`);
  }
}

// ══════════════════════════════════════════════════════════════════════════
section('8. Dispatcher — sətir HƏQİQƏTƏN yazılır (HTTP)');
{
  //  Yuxarıdakı testlər `API.*`-ı birbaşa çağırır, yəni dispatcher-i keçmir.
  //  Jurnal isə MƏHZ dispatcher-də yazılır. Ona görə burada real HTTP sorğusu
  //  atılır: server öz portunda qaldırılır, cavab alınır, cədvələ baxılır.
  const { app } = require('./server');
  const http = require('http');
  const srv = await new Promise(r => { const s2 = app.listen(0, () => r(s2)); });
  const port = srv.address().port;

  const post = (fn, args, key) => new Promise((resolve, reject) => {
    const body = JSON.stringify({ args });
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/' + fn, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
                 ...(key ? { 'X-CM-Key': key } : {}) },
    }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject); req.end(body);
  });

  try {
    fake.reset({
      employees: [{ tenant_id: 'cm', id: 'E1', name: 'Aysel', dept: 'Elmlər', secret: 'S1' }],
      late_perms: [{ tenant_id: 'cm', perm_id: 'LP-1', emp_id: 'E1', emp_name: 'Aysel',
                     dept: 'Elmlər', date_str: '2026-08-25', requested_time: '10:00', status: 'pending' }],
      audit_log: [], push_subscriptions: [],
    });

    // OXUMA sorğusu — jurnala DÜŞMƏMƏLİDİR
    await post('getLatePermsForManager', [KEY_ELM], KEY_ELM);
    ok(log().length === 0, 'oxuma sorğusu jurnala düşmür', 'sətir: ' + log().length);

    // YAZMA sorğusu
    const r = await post('approveLatePerm', [KEY_ELM, 'LP-1', 'approved'], KEY_ELM);
    ok(r.status === 200, 'sorğu keçdi', r.status + ' ' + r.body.slice(0, 80));
    ok(log().length === 1, 'yazma sorğusu bir sətir yaratdı', 'sətir: ' + log().length);

    const row = log()[0] || {};
    ok(row.action === 'approveLatePerm', 'funksiya adı yazıldı', row.action);
    ok(row.actor_role === 'manager', 'rol yazıldı', row.actor_role);
    ok(/Elml/.test(row.actor_name || ''), 'filial adı ilə «kim» yazıldı', row.actor_name);
    ok(/late_perms:update/.test(row.target || ''), 'hansı cədvələ toxunulduğu yazıldı', row.target);
    ok(row.ok === true, 'uğurlu kimi işarələndi');
    ok(row.tenant_id === 'cm', 'müştəri sətrə yazıldı');

    //  ⚠️ Ən vacibi: menecer açarı jurnalda GÖRÜNMÜR.
    ok(!String(row.detail || '').includes(KEY_ELM), 'açar `detail`-də YOXDUR', row.detail);
    ok(String(row.detail || '').includes('***') && String(row.detail || '').includes('LP-1'),
       'açar əvəzlənib, hədəf ID qalıb', row.detail);

    //  UĞURSUZ cəhd də yazılır — burada HEÇ NƏ YAZILMIR (sətir tapılmır),
    //  yəni yalnız «yazma olubsa yaz» qaydası bunu qaçırardı. Məhz F-13/F-14
    //  kimi cəhdlər (başqa filialın sətrinə toxunmaq) belə görünür.
    fake.store.audit_log.length = 0;
    await post('approveLatePerm', [KEY_ELM, 'YOXDUR', 'approved'], KEY_ELM);
    const bad = log()[0];
    ok(!!bad, 'uğursuz cəhd də jurnala düşür');
    ok(bad && bad.ok === false, '«uğursuz» kimi işarələnir', bad && String(bad.ok));

    // İcazəsiz açar (dispatcher 403 verir) — bu da jurnalda qalmalıdır,
    // açar sınayan adamı yalnız bu göstərir.
    fake.store.audit_log.length = 0;
    const rd = await post('getFines', [], KEY_ELM);          // menecer açarı, admin funksiyası
    ok(rd.status === 403, 'menecer admin funksiyasına buraxılmır', String(rd.status));
    ok(log().length === 1 && log()[0].target === '(icazəsiz)',
       'icazəsiz cəhd jurnala düşür', JSON.stringify(log()[0] || {}).slice(0, 100));

    // SKIP siyahısı — davamiyyət öz cədvəlində onsuz da izlidir
    fake.store.audit_log.length = 0;
    await post('validateAndLog', ['S1', 'CMQR:x:1'], 'S1');
    ok(log().length === 0, 'davamiyyət jurnala DÜŞMÜR (öz izi var)', 'sətir: ' + log().length);
  } finally {
    await new Promise(r => srv.close(r));
  }
}

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(62)}`);
console.log(fail === 0
  ? `🎉  BÜTÜN TESTLƏR KEÇDİ  (${pass}/${pass})`
  : `❌  ${fail} TEST UĞURSUZ  (${pass}/${pass + fail} keçdi)`);
console.log(`${'═'.repeat(62)}\n`);
process.exit(fail === 0 ? 0 : 1);

})().catch(e => { console.error('\n💥  Test çöküb:', e); process.exit(1); });
