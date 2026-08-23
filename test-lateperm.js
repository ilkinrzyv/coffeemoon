'use strict';
// ══════════════════════════════════════════════════════════════════════════
//  GEC GƏLİŞ İCAZƏSİ — TƏKRAR SƏTİRƏ DÖZÜM  (F-25)
// ══════════════════════════════════════════════════════════════════════════
//  Bu testlərin cavab verdiyi sual: "işçinin təsdiqlənmiş icazəsi ITA bilərmi?"
//
//  Tarixçə: `getApprovedLatePerm` sorğunu `.single()` ilə bitirirdi.
//  PostgREST `.single()` DƏQİQ bir sətir tələb edir — iki sətir gəlsə XƏTA
//  qaytarır və `data` NULL olur. `late_perms`-də isə (emp_id, date_str) üzrə
//  unikallıq YOXDUR, üstəlik təkrar müraciəti bağlayan yoxlama (`requestLatePerm`)
//  ÖZÜ də `.single()` idi: bir dəfə təkrar sətir yaranan kimi o qapı büsbütün
//  açılırdı və hər müraciət yeni sətir yazırdı.
//
//  Nəticə istifadəçi üçün: menecer icazəni TƏSDİQLƏYİR, işçi vaxtında gəlir,
//  sistem isə icazəni GÖRMÜR → gecikmə yazılır, cərimə/töhmət tətbiq olunur,
//  streak sıfırlanır. Heç bir xəta mesajı yoxdur.
//
//  ⚠️ ƏSAS TEST 2-dədir: eyni gün üçün İKİ təsdiqlənmiş sətir qoyulur və
//  icazənin hələ də tapıldığı yoxlanılır. Köhnə kod orada null qaytarırdı.
//
//      node test-lateperm.js
// ══════════════════════════════════════════════════════════════════════════

process.env.TZ = process.env.TZ || 'Asia/Baku';

// ── Supabase klientini taxta ilə əvəzlə (require keşindən əvvəl) ─────────
//  Zəncir `.eq()`-ları udur və `await`-də hazır nəticəni verir.
//  `.single()` REAL davranışı təqlid edir: bir sətirdən çox olsa data=null.
let NETICE = [];
function chain() {
  const o = {
    eq: () => o, in: () => o, gte: () => o, lte: () => o, lt: () => o, gt: () => o,
    is: () => o, order: () => o, limit: () => o, neq: () => o, like: () => o,
    single: () => ({
      then: (res) => res(NETICE.length === 1
        ? { data: NETICE[0], error: null }
        : { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } }),
    }),
    maybeSingle: () => o,
    then: (res) => res({ data: NETICE, error: null }),
  };
  return o;
}
require.cache[require.resolve('./db')] = {
  id: require.resolve('./db'), filename: require.resolve('./db'), loaded: true,
  exports: { from: () => ({ select: chain, insert: chain, update: chain, delete: chain, upsert: chain }) },
};

const T = require('./tenant');
const U = require('./utils');

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else      { fail++; console.log(`  ✗ ${label}${detail ? '\n      → ' + detail : ''}`); }
}
const section = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 52 - t.length))}`);

T.__testSeed({ tenants: [{ tenant_id: 'cm', name: 'Test', status: 'active', plan: 'pro' }] });
const inCm = (fn) => T.run({ tenantId: 'cm' }, fn);

console.log('\n══ GEC GƏLİŞ İCAZƏSİ TESTLƏRİ ══');

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('1. Tək sətir — davranış dəyişmir');
{
  NETICE = [{ requested_time: '10:30' }];
  const p = await inCm(() => U.getApprovedLatePerm('E1', '2026-08-23'));
  ok(p && p.requestedTime === '10:30', 'təsdiqlənmiş icazə tapılır', JSON.stringify(p));

  NETICE = [];
  const yox = await inCm(() => U.getApprovedLatePerm('E1', '2026-08-23'));
  ok(yox === null, 'icazə yoxdursa null qaytarılır');
}

// ══════════════════════════════════════════════════════════════════════════
section('2. ⚠️ İKİ təsdiqlənmiş sətir — icazə İTMİR (F-25-in özü)');
{
  NETICE = [{ requested_time: '10:00' }, { requested_time: '11:15' }];

  // Köhnə kodun etdiyi: `.single()` → data null → icazə YOX sayılır.
  const kohne = await inCm(() => require('./tdb').db()
    .from('late_perms').select('requested_time').eq('emp_id', 'E1').single());
  ok(kohne.data === null,
     'köhnə yol (`.single()`) iki sətirdə NULL qaytarır — səhvin özü',
     'error: ' + (kohne.error && kohne.error.code));

  // Yeni kod: icazə tapılır.
  const p = await inCm(() => U.getApprovedLatePerm('E1', '2026-08-23'));
  ok(p !== null, 'yeni kod icazəni TAPIR', JSON.stringify(p));
  ok(p && p.requestedTime === '11:15',
     'ƏN GEC vaxt götürülür (işçinin xeyrinə — təsdiqlənmiş icazə itməməlidir)',
     p && p.requestedTime);
}

// ══════════════════════════════════════════════════════════════════════════
section('3. Ən gec vaxtın seçilməsi (sıradan asılı deyil)');
{
  const P = (...t) => t.map(x => ({ requested_time: x }));
  ok(U.pickLatestPermTime(P('09:00', '11:15', '10:00')) === '11:15', 'ortadakı ən gec');
  ok(U.pickLatestPermTime(P('11:15', '09:00')) === '11:15', 'birinci ən gec');
  ok(U.pickLatestPermTime(P('09:00', '11:15')) === '11:15', 'sonuncu ən gec');
  ok(U.pickLatestPermTime(P('9:05', '09:30')) === '09:30', 'bir rəqəmli saat da oxunur');

  // Sətir müqayisəsi DEYİL, dəqiqə müqayisəsidir: '9:40' > '10:00' səhv olardı.
  ok(U.pickLatestPermTime(P('9:40', '10:00')) === '10:00',
     'müqayisə dəqiqə ilədir (mətn sıralaması ilə yox)', U.pickLatestPermTime(P('9:40', '10:00')));

  ok(U.pickLatestPermTime([]) === null, 'boş siyahı → null');
  ok(U.pickLatestPermTime(null) === null, 'null siyahı → null');
  ok(U.pickLatestPermTime(P('', 'abc', null)) === null, 'zibil dəyərlər süzülür');
  ok(U.pickLatestPermTime(P('abc', '08:15')) === '08:15', 'zibil arasından düzgün dəyər tapılır');
}

// ══════════════════════════════════════════════════════════════════════════
section('4. Mənbə yoxlaması — qayda geriyə sürüşməsin');
{
  const fs = require('fs'), path = require('path');
  const utilsSrc  = fs.readFileSync(path.join(__dirname, 'utils.js'), 'utf8');
  const serverSrc = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

  const fn = /async function getApprovedLatePerm[\s\S]*?\n}/.exec(utilsSrc);
  ok(!!fn, 'getApprovedLatePerm tapıldı');
  ok(fn && !/\.single\(\)/.test(fn[0]), 'getApprovedLatePerm `.single()` İŞLƏTMİR');

  // Təkrarın MƏNBƏYİ: `requestLatePerm`-dəki mövcudluq yoxlaması da `.single()` idi.
  const req = /API\.requestLatePerm[\s\S]*?\n};/.exec(serverSrc);
  ok(!!req, 'requestLatePerm tapıldı');
  ok(req && !/from\('late_perms'\)[^\n]*\.single\(\)/.test(req[0]),
     'requestLatePerm-in təkrar yoxlaması `.single()` İŞLƏTMİR');

  // `calcStreak` eyni qaydanı işlətməlidir — əks halda cərimə və streak
  // eyni gün üçün FƏRQLİ qərar verir (biri icazəni görür, biri görmür).
  const streak = /async function calcStreak[\s\S]*?\n}/.exec(utilsSrc);
  ok(!!streak, 'calcStreak tapıldı');
  ok(streak && /permMins\(/.test(streak[0]) && /> permMap\[p\.date_str\]/.test(streak[0]),
     'calcStreak də təkrarda ƏN GEC vaxtı götürür (getApprovedLatePerm ilə eyni qayda)');
}

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(62)}`);
console.log(fail === 0
  ? `🎉  BÜTÜN TESTLƏR KEÇDİ  (${pass}/${pass})`
  : `❌  ${fail} TEST UĞURSUZ  (${pass}/${pass + fail} keçdi)`);
console.log(`${'═'.repeat(62)}\n`);
process.exit(fail === 0 ? 0 : 1);

})().catch(e => { console.error('\n💥  Test çöküb:', e); process.exit(1); });
