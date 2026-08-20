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
    // querySelector null qaytarsa yüklənmə anındakı kod sınır — bu, testin
    // öz qüsuru olardı, real səhv yox. Ona görə boş element qaytarılır.
    querySelectorAll(){ return []; }, querySelector(sel){ return mkEl(sel); },
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

console.log('\n── Açıq smenlər ──');
calls = [];
vm.runInContext('osLoad()', sandbox);
check(calls.some(c => c.fn === 'getOpenShifts'), 'server çağırışı edilir');
gsr._ok({
  blocking: 1,
  rows: [{
    empId: 'E1', empName: "O'Neil", dept: 'Elmlər', dayStr: '2026-03-10',
    gelisTime: '08:00', gelisIso: '2026-03-10T04:00:00.000Z', shiftType: 'sehersm',
    shiftName: 'Səhər', teklifTime: '16:00', teklifIso: '2026-03-10T12:00:00.000Z', bloklayir: true,
  }],
});
h = els.osBody.innerHTML;
check(h.indexOf('id="osT0"') >= 0, 'çıxış saatı xanası çıxır');
check(h.indexOf('placeholder="16:00"') >= 0, 'təklif olunan saat placeholder kimi görünür');
check(h.indexOf('Girişi bloklayır') >= 0, 'bloklayan qeyd işarələnir');
check(h.indexOf('osClose(0)') >= 0, 'bağla düyməsi var');
check(h.indexOf('undefined') < 0, 'çıxışda "undefined" yoxdur');
check(els.osBadge.innerHTML.indexOf('1') >= 0, 'yan panel nişanı sayı göstərir');

// Boş hal
gsr._ok({ blocking: 0, rows: [] });
check(els.osBody.innerHTML.indexOf('Açıq smen yoxdur') >= 0, 'boş halda aydın mesaj');
check(els.osBadge.innerHTML === '', 'açıq smen olmayanda nişan gizlənir');

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

// ══════════════════════════════════════════════════════════════════
//  MENECER PANELİ — cərimə tavanı (AR ƏM 175)
// ══════════════════════════════════════════════════════════════════
//  Ayrı sandbox: manager.html-in öz JS-i, öz DOM-u.
console.log('\n── Menecer paneli: cərimə tavanı ──');
{
  const mHtml = fs.readFileSync(path.join(ROOT, 'public/manager.html'), 'utf8');
  const mCode = mHtml.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)
    .map(s => s.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, ''))
    .sort((a, b) => b.length - a.length)[0]
    .replace(/<\?=[\s\S]*?\?>/g, '"__TPL__"');

  const mEls = {};
  const mkSelect = (id) => {
    const el = mkEl(id);
    el.options = [
      { value: 'fine', disabled: false }, { value: 'tohmet', disabled: false },
      { value: 'siddetli', disabled: false }, { value: 'sonuncu', disabled: false },
    ];
    el.value = 'fine';
    return el;
  };
  const mDoc = {
    getElementById(id) {
      if (!mEls[id]) mEls[id] = (id === 'fineKind') ? mkSelect(id) : mkEl(id);
      return mEls[id];
    },
    querySelectorAll(){ return []; },
    // null qaytarsaq yüklənmə anında işləyən kod sınır — testin öz qüsuru olardı
    querySelector(sel){ return mkEl(sel); },
    addEventListener(){}, createElement(t){ return mkEl(t); },
    body: mkEl('body'), readyState: 'complete',
  };
  let mCalls = [];
  const mGsr = { run: new Proxy({}, { get(_, prop) {
    if (prop === 'withSuccessHandler') return (fn) => { mGsr._ok = fn; return mGsr.run; };
    if (prop === 'withFailureHandler') return (fn) => { mGsr._fail = fn; return mGsr.run; };
    return (...args) => { mCalls.push({ fn: prop, args }); return mGsr.run; };
  } }) };
  const mSandbox = {
    document: mDoc, console, location: { href: '', search: '' },
    google: { script: { run: mGsr.run } },
    setTimeout(){}, setInterval(){}, clearInterval(){}, clearTimeout(){},
    alert(){}, confirm(){ return true; }, fetch(){ return Promise.resolve(); },
    navigator: { serviceWorker: { register(){ return Promise.resolve(); } } },
    localStorage: { getItem(){ return null; }, setItem(){}, removeItem(){} },
    Notification: { permission: 'default' },
  };
  mSandbox.window = mSandbox; mSandbox.globalThis = mSandbox;
  vm.createContext(mSandbox);
  try {
    vm.runInContext(common, mSandbox, { filename: 'common.js' });
    vm.runInContext(mCode, mSandbox, { filename: 'manager.html' });
    check(true, 'manager.html JS xətasız yüklənir');
  } catch (e) {
    check(false, 'manager.html JS yüklənir', e.message);
  }

  // Tavan hələ dolmayıb
  mEls.fineEmp = mEls.fineEmp || mkEl('fineEmp');
  mEls.fineEmp.value = 'E1';
  mCalls = [];
  vm.runInContext('fineEmpChanged()', mSandbox);
  check(mCalls.some(c => c.fn === 'getFineCapacity'), 'işçi seçiləndə tavan soruşulur');

  mGsr._ok({ success: true, brut: 400, yazilan: 20, limit: 80, qalan: 60, faiz: 20, doludur: false, brutYoxdur: false });
  let h = mDoc.getElementById('fineCapBox').innerHTML;
  check(h.indexOf('60 ₼') >= 0, 'qalan tutum göstərilir');
  check(h.indexOf('20%') >= 0, 'qanuni faiz göstərilir');
  check(mDoc.getElementById('fineKind').options[0].disabled === false, 'tavan boşdursa pul cəriməsi seçilə bilir');

  // Tavan DOLUB → forma məcburi tənbehə keçir
  mEls.fineEmp.value = 'E2';
  vm.runInContext('fineEmpChanged()', mSandbox);
  mGsr._ok({ success: true, brut: 320, yazilan: 120, limit: 64, qalan: 0, faiz: 20, doludur: true, brutYoxdur: false });
  h = mDoc.getElementById('fineCapBox').innerHTML;
  check(h.indexOf('tavanı dolub') >= 0, 'tavan dolanda aydın xəbərdarlıq çıxır');
  check(h.indexOf('töhmət') >= 0, 'töhmət alternativi təklif olunur');
  check(h.indexOf('ƏM 175') >= 0, 'hüquqi əsas göstərilir');
  check(mDoc.getElementById('fineKind').value === 'tohmet', 'forma avtomatik töhmətə keçir');
  check(mDoc.getElementById('fineKind').options[0].disabled === true, 'pul cəriməsi seçimi bağlanır');
  check(mDoc.getElementById('fineAmountRow').style.display === 'none', 'töhmətdə məbləğ sahəsi gizlənir');

  // Cədvəl yoxdursa bloklamırıq
  mEls.fineEmp.value = 'E3';
  vm.runInContext('fineEmpChanged()', mSandbox);
  mGsr._ok({ success: true, brut: 0, yazilan: 0, limit: null, qalan: null, faiz: 20, doludur: false, brutYoxdur: true });
  h = mDoc.getElementById('fineCapBox').innerHTML;
  check(h.indexOf('hesablana bilmir') >= 0, 'cədvəl yoxdursa aydın izah verilir');
  check(h.indexOf('undefined') < 0, 'çıxışda "undefined" yoxdur');

  // Cərimə siyahısında töhmət ayrılır
  vm.runInContext('renderMgrFines', mSandbox)([
    { empName: "O'Neil", amount: 0, reason: 'Gecikmə', status: 'pending', createdAt: '2026-08-20T09:00:00Z',
      source: 'manager', isTohmet: true, kindName: 'Töhmət', expiresYmd: '2027-02-20' },
    { empName: 'Aynur', amount: 40, reason: 'Forma', status: 'acknowledged', createdAt: '2026-08-19T09:00:00Z',
      source: 'manager', isTohmet: false, kindName: 'Cərimə' },
  ]);
  h = mDoc.getElementById('mgrFineList').innerHTML;
  check(h.indexOf('Töhmət') >= 0, 'siyahıda töhmət adı ilə görünür');
  check(h.indexOf('2027-02-20 tarixinədək') >= 0, 'töhmətin müddəti göstərilir');
  check(h.indexOf('40 ₼') >= 0, 'pul cəriməsi məbləği ilə görünür');

  // Töhməti TƏK render et — «0 ₼» yoxlaması başqa sətrin məbləği ilə qarışmasın
  vm.runInContext('renderMgrFines', mSandbox)([
    { empName: 'Tək', amount: 0, reason: 'Gecikmə', status: 'pending', createdAt: '2026-08-20T09:00:00Z',
      source: 'manager', isTohmet: true, kindName: 'Şiddətli töhmət', expiresYmd: '2027-02-20' },
  ]);
  const tekH = mDoc.getElementById('mgrFineList').innerHTML;
  check(tekH.indexOf('₼') < 0, 'töhmətdə heç bir məbləğ göstərilmir');
  check(tekH.indexOf('Şiddətli töhmət') >= 0, 'tənbehin dəqiq növü yazılır');
  check(h.indexOf('undefined') < 0, 'siyahıda "undefined" yoxdur');
}

console.log('\n══════════════════════════════════════════');
console.log(`NƏTİCƏ: ${pass} keçdi, ${fail} uğursuz`);
process.exit(fail ? 1 : 0);
