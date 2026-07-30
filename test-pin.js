'use strict';
// ══════════════════════════════════════════════════════════════════
//  PIN alqoritmi uyğunluq testi —  işlət:  node test-pin.js
// ══════════════════════════════════════════════════════════════════
//  Server (utils.js) və brauzer (public/common.js) EYNİ PIN-i yaratmalıdır.
//  Fərqlənsə heç bir işçi gəliş qeyd edə bilməz — ona görə bu test var.
// ══════════════════════════════════════════════════════════════════

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://test.local';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test';

const fs = require('fs');
const U = require('./utils');

// common.js-i olduğu kimi yüklə (brauzerdəki ilə eyni kod işləsin)
const src = fs.readFileSync('public/common.js', 'utf8');
const sandbox = {};
new Function('exports', src + '\nexports.generateDynamicPin = generateDynamicPin;\nexports.esc = esc;\nexports.toYMD = toYMD;\nexports.fmtDMY = fmtDMY;')(sandbox);

let pass = 0, fail = 0;
function check(ok, label) { if (ok) pass++; else { fail++; console.log('  ✗ ' + label); } }

// ── 1) PIN: server ↔ brauzer ──
console.log('1) PIN — utils.js (server) ↔ common.js (brauzer)');
const AB = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
let n = 0;
for (let t = 0; t < 20000; t++) {
  let sec = '';
  for (let k = 0; k < 8; k++) sec += AB[Math.floor(Math.random() * AB.length)];
  const tw = Math.floor(Date.now() / 10000) + Math.floor(Math.random() * 200000) - 100000;
  const a = U.generateDynamicPin(sec, tw), b = sandbox.generateDynamicPin(sec, tw);
  if (a !== b) { check(false, `secret=${sec} tw=${tw} → server ${a} ≠ brauzer ${b}`); break; }
  n++;
}
// kənar hallar
for (const [s, t] of [['', 0], ['A', -1], ['ZZZZZZZZ', 2147483647], ['ÄÖÜ', 999999], ['x'.repeat(64), 123456789]]) {
  check(U.generateDynamicPin(s, t) === sandbox.generateDynamicPin(s, t), `kənar hal: "${s}" / ${t}`);
  n++;
}
check(true, '');
console.log(`  ${n} ssenari — uyğun`);

// PIN formatı
const p = sandbox.generateDynamicPin('ABC12345', 12345);
check(/^\d{4}$/.test(p), 'PIN 4 rəqəm deyil: ' + p);

// ── 2) esc — HTML injeksiyasına qarşı ──
console.log('\n2) esc() — HTML təhlükəsizliyi');
check(sandbox.esc('<script>') === '&lt;script&gt;', 'teq escape olunmur');
check(sandbox.esc('a&b') === 'a&amp;b', '& escape olunmur');
check(sandbox.esc('"x"') === '&quot;x&quot;', 'dırnaq escape olunmur');
check(sandbox.esc(null) === '', 'null → boş sətir olmalıdır');
check(sandbox.esc(undefined) === '', 'undefined → boş sətir olmalıdır');
check(sandbox.esc(0) === '0', '0 → "0" olmalıdır (köhnə ops nüsxəsi burada səhv idi)');
check(sandbox.esc("O'Neil") === "O'Neil", 'apostrof toxunulmamalıdır');

// ── 3) toYMD / fmtDMY ──
console.log('\n3) Tarix köməkçiləri');
const d = new Date(2026, 0, 5);            // 5 Yanvar 2026
check(sandbox.toYMD(d) === '2026-01-05', 'toYMD səhv: ' + sandbox.toYMD(d));
check(sandbox.toYMD(d) === U.toYMD(d), 'toYMD server ilə uyğun deyil');
check(sandbox.fmtDMY('2026-01-05') === '05.01.2026', 'fmtDMY sətir formatı səhv');
check(sandbox.fmtDMY(d) === '05.01.2026', 'fmtDMY Date formatı səhv');
check(sandbox.fmtDMY('') === '', 'fmtDMY boş dəyər');
check(sandbox.fmtDMY('naməlum') === 'naməlum', 'fmtDMY tanınmayan dəyəri qaytarmalıdır');

// ── 4) common.js-də const/let olmamalıdır (panel skriptini sındırır) ──
console.log('\n4) common.js quruluşu');
const kod = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check(!/^\s*(const|let)\s/m.test(kod), 'common.js-də top-level const/let var — panel SyntaxError verə bilər!');

console.log(`\n${'═'.repeat(50)}\nNƏTİCƏ: ${pass} keçdi, ${fail} uğursuz`);
process.exit(fail ? 1 : 0);
