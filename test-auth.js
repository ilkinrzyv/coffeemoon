'use strict';
// ══════════════════════════════════════════════════════════════════
//  API icazə qatının testi —  işlət:  node test-auth.js
// ══════════════════════════════════════════════════════════════════
//  Serveri qaldırmır, Supabase-ə qoşulmur. Yoxlayır:
//   1) Hər API funksiyasının icazə cədvəlində qeydi var (fail-closed boşluq yoxdur).
//   2) Hər panelin çağırdığı BÜTÜN funksiyalar həmin panelin açarı ilə keçir (sınmır).
//   3) Kritik funksiyalar açarsız/yad açarla RƏDD olunur.
// ══════════════════════════════════════════════════════════════════

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://test.local';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test';

const fs = require('fs');
const { enterTenant } = require('./test-helpers');
enterTenant();   // müştəri kontekstini qur (test-helpers açarları da səpir)

const T    = require('./tenant');
const auth = require('./auth');

// ÇOX-MÜŞTƏRİLİ DƏYİŞİKLİK:
// `apiAccess` artıq XAM AÇAR yox, həll edilmiş qeyd qəbul edir:
//   { tenantId, role, branchId }
// Səbəb: dispatcher açarı onsuz da bir dəfə həll edir (həm tenant kontekstini
// qurmaq, həm rolu bilmək üçün) — iki dəfə həll etməyin mənası yoxdur.
// Aşağıdakı köməkçi testləri əvvəlki kimi AÇARLA yazmağa imkan verir.
const ADMIN_KEY   = 'TEST-ADMIN';
const BRANCH_KEY  = 'TEST-MGR-ELM';
const FAKE = { EXEC_KEY: 'TEST-EXEC', TRAINER_KEY: 'TEST-TRAINER', OPS_KEY: 'TEST-OPS' };

const access = (fn, key) => auth.apiAccess(fn, T.resolveKeySync(key || ''));

let pass = 0, fail = 0;
function check(ok, label) {
  if (ok) { pass++; } else { fail++; console.log('  ✗ ' + label); }
}
function section(t) { console.log('\n' + t); }

// ── 1) Əhatə: server.js-dəki hər API funksiyası cədvəldə varmı? ──
section('1) İcazə cədvəlinin əhatəsi');
const srv = fs.readFileSync('server.js', 'utf8');
const fns = [...srv.matchAll(/^API\.([a-zA-Z0-9_]+)\s*=/gm)].map(m => m[1]);
const missing = fns.filter(f => !(f in auth.API_POLICY));
const stale = Object.keys(auth.API_POLICY).filter(p => !fns.includes(p));
check(missing.length === 0, 'cədvəldə olmayan funksiya: ' + missing.join(', '));
check(stale.length === 0, 'cədvəldə artıq (mövcud olmayan) ad: ' + stale.join(', '));
console.log(`  ${fns.length} funksiya, ${Object.keys(auth.API_POLICY).length} qeyd`);

// ── 2) Hər panel öz açarı ilə işləyirmi? (ən vacib test) ──
section('2) Panellərin çağırışları öz açarı ilə keçir');
const PAGES = {
  'admin.html':     ADMIN_KEY,
  'manager.html':   BRANCH_KEY,
  'checklist.html': BRANCH_KEY,
  'trainer.html':   FAKE.TRAINER_KEY,
  'icraci.html':    FAKE.EXEC_KEY,
  'ops.html':       FAKE.OPS_KEY,
  'mycode.html':    'RANDOMEMPSECRET',   // işçi secret-i — panel rolu vermir
  'exam.html':      '',                  // açarsız səhifə
  'passpage.html':  '',                  // kiosk — açarsız
};
for (const [file, key] of Object.entries(PAGES)) {
  let html = '';
  try { html = fs.readFileSync('public/' + file, 'utf8'); } catch (e) { continue; }
  const called = fns.filter(f => new RegExp('[.\'"]' + f + '[\'"(\\s]').test(html));
  const denied = called.filter(f => !access(f, key).ok);
  check(denied.length === 0, `${file} — bu çağırışlar RƏDD olunur: ${denied.join(', ')}`);
  console.log(`  ${file.padEnd(15)} ${String(called.length).padStart(2)} çağırış — ${denied.length ? '✗ ' + denied.length + ' RƏDD' : 'hamısı keçir ✓'}`);
}

// ── 3) Kritik funksiyalar həqiqətən qorunurmu? ──
section('3) Kritik funksiyalar açarsız/yad açarla rədd olunur');
const MUST_DENY = [
  'getEmployees',            // işçi secret-lərini qaytarır
  'removeEmployee',          // kaskad silmə
  'getBranchScheduleKeys',   // bütün menecer açarları
  'getTelegramSettings',     // bot tokeni
  'saveBranchIPs',           // WiFi qoruması
  'getExecKey', 'getTrainerKey', 'getOpsKey',
  'regenerateExecKey', 'regenerateTrainerKey', 'regenerateOpsKey',
  'recalcAllXP', 'saveAnnouncement', 'getXPAuditLog',
  'getSalaryReport',         // bütün filialların maaşı + cərimə səbəbləri + avans
  'getSalaryConfig',         // dərəcələr (kimin nə aldığı)
];
for (const fn of MUST_DENY) {
  check(!access(fn, '').ok,            `${fn} açarsız keçdi!`);
  check(!access(fn, 'ZIBIL').ok,       `${fn} yanlış açarla keçdi!`);
  check(!access(fn, BRANCH_KEY).ok,    `${fn} menecer açarı ilə keçdi!`);
  check(access(fn, ADMIN_KEY).ok, `${fn} admin üçün bağlıdır!`);
}
console.log(`  ${MUST_DENY.length} kritik funksiya × 4 ssenari yoxlanıldı`);

// staff funksiyası: panel açarı olan keçir, olmayan keçmir
check(access('getMonthlyReport', FAKE.EXEC_KEY).ok, 'icraçı hesabatı görmür');
check(access('getExamQuestions', FAKE.TRAINER_KEY).ok, 'trainer sualları görmür');
check(!access('getExamQuestions', '').ok, 'imtahan cavabları açıq qalıb!');
check(!access('getMonthlyReport', '').ok, 'hesabat açarsız açıqdır!');

// public funksiyalar həmişə keçməlidir
section('4) Açıq (public) funksiyalar açarsız işləyir');
for (const fn of ['validateAndLog', 'checkScanDevice', 'getEmployeesLite', 'submitEmployeeExam', 'getExamQuestionsPublic', 'getExamStatus']) {
  check(access(fn, '').ok, `${fn} açarsız rədd olunur — səhifə sınacaq!`);
}
// getEmployeesLite secret sızdırmamalıdır
const lite = srv.match(/API\.getEmployeesLite[\s\S]*?\n\};/);
check(lite && !/secret/.test(lite[0]), 'getEmployeesLite secret qaytarır!');

// naməlum funksiya → fail-closed
section('5) Cədvəldə olmayan funksiya fail-closed');
check(!access('yeniFunksiya', '').ok, 'naməlum funksiya açarsız keçdi!');
check(!access('yeniFunksiya', BRANCH_KEY).ok, 'naməlum funksiya menecerə açıqdır!');
check(access('yeniFunksiya', ADMIN_KEY).ok, 'naməlum funksiya admin üçün bağlıdır');

console.log(`\n${'═'.repeat(50)}\nNƏTİCƏ: ${pass} keçdi, ${fail} uğursuz`);
process.exit(fail ? 1 : 0);
