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
process.env.ADMIN_KEY = 'TEST-ADMIN-KEY';

const fs = require('fs');
const U = require('./utils');

// Panel açarlarını təqlid et (settings cədvəli olmadan)
const FAKE = { EXEC_KEY: 'TEST-EXEC', TRAINER_KEY: 'TEST-TRAINER', OPS_KEY: 'TEST-OPS' };
const BRANCH_KEY = 'TEST-BRANCH';
U.getSetting = (k) => FAKE[k] || '';
U.validateBranchScheduleKey = (k) => (k === BRANCH_KEY ? { valid: true, dept: 'Sahil' } : { valid: false });

const auth = require('./auth');

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
  'admin.html':     process.env.ADMIN_KEY,
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
  const denied = called.filter(f => !auth.apiAccess(f, key).ok);
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
  check(!auth.apiAccess(fn, '').ok,            `${fn} açarsız keçdi!`);
  check(!auth.apiAccess(fn, 'ZIBIL').ok,       `${fn} yanlış açarla keçdi!`);
  check(!auth.apiAccess(fn, BRANCH_KEY).ok,    `${fn} menecer açarı ilə keçdi!`);
  check(auth.apiAccess(fn, process.env.ADMIN_KEY).ok, `${fn} admin üçün bağlıdır!`);
}
console.log(`  ${MUST_DENY.length} kritik funksiya × 4 ssenari yoxlanıldı`);

// staff funksiyası: panel açarı olan keçir, olmayan keçmir
check(auth.apiAccess('getMonthlyReport', FAKE.EXEC_KEY).ok, 'icraçı hesabatı görmür');
check(auth.apiAccess('getExamQuestions', FAKE.TRAINER_KEY).ok, 'trainer sualları görmür');
check(!auth.apiAccess('getExamQuestions', '').ok, 'imtahan cavabları açıq qalıb!');
check(!auth.apiAccess('getMonthlyReport', '').ok, 'hesabat açarsız açıqdır!');

// public funksiyalar həmişə keçməlidir
section('4) Açıq (public) funksiyalar açarsız işləyir');
for (const fn of ['validateAndLog', 'checkScanDevice', 'getEmployeesLite', 'submitEmployeeExam', 'getExamQuestionsPublic', 'getExamStatus']) {
  check(auth.apiAccess(fn, '').ok, `${fn} açarsız rədd olunur — səhifə sınacaq!`);
}
// getEmployeesLite secret sızdırmamalıdır
const lite = srv.match(/API\.getEmployeesLite[\s\S]*?\n\};/);
check(lite && !/secret/.test(lite[0]), 'getEmployeesLite secret qaytarır!');

// naməlum funksiya → fail-closed
section('5) Cədvəldə olmayan funksiya fail-closed');
check(!auth.apiAccess('yeniFunksiya', '').ok, 'naməlum funksiya açarsız keçdi!');
check(!auth.apiAccess('yeniFunksiya', BRANCH_KEY).ok, 'naməlum funksiya menecerə açıqdır!');
check(auth.apiAccess('yeniFunksiya', process.env.ADMIN_KEY).ok, 'naməlum funksiya admin üçün bağlıdır');

console.log(`\n${'═'.repeat(50)}\nNƏTİCƏ: ${pass} keçdi, ${fail} uğursuz`);
process.exit(fail ? 1 : 0);
