'use strict';
// ══════════════════════════════════════════════════════════════════════════
//  SAXLANAN XSS TESTİ  (F-26 / F-27)  —  işlət:  node test-xss.js
// ══════════════════════════════════════════════════════════════════════════
//  NİYƏ BU TEST VAR
//  ────────────────
//  F-09-da profil XSS-i bağlandı: `photoData` yoxlanmağa başladı, panel
//  `innerHTML` yerinə DOM qurdu. Düzəliş DOĞRU idi, amma YALNIZ hadisənin
//  baş verdiyi sahəyə tətbiq olundu.
//
//  Eyni SİNİF isə başqa yerlərdə toxunulmamış qaldı və növbəti analizdə
//  yenidən tapıldı:
//    · imtahanın açıq cavabı (`givenText`) → admin və trainer panellərində xam
//    · avans qeydi (`note`)                → menecer panelində xam
//    · cərimə səbəbi (`reason`)            → işçi kartında xam
//
//  Ən aydın sübut: EYNİ sahə `icraci.html`-də düzgün escape olunurdu, amma
//  `admin.html` və `trainer.html`-də yox. Yəni bilik var idi, YAYILMAMIŞDI.
//
//  Ona görə bu fayl bir qüsuru yox, QAYDANI qoruyur:
//    A hissəsi — panelin ÖZ render funksiyasını zərərli data ilə çağırır və
//                çıxışda işlək HTML qalmadığını yoxlayır (davranış).
//    B hissəsi — bütün panelləri statik süzür və escape edilməmiş YENİ sahə
//                tapılan kimi düşür (qarşısını alma).
//
//  B hissəsi əsas olandır: A yalnız bildiyimiz funksiyaları yoxlayır,
//  B isə hələ yazılmamış kodu da tutur. Yeni sahə əlavə edən adam ya onu
//  `esc()` ilə sarımalı, ya da aşağıdakı siyahıya SƏBƏBİ ilə yazmalıdır.
// ══════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const ROOT = __dirname;

let pass = 0, fail = 0;
const check = (ok, label, extra) => {
  if (ok) { pass++; console.log('  ✓', label); }
  else { fail++; console.log('  ✗', label, extra ? '\n      ' + String(extra).slice(0, 300) : ''); }
};

// Zərərli yüklər — hər biri fərqli qaçış yolunu sınayır.
const PAYLOADS = {
  teq:    '<img src=x onerror="alert(1)">',        // yeni teq açmaq
  dirnaq: '" onmouseover="alert(1)',               // atributdan çıxmaq
  skript: '</script><script>alert(1)</script>',    // skript blokunu bağlamaq
  apostrof: "O'Neil\\'; alert(1); //",             // JS sətrindən çıxmaq
};

// Çıxışda BUNLARDAN biri qalıbsa qaçış işləməyib.
function tehlukeli(html) {
  const s = String(html || '');
  const izler = [
    /<img[^>]*onerror/i,
    /<script/i,
    /onmouseover\s*=/i,
    /onerror\s*=\s*["']?alert/i,
  ];
  for (const re of izler) if (re.test(s)) return re.source;
  return null;
}

// ── Panel JS-ini saxta DOM-da işə salan qoşqu (test-admin-ui.js ilə eyni üsul) ──
function panelYukle(fayl) {
  const html   = fs.readFileSync(path.join(ROOT, 'public', fayl), 'utf8');
  const common = fs.readFileSync(path.join(ROOT, 'public/common.js'), 'utf8');
  const blok = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)
    .map(s => s.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, ''))
    .sort((a, b) => b.length - a.length)[0];
  const code = blok.replace(/<\?=[\s\S]*?\?>/g, '"__TPL__"');

  const els = {};
  function mkEl(id) {
    return {
      id, value: '', textContent: '', innerText: '', innerHTML: '', className: '', style: {},
      dataset: {}, checked: false,
      classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
      querySelectorAll() { return []; }, querySelector(s) { return mkEl(s); },
      setAttribute() {}, getAttribute() { return null; }, addEventListener() {},
      appendChild() {}, focus() {}, remove() {},
    };
  }
  const document = {
    getElementById(id) { if (!els[id]) els[id] = mkEl(id); return els[id]; },
    querySelectorAll() { return []; }, querySelector() { return null; },
    addEventListener() {}, createElement(t) { return mkEl(t); },
    body: mkEl('body'), readyState: 'complete',
  };
  const gsr = { run: new Proxy({}, { get(_, p) {
    if (p === 'withSuccessHandler' || p === 'withFailureHandler') return () => gsr.run;
    return () => gsr.run;
  } }) };
  const sandbox = {
    document, console: { log() {}, warn() {}, error() {} },
    location: { href: '', search: '' },
    google: { script: { run: gsr.run } },
    setTimeout() {}, setInterval() {}, clearInterval() {}, clearTimeout() {},
    alert() {}, confirm() { return true; }, prompt() { return ''; },
    fetch() { return Promise.resolve(); },
    navigator: { serviceWorker: { register() { return Promise.resolve(); } }, clipboard: { writeText() {} } },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    Notification: { permission: 'default' },
    JSON, Math, Date, parseInt, parseFloat, isNaN, isFinite,
    String, Number, Array, Object, Boolean, RegExp, Error,
    encodeURIComponent, decodeURIComponent, URLSearchParams, Promise,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(common, sandbox, { filename: 'common.js' });
  try { vm.runInContext(code, sandbox, { filename: fayl }); }
  catch (e) { /* yüklənmə anındakı DOM asılılıqları — funksiyalar yenə də təyin olunur */ }
  return { sandbox, els };
}

// ══════════════════════════════════════════════════════════════════
//  A. DAVRANIŞ — panelin öz funksiyası zərərli data ilə
// ══════════════════════════════════════════════════════════════════
console.log('\n══ SAXLANAN XSS — DAVRANIŞ ══');

console.log('\n── Ortaq köməkçilər ──');
{
  const { sandbox } = panelYukle('admin.html');
  const esc   = vm.runInContext('esc', sandbox);
  const escJs = vm.runInContext('escJs', sandbox);
  check(esc('<b>') === '&lt;b&gt;', 'esc() teqi neytrallaşdırır');
  check(esc('"x"') === '&quot;x&quot;', 'esc() ikiqat dırnağı qaçırır');
  check(escJs("O'Neil") === "O\\'Neil", 'escJs() apostrofu JS üçün qaçırır');
  check(escJs('a"b') === 'a&quot;b', 'escJs() atributu da qoruyur');
  check(escJs('a\\') === 'a\\\\', 'escJs() tərs xətti ikiləyir');
  // escAttr artıq escJs-ə yönləndirilib — köhnə yarımçıq davranış qayıtmasın
  const escAttr = vm.runInContext('escAttr', sandbox);
  check(escAttr('a"b') === 'a&quot;b', 'escAttr() artıq `"` işarəsini də qaçırır (F-27)');
}

console.log('\n── admin: imtahan nəticələri (F-26) ──');
{
  const { sandbox } = panelYukle('admin.html');
  const build = vm.runInContext('buildAdminExamCard', sandbox);

  // İşçinin sərbəst cavabı — bu, hücumun ƏSAS yoludur.
  let out = build({
    emp_name: 'Test', dept: 'Sahil', score: 0, max_score: 0, note: '', trainer_name: 'Özü',
    answers: [{ type: 'open', text: 'Sual', category: '', passed: null, givenText: PAYLOADS.teq }],
  }, 'x1');
  check(!tehlukeli(out), 'işçinin açıq cavabı işlək HTML vermir', tehlukeli(out) && out.slice(0, 240));
  check(out.indexOf('&lt;img') >= 0, 'cavab görünən mətn kimi qalır (data itmir)');

  // Trainerin sərbəst yazdığı ad (`submitTrainerLog` onu olduğu kimi qəbul edir)
  out = build({
    emp_name: 'Test', dept: 'Sahil', score: 0, max_score: 0, note: '',
    trainer_name: PAYLOADS.teq, answers: [],
  }, 'x2');
  check(!tehlukeli(out), 'trainer adı işlək HTML vermir', tehlukeli(out));

  // Digər sahələr
  for (const [ad, obj] of [
    ['işçi adı',    { emp_name: PAYLOADS.teq, dept: 'S', note: '', trainer_name: 'Özü', answers: [] }],
    ['filial adı',  { emp_name: 'T', dept: PAYLOADS.teq, note: '', trainer_name: 'Özü', answers: [] }],
    ['imtahan qeydi', { emp_name: 'T', dept: 'S', note: PAYLOADS.teq, trainer_name: 'Özü', answers: [] }],
    ['sual mətni',  { emp_name: 'T', dept: 'S', note: '', trainer_name: 'Özü',
                      answers: [{ type: 'test', text: PAYLOADS.teq, given: 'A', correct: 'B', options: [] }] }],
  ]) {
    const h = build(Object.assign({ score: 0, max_score: 0 }, obj), 'x3');
    check(!tehlukeli(h), ad + ' escape olunur', tehlukeli(h));
  }
}

console.log('\n── trainer: imtahan nəticələri (F-26) ──');
{
  const { sandbox } = panelYukle('trainer.html');
  const build = vm.runInContext('buildExamCard', sandbox);
  const out = build({
    emp_name: 'Test', dept: 'Sahil', score: 0, max_score: 0, note: '', trainer_name: 'Özü',
    answers: [{ type: 'open', text: 'Sual', category: '', passed: null, givenText: PAYLOADS.teq }],
  }, 'y1');
  check(!tehlukeli(out), 'işçinin açıq cavabı trainer panelində də neytraldır', tehlukeli(out));

  // Trainer panelində işçi düyməsi `onclick="selectEmp('…')"` qurur
  const sel = vm.runInContext('renderEmpList', sandbox);
  if (typeof sel === 'function') {
    vm.runInContext('ALL_EMPS = [{ id: "E1", name: "' + "O'Neil" + '", dept: "Sahil" }]', sandbox);
  }
  check(true, 'panel yükləndi (funksiyalar əlçatandır)');
}

console.log('\n── menecer: avans siyahısı (F-27) ──');
{
  const { sandbox, els } = panelYukle('manager.html');
  vm.runInContext('renderAvans', sandbox)([
    { avansId: 'AV-1', empName: 'Test', amount: 50, note: PAYLOADS.teq, status: 'pending', dateStr: '2026-08-24' },
  ]);
  const h = els.avansList ? els.avansList.innerHTML : '';
  const hamisi = Object.values(els).map(e => e.innerHTML || '').join('');
  check(!tehlukeli(hamisi), 'işçinin avans qeydi menecer panelində neytraldır', tehlukeli(hamisi));
  check(hamisi.indexOf('&lt;img') >= 0 || h === '', 'qeyd görünən mətn kimi qalır');
}

// ══════════════════════════════════════════════════════════════════
//  B. STATİK GÖZƏTÇİ — yeni escape edilməmiş sahə əlavə edilə bilməz
// ══════════════════════════════════════════════════════════════════
console.log('\n══ STATİK GÖZƏTÇİ ══');

//  Serverdən gələn və sərbəst mətn ola bilən sahə adları.
//  Yeni belə sahə əlavə edirsənsə bura da yaz — qoruma onda işləyəcək.
const DATA_SAHELERI = new Set([
  'text', 'note', 'reason', 'name', 'empName', 'emp_name', 'title', 'body',
  'message', 'msg', 'summary', 'comment', 'givenText', 'given', 'answer',
  'desc', 'description', 'label', 'category', 'dept', 'trainer_name',
  'mgr_name', 'mgrName', 'nickname', 'status', 'bio', 'izah',
]);

//  Sətir bunlardan birini daşıyırsa HTML deyil — dialoq mətni və ya
//  mətn xassəsidir, orada qaçış lazım deyil (və zərərlidir: istifadəçi
//  `&amp;` görərdi).
const METN_KONTEKSTI = [
  'confirm(', 'alert(', 'prompt(',
  '.text =', '.text=', '.textContent', '.innerText', '.value =', '.value=',
];

//  QƏSDƏN escape EDİLMƏYƏNLƏR — hər biri yoxlanılıb.
//  Format: 'fayl|ifadə' → səbəb.
//  ⚠️ Bura yeni sətir əlavə etməzdən əvvəl əmin ol ki, dəyər HƏQİQƏTƏN
//  serverdən gəlmir. Şübhə varsa `esc()` yaz — heç nə itmir.
const ICAZELI = {
  'admin.html|r.name':   'recalcAllXP önizləməsi — nəticə alert() ilə göstərilir, HTML deyil',
  'admin.html|c.empName': 'cərimə tavanı önizləməsi — nəticə alert() ilə göstərilir, HTML deyil',
  'mycode.html|ss.label': 'SHIFT_STYLE — panelin öz statik obyekti, serverdən gəlmir',
  'mycode.html|cfg.text': 'gecikmə xəbərdarlığı — panelin öz statik mətni',
  'mycode.html|m.label':  'AN_META — panelin öz statik elan növü etiketi',
  'mycode.html|th.label': 'tema siyahısı — panelin öz statik dəsti',
  'mycode.html|a.label':  'aura siyahısı — panelin öz statik dəsti',
};

const PANELLER = fs.readdirSync(path.join(ROOT, 'public')).filter(f => f.endsWith('.html'));
const IFADE = /\+\s*(?!esc\(|escHtml\(|escAttr\(|escJs\()([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\+/g;

const tapilanlar = [];
for (const f of PANELLER) {
  const lines = fs.readFileSync(path.join(ROOT, 'public', f), 'utf8').split('\n');
  lines.forEach((l, i) => {
    if (METN_KONTEKSTI.some(k => l.includes(k))) return;
    let m; IFADE.lastIndex = 0;
    while ((m = IFADE.exec(l))) {
      if (!DATA_SAHELERI.has(m[2])) continue;
      const acar = f + '|' + m[1] + '.' + m[2];
      if (ICAZELI[acar]) continue;
      tapilanlar.push({ f, ln: i + 1, acar, kod: l.trim().slice(0, 100) });
    }
  });
}

console.log(`\n── ${PANELLER.length} panel süzüldü ──`);
check(tapilanlar.length === 0,
  'escape edilməmiş yeni sahə yoxdur',
  tapilanlar.length
    ? tapilanlar.map(t => `${t.f}:${t.ln}  ${t.acar}\n      ${t.kod}`).join('\n      ')
    : null);

if (tapilanlar.length) {
  console.log('\n  ⚠️  Yuxarıdakı sahələr `esc()` ilə sarılmalıdır.');
  console.log('      HTML deyilsə (alert/confirm/textContent) — bu fayldakı');
  console.log('      `ICAZELI` siyahısına SƏBƏBİ ilə əlavə et.');
}

// İcazə siyahısının özü də köhnəlməməlidir: göstərdiyi sahə artıq yoxdursa xəbər ver.
console.log('\n── İcazə siyahısının təmizliyi ──');
{
  const butun = PANELLER.map(f => ({ f, s: fs.readFileSync(path.join(ROOT, 'public', f), 'utf8') }));
  const olu = Object.keys(ICAZELI).filter(k => {
    const [f, ifade] = k.split('|');
    const rec = butun.find(x => x.f === f);
    return !rec || !rec.s.includes(ifade);
  });
  check(olu.length === 0, 'icazə siyahısında ölü qeyd yoxdur', olu.join(', '));
}

console.log('\n══════════════════════════════════════════');
console.log(`NƏTİCƏ: ${pass} keçdi, ${fail} uğursuz`);
process.exit(fail ? 1 : 0);
