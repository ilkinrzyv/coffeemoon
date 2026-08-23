'use strict';
// ══════════════════════════════════════════════════════════════════════════
//  İMTAHAN — XP FERMİ VƏ KİMLİK  (F-08)
// ══════════════════════════════════════════════════════════════════════════
//  Bu testlərin cavab verdiyi sual: "kim, kimin adından, neçə dəfə?"
//
//  Əvvəl zəncir tam açıq idi:
//    · `submitEmployeeExam` `'public'` idi və `empId` sadəcə ARQUMENT idi
//      → istənilən şəxs istənilən işçinin adından imtahan göndərə bilirdi;
//    · `getEmployeesLite` də açıq idi → bütün işçi ID-ləri hazır siyahı kimi;
//    · cavabda DÜZGÜN CAVABLAR qayıdırdı;
//    · nə `EXAM_ACTIVE` yoxlanırdı, nə də limit vardı.
//  Yəni: sualları al → bir dəfə göndər → cavabları oxu → 100% ilə SONSUZ
//  sayda yenidən göndər. Hər dəfə XP. Reytinq və liqa mənasızlaşırdı.
//
//  ⚠️ Düzgün cavablar HƏLƏ DƏ qaytarılır — nəticə ekranındakı «harada səhv
//  etdim» icmalı təlimin əsas faydasıdır. Fermanı bağlayan şey cavabları
//  gizlətmək YOX, kimlik (secret) + GÜNDƏ BİR imtahan qaydasıdır.
//  ƏSAS TESTLƏR: 3 (təkrar göndərmə) və 4 (kimlik uydurulmur).
//
//      node test-exam.js
// ══════════════════════════════════════════════════════════════════════════

process.env.TZ = process.env.TZ || 'Asia/Baku';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://test.local';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test';

const fake = require('./test-fakedb').install();
const T = require('./tenant');
const U = require('./utils');
const { API } = require('./server');

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else      { fail++; console.log(`  ✗ ${label}${detail ? '\n      → ' + detail : ''}`); }
}
const section = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 52 - t.length))}`);

function seedTenant(examActive) {
  T.__testSeed({
    tenants:  [{ tenant_id: 'cm', name: 'Test', status: 'active', plan: 'pro' }],
    branches: [{ tenant_id: 'cm', branch_id: 'elmler', name: 'Elmlər', active: true, sort_order: 0 }],
    settings: [{ tenant_id: 'cm', key: 'EXAM_ACTIVE', value: examActive ? 'true' : 'false' }],
  });
}
const inCm = (fn) => T.run({ tenantId: 'cm', role: 'system', branchId: null }, fn);

const QS = [
  { tenant_id: 'cm', question_id: 'Q1', text: 'Espresso neçə saniyə çəkilir?', type: 'test',
    options: [{ label: 'A', text: '25-30' }, { label: 'B', text: '5' }], correct: 'A',
    category: 'Bar', role: 'barista', active: true, sort_order: 1 },
  { tenant_id: 'cm', question_id: 'Q2', text: 'Süd neçə dərəcədə köpüklənir?', type: 'test',
    options: [{ label: 'A', text: '90' }, { label: 'B', text: '60-65' }], correct: 'B',
    category: 'Bar', role: 'barista', active: true, sort_order: 2 },
  { tenant_id: 'cm', question_id: 'Q3', text: 'Müştəri şikayət edərsə nə edərsən?', type: 'open',
    options: [], correct: '', category: 'Servis', role: 'umumi', active: true, sort_order: 3 },
];
const SEED = {
  employees: [
    { tenant_id: 'cm', id: 'E1', name: 'Aysel', dept: 'Elmlər', secret: 'S1', xp: 0, streak: 0, is_test: false },
    { tenant_id: 'cm', id: 'E2', name: 'Rəşad', dept: 'Elmlər', secret: 'S2', xp: 0, streak: 0, is_test: false },
    { tenant_id: 'cm', id: 'ET', name: 'Test',  dept: 'Elmlər', secret: 'ST', xp: 0, streak: 0, is_test: true  },
  ],
  exam_questions: QS,
  trainer_exams: [],
  push_subscriptions: [],
};

// Tam düz cavab (client yalnız «hansı suala nə dedim» göndərir)
const DUZ = [
  { questionId: 'Q1', given: 'A' },
  { questionId: 'Q2', given: 'B' },
  { questionId: 'Q3', givenText: 'Dinləyirəm və üzr istəyirəm.' },
];
const exams = () => fake.store.trainer_exams || [];
const emp = (id) => (fake.store.employees || []).find(e => e.id === id);

console.log('\n══ İMTAHAN TESTLƏRİ ══');

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('1. Normal axın');
{
  seedTenant(true); fake.reset(SEED);
  const st = await inCm(() => API.getExamStatus('S1'));
  ok(st.active && st.known, 'status: imtahan açıq, işçi tanınır', JSON.stringify(st));
  ok(st.empName === 'Aysel' && st.dept === 'Elmlər', 'kimlik serverdən gəlir');
  ok(st.doneToday === false, 'bu gün hələ verilməyib');

  const qs = await inCm(() => API.getMyExamQuestions('S1', 'barista'));
  ok(qs.length === 3, 'barista sualları gəlir (umumi daxil)', 'say: ' + qs.length);
  ok(qs.every(q => !('correct' in q)), 'suallarla birlikdə DÜZGÜN CAVAB göndərilmir');

  const r = await inCm(() => API.submitEmployeeExam('S1', 'barista', DUZ));
  ok(r.success, 'imtahan qəbul olunur', JSON.stringify(r).slice(0, 120));
  ok(r.score === 2 && r.maxScore === 2, 'bal serverdə hesablanır (2/2 test)', `${r.score}/${r.maxScore}`);
  ok(exams().length === 1, 'bir sətir yazıldı');
  ok(emp('E1').xp === 100, 'XP verildi (100% → 100 bal)', String(emp('E1').xp));
}

// ══════════════════════════════════════════════════════════════════════════
section('2. İmtahan bağlıdırsa');
{
  seedTenant(false); fake.reset(SEED);
  const qs = await inCm(() => API.getMyExamQuestions('S1', 'barista'));
  ok(qs.length === 0, 'bağlı imtahanın sualları verilmir (API-yə birbaşa müraciətlə də)');

  const r = await inCm(() => API.submitEmployeeExam('S1', 'barista', DUZ));
  ok(!r.success, 'bağlı imtahana cavab göndərilmir', JSON.stringify(r));
  ok(exams().length === 0, 'sətir yazılmadı');
  ok(emp('E1').xp === 0, 'XP verilmədi');
}

// ══════════════════════════════════════════════════════════════════════════
section('3. ⚠️ TƏKRAR GÖNDƏRMƏ — fermanın özü');
{
  seedTenant(true); fake.reset(SEED);
  const r1 = await inCm(() => API.submitEmployeeExam('S1', 'barista', DUZ));
  ok(r1.success, 'birinci cəhd keçir');
  ok(emp('E1').xp === 100, 'XP bir dəfə verildi');

  //  Köhnə kodda burada 100 XP daha gəlirdi — və sonsuz sayda.
  const r2 = await inCm(() => API.submitEmployeeExam('S1', 'barista', DUZ));
  ok(!r2.success, 'İKİNCİ cəhd RƏDD olunur', JSON.stringify(r2));
  ok(/bu gün/i.test(r2.reason || ''), 'səbəb aydındır', r2.reason);
  ok(exams().length === 1, 'ikinci sətir yaranmadı');
  ok(emp('E1').xp === 100, 'XP artmadı — ferma bağlıdır', String(emp('E1').xp));

  const st = await inCm(() => API.getExamStatus('S1'));
  ok(st.doneToday === true, 'status «bu gün verilib» deyir (səhifə boş yerə açılmır)');

  //  Trainer-in keçirdiyi imtahan işçinin öz cəhdini bloklamamalıdır və
  //  əksinə — bunlar ayrı hadisələrdir.
  const bugun = inCm(() => U.getLogicalYMD(new Date()));   // gün kəsimi müştəri parametridir
  fake.store.trainer_exams.push({
    tenant_id: 'cm', exam_id: 'EX-TR', trainer_name: 'Leyla', dept: 'Elmlər',
    emp_id: 'E2', emp_name: 'Rəşad', score: 1, max_score: 2, answers: [],
    date_str: bugun, created_at: new Date().toISOString(),
  });
  const r3 = await inCm(() => API.submitEmployeeExam('S2', 'barista', DUZ));
  ok(r3.success, 'trainer imtahanı işçinin öz cəhdini bloklamır', JSON.stringify(r3).slice(0, 80));
}

// ══════════════════════════════════════════════════════════════════════════
section('4. ⚠️ KİMLİK uydurulmur');
{
  seedTenant(true); fake.reset(SEED);

  const r = await inCm(() => API.submitEmployeeExam('YANLIS-SECRET', 'barista', DUZ));
  ok(!r.success, 'naməlum secret ilə imtahan göndərilmir', JSON.stringify(r));
  ok(exams().length === 0, 'sətir yazılmadı');

  //  Köhnə imzada `empId` arqument idi → E2-nin adından göndərmək olurdu.
  //  İndi arqument yoxdur; ad və filial BAZADAN gəlir.
  await inCm(() => API.submitEmployeeExam('S1', 'barista', DUZ));
  ok(exams()[0].emp_id === 'E1' && exams()[0].emp_name === 'Aysel',
     'qeyd secret sahibinin adına yazıldı', exams()[0].emp_id + '/' + exams()[0].emp_name);
  ok(exams()[0].dept === 'Elmlər', 'filial da bazadan gəlir');
  ok(emp('E2').xp === 0, 'başqa işçinin XP-si toxunulmadı');
}

// ══════════════════════════════════════════════════════════════════════════
section('5. Cavablar və sual mətni serverdən');
{
  seedTenant(true); fake.reset(SEED);

  //  Müştəri sual mətnini, variantları və hətta «düz cavab verdim» iddiasını
  //  göndərsə belə — hamısı gözardı edilir.
  const YALAN = [
    { questionId: 'Q1', given: 'B', type: 'test', text: '<img onerror=alert(1)>',
      options: [{ label: 'B', text: 'uydurma' }], correct: 'B', passed: true },
    { questionId: 'Q2', given: 'B' },
    { questionId: 'YOXDUR', given: 'A' },
  ];
  const r = await inCm(() => API.submitEmployeeExam('S1', 'barista', YALAN));
  ok(r.success, 'göndəriş qəbul olunur');
  ok(r.score === 1 && r.maxScore === 2,
     'bal serverdə yenidən hesablanır (Q1 səhv, Q2 düz)', `${r.score}/${r.maxScore}`);

  const saved = exams()[0].answers;
  ok(saved.length === 2, 'naməlum sual (YOXDUR) sayılmır', 'say: ' + saved.length);
  const q1 = saved.find(a => a.questionId === 'Q1');
  ok(q1.text === QS[0].text, 'sual mətni BAZADAN gəlir (uydurma mətn yazılmır)', q1.text);
  ok(q1.passed === false, 'müştərinin `passed:true` iddiası gözardı edilir');
  ok(q1.correct === 'A', 'düzgün cavab bazadan gəlir');

  //  ⚠️ Burada 50 gözləyirdim — test düzəltdi. XP pillələri 90/80/60-dır,
  //  yəni 50% HEÇ NƏ vermir. Vacib olan: bal müştərinin iddiasından yox,
  //  serverin hesabından çıxır (100% olsaydı 100 XP gələrdi).
  ok(emp('E1').xp === 0, '50% → XP yoxdur (ən aşağı pillə 60%-dir)', String(emp('E1').xp));
  ok(inCm(() => U.examXP(100)) === 100 && inCm(() => U.examXP(50)) === 0,
     'pillələr: 100% → 100 bal, 50% → 0');
}

// ══════════════════════════════════════════════════════════════════════════
section('6. Kənar hallar');
{
  seedTenant(true); fake.reset(SEED);

  const bos = await inCm(() => API.submitEmployeeExam('S1', 'barista', []));
  ok(!bos.success, 'boş cavab siyahısı rədd olunur');

  const yox = await inCm(() => API.submitEmployeeExam('S1', 'barista', [{ questionId: 'YOXDUR', given: 'A' }]));
  ok(!yox.success, 'yalnız naməlum suallar varsa rədd olunur', JSON.stringify(yox));
  ok(exams().length === 0, 'boş imtahan sətri yaranmır');

  const rol = await inCm(() => API.getMyExamQuestions('S1', 'menecer'));
  ok(rol.length === 0, 'tanınmayan vəzifə üçün sual verilmir');

  // Test işçisi XP almır (reytinqi korlamasın)
  fake.reset(SEED);
  const t = await inCm(() => API.submitEmployeeExam('ST', 'barista', DUZ));
  ok(t.success, 'test işçisi imtahan verə bilir');
  ok(emp('ET').xp === 0, 'test işçisinə XP verilmir');

  // Secret-siz status yalnız bayrağı verir (trainer paneli belə çağırır)
  const st = await inCm(() => API.getExamStatus());
  ok(st.active === true && st.empName === undefined, 'secret-siz status yalnız `active` verir', JSON.stringify(st));
}

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(62)}`);
console.log(fail === 0
  ? `🎉  BÜTÜN TESTLƏR KEÇDİ  (${pass}/${pass})`
  : `❌  ${fail} TEST UĞURSUZ  (${pass}/${pass + fail} keçdi)`);
console.log(`${'═'.repeat(62)}\n`);
process.exit(fail === 0 ? 0 : 1);

})().catch(e => { console.error('\n💥  Test çöküb:', e); process.exit(1); });
