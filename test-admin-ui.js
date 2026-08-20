'use strict';
// ══════════════════════════════════════════════════════════════════
//  Admin panel UI testi —  işlət:  node test-admin-ui.js
// ══════════════════════════════════════════════════════════════════
//  NİYƏ LAZIMDIR: admin.html-də bir sətir JS xətası bütün paneli boş
//  göstərir (bir dəfə produksiyada baş verib — apostroflu ad şablon
//  sətrini qırmışdı). Sintaksis yoxlaması bunu tutmur, çünki səhv
//  YARADILAN mətndə olur.
//
//  Bu test panelin JS-ini saxta DOM-da işə salır, render funksiyalarını
//  real formatda data ilə çağırır və çıxışa baxır. Brauzer və DB lazım deyil.
// ══════════════════════════════════════════════════════════════════
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = __dirname;

const html = fs.readFileSync(path.join(ROOT, 'public/admin.html'), 'utf8');
const common = fs.readFileSync(path.join(ROOT, 'public/common.js'), 'utf8');

// Böyük inline blok
const m = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)
  .map(s => s.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, ''))
  .sort((a, b) => b.length - a.length)[0];

const code = m.replace(/<\?=[\s\S]*?\?>/g, '"__TPL__"');

// ── Minimal DOM ────────────────────────────────────────────────
const els = {};
function mkEl(id) {
  return {
    id, value: '', textContent: '', innerHTML: '', className: '', style: {},
    dataset: {}, checked: false,
    classList: { toggle(){}, add(){}, remove(){}, contains(){ return false; } },
    querySelectorAll(){ return []; }, querySelector(){ return null; },
    setAttribute(){}, getAttribute(){ return null; }, addEventListener(){},
    appendChild(){}, focus(){},
  };
}
const document = {
  getElementById(id) { if (!els[id]) els[id] = mkEl(id); return els[id]; },
  querySelectorAll() { return []; },
  querySelector() { return null; },
  addEventListener() {},
  createElement(t) { return mkEl(t); },
  body: mkEl('body'),
  readyState: 'complete',
};

let calls = [];
const gsr = {
  run: new Proxy({}, {
    get(_, prop) {
      if (prop === 'withSuccessHandler') return (fn) => { gsr._ok = fn; return gsr.run; };
      if (prop === 'withFailureHandler') return (fn) => { gsr._fail = fn; return gsr.run; };
      return (...args) => { calls.push({ fn: prop, args }); return gsr.run; };
    },
  }),
};

const sandbox = {
  document, console, window: {}, location: { href: '', search: '' },
  google: { script: gsr.run ? { run: gsr.run } : {} },
  setTimeout(){}, setInterval(){}, clearInterval(){}, clearTimeout(){},
  alert(){}, confirm(){ return true; }, fetch(){ return Promise.resolve(); },
  navigator: { serviceWorker: { register(){ return Promise.resolve(); } }, clipboard: { writeText(){} } },
  localStorage: { getItem(){ return null; }, setItem(){}, removeItem(){} },
  Notification: { permission: 'default' },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

let pass = 0, fail = 0;
const check = (ok, label, extra) => {
  if (ok) { pass++; console.log('  ✓', label); }
  else { fail++; console.log('  ✗', label, extra ? '\n      ' + extra : ''); }
};

try {
  vm.runInContext(common, sandbox, { filename: 'common.js' });
  vm.runInContext(code, sandbox, { filename: 'admin.html' });
} catch (e) {
  console.log('İCRA XƏTASI:', e.message);
  process.exit(1);
}

console.log('\n── Qaydalar paneli ──');
// Serverin qaytardığı formatın eynisi
sandbox._qdDisc = {
  fineAmount: 30, fineAfterLates: 2, permGraceMins: 5, lunchMaxMins: 30,
  latePenalty: [{ mins: 45, xp: 50 }, { mins: 21, xp: 30 }, { mins: 0, xp: 15 }],
  streakShield: [{ streak: 60, mult: 0.25 }, { streak: 30, mult: 0.5 }],
};
sandbox._qdXp = {
  arrivalXP: 20, openAnswerXP: 15,
  multipliers: [{ streak: 60, mult: 2 }, { streak: 7, mult: 1.25 }],
  milestones: { 7: 50, 30: 250 },
  examTiers: [{ pct: 90, xp: 100 }],
  ratingXP: { 3: 15, 5: 50 },
};

sandbox._qdSub = 'disc';
vm.runInContext('qdRender()', sandbox);
let h = els.qdBody.innerHTML;
check(h.indexOf('id="qdFineAmount"') >= 0, 'cərimə məbləği xanası çıxır');
check(h.indexOf('value="30"') >= 0, 'məbləğ 30 dəyəri ilə dolur');
check((h.match(/class="qd-tier"/g) || []).length === 5, 'pillə sətirləri sayı düzgün (3 cəza + 2 qalxan)',
  'tapıldı: ' + (h.match(/class="qd-tier"/g) || []).length);
check(h.indexOf('qdTierAdd(\'pen\')') >= 0, 'sətir əlavə düyməsi var');
check(h.indexOf('undefined') < 0, 'çıxışda "undefined" yoxdur');

sandbox._qdSub = 'xp';
vm.runInContext('qdRender()', sandbox);
h = els.qdBody.innerHTML;
check(h.indexOf('id="qdArrivalXP"') >= 0, 'gəliş balı xanası çıxır');
check(h.indexOf('qdMapDel(\'ms\',0)') >= 0, 'milestone sil düyməsi var');
check(h.indexOf('undefined') < 0, 'XP tabında "undefined" yoxdur');

console.log('\n── Cərimə əməliyyatları ──');
const sysFine = { fineId: 'FN-1', empName: "O'Neil", amount: 30, source: 'system', payStatus: 'unpaid', status: 'pending' };
let a = vm.runInContext('faFineActions', sandbox)(sysFine);
check(a.indexOf('Bağışla') >= 0, 'sistem cəriməsində «Bağışla» görünür');
check(a.indexOf('deleteAnyFine') < 0 && a.indexOf('faDelete') >= 0, 'sil düyməsi faDelete çağırır');
check(a.indexOf("faDelete(event,'FN-1','system'") >= 0, 'mənbə düzgün ötürülür');
check(a.indexOf("O\\'Neil") >= 0, 'apostroflu ad qaçırılır (panel sınmır)', a);
check(a.indexOf('Tutulacaq') >= 0, 'maaş statusu göstərilir');

const waived = Object.assign({}, sysFine, { payStatus: 'waived' });
a = vm.runInContext('faFineActions', sandbox)(waived);
check(a.indexOf('Bağışlamanı ləğv et') >= 0, 'bağışlanmışda geri qaytarma düyməsi');

const mgrFine = { fineId: 'MF-2', empName: 'Aynur', amount: 15, source: 'manager', status: 'acknowledged' };
a = vm.runInContext('faFineActions', sandbox)(mgrFine);
check(a.indexOf('Bağışla') < 0, 'menecer cəriməsində «Bağışla» YOXDUR (ödəniş statusu ona aid deyil)');
check(a.indexOf("'manager'") >= 0, 'menecer mənbəyi düzgün');
check(a.indexOf('Sil') >= 0, 'menecer cəriməsi də silinə bilir');

console.log('\n── Telegram şablon redaktoru ──');
calls = [];
vm.runInContext('loadTplEditor()', sandbox);
check(calls.some(c => c.fn === 'getTgTemplates'), 'server çağırışı edilir');
// Serverin cavabını simulyasiya et
gsr._ok({
  config: { arrive: '<b>{ad}</b> smendə.', lunchGo: '' },
  defaults: {}, keys: ['arrive', 'lunchGo'],
  meta: { arrive: { ad: 'Gəliş', vars: ['ad', 'saat'] }, lunchGo: { ad: 'Nahara getdi', vars: ['ad'] } },
});
h = els.tplBody.innerHTML;
check(h.indexOf('id="tpl_arrive"') >= 0, 'şablon sahəsi qurulur');
check(h.indexOf('&lt;b&gt;{ad}&lt;/b&gt;') >= 0, 'HTML teqləri textarea-da escape olunur', h.slice(0, 300));
check(h.indexOf('tplInsert(\'arrive\',\'{saat}\')') >= 0, 'yer tutucu düyməsi işləyir');
check(h.indexOf('Nahara getdi') >= 0, 'ikinci şablon da çıxır');

console.log('\n── Telefon (push) bildiriş redaktoru ──');
calls = [];
vm.runInContext('loadPushEditor()', sandbox);
check(calls.some(c => c.fn === 'getPushTemplates'), 'server çağırışı edilir');
gsr._ok({
  config: { mgrFine: { title: '⚠️ Cərimə', body: '{mebleg} AZN — {sebeb}' } },
  defaults: {}, keys: ['mgrFine'],
  meta: { mgrFine: { ad: 'Cərimə bildirişi', vars: ['mebleg', 'sebeb'] } },
});
h = els.pshBody.innerHTML;
check(h.indexOf('id="pshT_mgrFine"') >= 0, 'başlıq sahəsi qurulur');
check(h.indexOf('id="pshB_mgrFine"') >= 0, 'mətn sahəsi qurulur');
check(h.indexOf('value="⚠️ Cərimə"') >= 0, 'başlıq dəyəri dolur');
check(h.indexOf('pshInsert(\'mgrFine\',\'{sebeb}\')') >= 0, 'yer tutucu düyməsi işləyir');
check(h.indexOf('undefined') < 0, 'çıxışda "undefined" yoxdur');

// Şablonu olmayan açar (server yeni açar əlavə edib, config köhnədir) sınmamalıdır
gsr._ok({ config: {}, defaults: {}, keys: ['examDone'], meta: {} });
h = els.pshBody.innerHTML;
check(h.indexOf('id="pshT_examDone"') >= 0, 'config-də olmayan açar da boş sahə ilə çıxır');
check(h.indexOf('undefined') < 0, 'boş konfiqurasiyada "undefined" sızmır');

console.log('\n══════════════════════════════════════════');
console.log(`NƏTİCƏ: ${pass} keçdi, ${fail} uğursuz`);
process.exit(fail ? 1 : 0);
