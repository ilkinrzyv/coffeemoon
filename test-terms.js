'use strict';
// ══════════════════════════════════════════════════════════════════════════
//  TERMİNOLOGİYA TESTLƏRİ  —  node test-terms.js
// ══════════════════════════════════════════════════════════════════════════
//  `public/terms.js` müştərinin seçdiyi sözləri panellərə tətbiq edir.
//  Azərbaycan dili şəkilçili olduğu üçün sadə "tap-əvəz et" kifayət etmir:
//
//    İşçi + lər  →  Əməkdaş + LAR   (sait ahəngi: "Əməkdaşlər" yanlışdır)
//    İşçi + nin  →  Əməkdaş + IN    (bitişdirici "n" düşür)
//    Filial + ın →  Şöbə + NİN      (bitişdirici "n" əlavə olunur)
//    Nahar + a   →  Fasilə + YƏ     (yönlük halda "y")
//
//  Bu testlər həmin qaydaları qoruyur — brauzer lazım deyil.
// ══════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const vm = require('vm');

// terms.js IIFE-dir; `convert` funksiyasını test üçün çıxarırıq.
function loadConvert(terms) {
  const src = fs.readFileSync(require('path').join(__dirname, 'public', 'terms.js'), 'utf8')
    .replace('function run() {', 'sandbox.__convert = convert;\n  function run() {');
  const sandbox = {
    window: { TERMS: terms },
    document: { readyState: 'complete', addEventListener() {}, body: {} },
    NodeFilter: { SHOW_TEXT: 4, FILTER_REJECT: 2, FILTER_ACCEPT: 1 },
    MutationObserver: function () { this.observe = function () {}; },
  };
  sandbox.sandbox = sandbox;
  vm.createContext(sandbox);
  try { vm.runInContext(src, sandbox); } catch (_) { /* DOM olmadığı üçün run() kəsilə bilər */ }
  return sandbox.__convert || null;
}

let pass = 0, fail = 0;
function check(got, want, label) {
  if (got === want) { pass++; console.log('  ✅ ' + label.padEnd(30) + JSON.stringify(got)); }
  else { fail++; console.log('  ❌ ' + label.padEnd(30) + JSON.stringify(got) + '   gözlənilən: ' + JSON.stringify(want)); }
}

console.log('\n══ TERMİNOLOGİYA ══');

// ── 1) Şəkilçi + sait ahəngi ──
console.log('\n1) Şəkilçilər və sait ahəngi');
const c1 = loadConvert({ 'İşçi': 'Əməkdaş', 'Filial': 'Şöbə', 'Smen': 'Növbə', 'Nahar': 'Fasilə' });
if (!c1) { console.log('  ❌ convert yüklənmədi'); process.exit(1); }

check(c1('Filial Seçin'),   'Şöbə Seçin',      'sadə söz');
check(c1('İşçilər'),        'Əməkdaşlar',      'cəm: incə → qalın');
check(c1('Filiallar'),      'Şöbələr',         'cəm: qalın → incə');
check(c1('Filialda'),       'Şöbədə',          'yerlik hal');
check(c1('Smendə'),         'Növbədə',         'yerlik hal (incə)');
check(c1('İşçinin adı'),    'Əməkdaşın adı',   'yiyəlik: bitişdirici düşür');
check(c1('Filialın adı'),   'Şöbənin adı',     'yiyəlik: bitişdirici əlavə olunur');
check(c1('Nahara getdi'),   'Fasiləyə getdi',  'yönlük: "y" bitişdiricisi');
check(c1('Filialdan'),      'Şöbədən',         'çıxışlıq hal');

// ── 2) Böyük/kiçik hərf ──
console.log('\n2) Böyük/kiçik hərf naxışı');
check(c1('FİLİAL'),  'ŞÖBƏ',  'hamısı böyük');
check(c1('Filial'),  'Şöbə',  'ilk hərf böyük');
check(c1('filial'),  'şöbə',  'hamısı kiçik');
check(c1('FİLİALLAR'), 'ŞÖBƏLƏR', 'böyük + şəkilçi');

// ── 3) Yanlış yerə toxunmamalıdır ──
console.log('\n3) Təhlükəsizlik — yanlış əvəzləmə olmamalıdır');
check(c1('Filialbaşqasöz'), 'Filialbaşqasöz', 'uzun söz içində dəyişmir');
check(c1('Ofisial sənəd'),  'Ofisial sənəd',  'oxşar söz toxunulmur');
check(c1('Bu ay 3 işçi'),   'Bu ay 3 əməkdaş','rəqəmdən sonra');
check(c1('(Filial)'),       '(Şöbə)',         'mötərizə içində');

// ── 4) Əvəzləmə yoxdursa heç nə dəyişmir ──
console.log('\n4) Boş konfiqurasiya');
const c2 = loadConvert({});
check(c2 === null ? 'skript dayandı' : c2('Filial'), 'skript dayandı', 'boş TERMS → işləmir');
const c3 = loadConvert({ 'Filial': 'Filial' });
check(c3 === null ? 'skript dayandı' : c3('Filial'), 'skript dayandı', 'eyni söz → işləmir');

console.log('\n' + '═'.repeat(56));
console.log(fail === 0 ? `🎉  BÜTÜN TESTLƏR KEÇDİ  (${pass}/${pass})` : `❌  ${fail} uğursuz  (${pass}/${pass + fail})`);
console.log('═'.repeat(56) + '\n');
process.exit(fail ? 1 : 0);
