'use strict';
// ══════════════════════════════════════════════════════════════════
//  Konfiqurasiya qatının testi —  işlət:  node test-config.js
// ══════════════════════════════════════════════════════════════════
//  Cərimə məbləği (30 AZN), gecikmə XP cəzası, streak qalxanı, XP
//  mükafatları və Telegram mesaj mətnləri kodda hardcode idi. İndi
//  paneldən idarə olunur.
//
//  ƏSAS SUAL: konfiqurasiya BOŞ olanda sistem tam ƏVVƏLKİ KİMİ
//  davranırmı? (mövcud müştərilərdə heç nə dəyişməməlidir)
//
//  İkinci sual: pozulmuş/uydurma konfiqurasiya sistemi sındırırmı?
//  (cavab: yox — səssizcə ilkin dəyərə qayıdır, fail-safe)
//
//  Supabase-ə qoşulmur.
// ══════════════════════════════════════════════════════════════════

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://test.local';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test';

const { enterTenant, setLocal } = require('./test-helpers');
enterTenant();
const U = require('./utils');

let pass = 0, fail = 0;
function check(ok, label) { if (ok) pass++; else { fail++; console.log('  ✗ ' + label); } }
function bolme(ad) { console.log('\n' + ad); }

// Hər testdən sonra konfiqurasiyanı təmizlə — sızma olmasın
function clearCfg() {
  setLocal('PUSH_TEMPLATES', '');
  setLocal('DISCIPLINE_CONFIG', '');
  setLocal('XP_CONFIG', '');
  setLocal('TG_TEMPLATES', '');
}

// ══════════════════════════════════════════════════════════════════
bolme('1) Konfiqurasiya boşdursa KÖHNƏ davranış qorunur');
// ══════════════════════════════════════════════════════════════════
clearCfg();
{
  const d = U.getDisciplineConfig();
  check(d.fineAmount === 30,     'cərimə məbləği 30 AZN');
  check(d.fineAfterLates === 2,  '3-cü gecikmədən cərimə (güzəşt 2)');
  check(d.permGraceMins === 5,   'icazə güzəşti 5 dəq');
  check(d.lunchMaxMins === 30,   'nahar limiti 30 dəq');

  // KÖHNƏ kod: lateMins >= 45 ? 50 : lateMins >= 21 ? 30 : 15
  const oldPenalty = (m) => m >= 45 ? 50 : m >= 21 ? 30 : 15;
  let eyni = true;
  for (let m = 0; m <= 120; m++) if (U.latePenaltyXP(m, 0) !== oldPenalty(m)) eyni = false;
  check(eyni, 'gecikmə XP cəzası köhnə formulun eynisidir (0–120 dəq)');

  // KÖHNƏ kod: streak>=60 → ×0.25, streak>=30 → ×0.5
  const oldShield = (m, s) => {
    let p = oldPenalty(m);
    if (s >= 60) p = Math.round(p * 0.25);
    else if (s >= 30) p = Math.round(p * 0.5);
    return p;
  };
  let qalxanEyni = true;
  for (const m of [5, 21, 30, 45, 90]) {
    for (const s of [0, 6, 29, 30, 45, 59, 60, 100]) {
      if (U.latePenaltyXP(m, s) !== oldShield(m, s)) qalxanEyni = false;
    }
  }
  check(qalxanEyni, 'streak qalxanı köhnə formulun eynisidir');

  const x = U.getXPConfig();
  check(x.arrivalXP === 20,    'gəliş XP-si 20');
  check(x.openAnswerXP === 15, 'açıq cavab XP-si 15');

  // KÖHNƏ kod: 60→2.0, 30→1.75, 14→1.5, 7→1.25, qalan 1.0
  const oldMult = (s) => s >= 60 ? 2.0 : s >= 30 ? 1.75 : s >= 14 ? 1.5 : s >= 7 ? 1.25 : 1.0;
  let multEyni = true;
  for (let s = 0; s <= 120; s++) if (U.getXPMultiplier(s) !== oldMult(s)) multEyni = false;
  check(multEyni, 'XP çoxaldıcısı köhnə pillələrin eynisidir (0–120 streak)');

  const ms = U.MS_BONUSES;
  check(ms[7] === 50 && ms[14] === 100 && ms[30] === 250 && ms[60] === 500 && ms[100] === 1000,
    'milestone bonusları dəyişməyib');
  check(U.MS_BONUSES[7] === 50, 'U.MS_BONUSES getter kimi işləyir (köhnə çağırışlar sınmır)');

  // KÖHNƏ kod: pct>=90 ? 100 : pct>=80 ? 75 : pct>=60 ? 50 : 0
  const oldExam = (p) => p >= 90 ? 100 : p >= 80 ? 75 : p >= 60 ? 50 : 0;
  let examEyni = true;
  for (let p = 0; p <= 100; p++) if (U.examXP(p) !== oldExam(p)) examEyni = false;
  check(examEyni, 'imtahan XP-si köhnə pillələrin eynisidir (0–100%)');

  const r = U.getXPConfig().ratingXP;
  check(r[3] === 15 && r[4] === 30 && r[5] === 50, 'reytinq XP xəritəsi dəyişməyib');
}

// ══════════════════════════════════════════════════════════════════
bolme('2) Dəyişdirilən dəyər həqiqətən tətbiq olunur');
// ══════════════════════════════════════════════════════════════════
clearCfg();
setLocal('DISCIPLINE_CONFIG', JSON.stringify({
  fineAmount: 45, fineAfterLates: 4, permGraceMins: 10, lunchMaxMins: 60,
}));
{
  const d = U.getDisciplineConfig();
  check(d.fineAmount === 45,    'məbləğ 45 AZN oldu');
  check(d.fineAfterLates === 4, 'güzəşt 4 gecikmə oldu');
  check(d.permGraceMins === 10, 'icazə güzəşti 10 dəq oldu');
  check(d.lunchMaxMins === 60,  'nahar limiti 60 dəq oldu');
  // Verilməyən sahələr ilkin dəyərdə qalır
  check(d.latePenalty.length === 3, 'toxunulmayan sahə ilkin dəyərdə qalır');
}

clearCfg();
setLocal('XP_CONFIG', JSON.stringify({ arrivalXP: 50, milestones: { 10: 999 } }));
{
  const x = U.getXPConfig();
  check(x.arrivalXP === 50,     'gəliş XP-si 50 oldu');
  check(x.milestones[10] === 999, 'yeni milestone tanınır');
  check(x.milestones[7] === undefined, 'milestone siyahısı ƏVƏZ olunur, birləşdirilmir');
  check(x.openAnswerXP === 15,  'toxunulmayan XP sahəsi ilkin dəyərdə qalır');
}

// ══════════════════════════════════════════════════════════════════
bolme('3) Pozulmuş konfiqurasiya sistemi sındırmır (fail-safe)');
// ══════════════════════════════════════════════════════════════════
clearCfg();
setLocal('DISCIPLINE_CONFIG', '{bu json deyil');
{
  const d = U.getDisciplineConfig();
  check(d.fineAmount === 30, 'yararsız JSON → ilkin dəyər');
}

clearCfg();
setLocal('DISCIPLINE_CONFIG', JSON.stringify({
  fineAmount: -5,          // mənfi → rədd
  fineAfterLates: 'çox',   // rəqəm deyil → rədd
  lunchMaxMins: 0,         // 1-dən kiçik → rədd
  permGraceMins: 99999,    // hədddən böyük → rədd
}));
{
  const d = U.getDisciplineConfig();
  check(d.fineAmount === 30,    'mənfi məbləğ rədd edilir');
  check(d.fineAfterLates === 2, 'rəqəm olmayan güzəşt rədd edilir');
  check(d.lunchMaxMins === 30,  'sıfır nahar limiti rədd edilir');
  check(d.permGraceMins === 5,  'hədddən böyük güzəşt rədd edilir');
}

clearCfg();
setLocal('DISCIPLINE_CONFIG', JSON.stringify({ latePenalty: [], streakShield: 'yox' }));
{
  const d = U.getDisciplineConfig();
  check(d.latePenalty.length === 3,  'boş pillə siyahısı → ilkin dəyər');
  check(d.streakShield.length === 2, 'massiv olmayan qalxan → ilkin dəyər');
}

// ══════════════════════════════════════════════════════════════════
bolme('4) Pillələr sıralanır — səhv sıra yanlış cəza vermir');
// ══════════════════════════════════════════════════════════════════
clearCfg();
// QƏSDƏN səhv sıra: 0 dəq birincidir. Sıralanmasa `find` hər zaman onu tutardı.
setLocal('DISCIPLINE_CONFIG', JSON.stringify({
  latePenalty: [{ mins: 0, xp: 5 }, { mins: 60, xp: 90 }, { mins: 30, xp: 40 }],
}));
{
  const d = U.getDisciplineConfig();
  check(d.latePenalty[0].mins === 60, 'pillələr azalan sıralanır');
  check(U.latePenaltyXP(70, 0) === 90, '70 dəq → ən yuxarı pillə');
  check(U.latePenaltyXP(35, 0) === 40, '35 dəq → orta pillə');
  check(U.latePenaltyXP(5,  0) === 5,  '5 dəq → alt pillə');
}

clearCfg();
setLocal('DISCIPLINE_CONFIG', JSON.stringify({
  latePenalty: [{ mins: 0, xp: 20 }, { mins: 'yanlış', xp: 5 }, { mins: 40, xp: 60 }],
}));
{
  const d = U.getDisciplineConfig();
  check(d.latePenalty.length === 2, 'yararsız pillə sətri atılır');
  check(U.latePenaltyXP(50, 0) === 60, 'qalan pillələr düzgün işləyir');
}

// ══════════════════════════════════════════════════════════════════
bolme('5) Telegram şablonları');
// ══════════════════════════════════════════════════════════════════
clearCfg();
{
  const t = U.getTgTemplates();
  check(t.arrive.indexOf('{ad}') >= 0,  'ilkin gəliş şablonunda {ad} var');
  check(U.TG_KEYS.length >= 14,         'bütün mesaj növləri şablona çevrilib');

  check(U.fillTemplate('Salam {ad}!', { ad: 'Rəşad' }) === 'Salam Rəşad!', 'yer tutucu dolur');
  check(U.fillTemplate('{ad} — {yox}', { ad: 'A' }) === 'A — {yox}',
    'naməlum yer tutucu OLDUĞU KİMİ qalır (yazı səhvi gözə çarpsın)');
  check(U.fillTemplate('{a}{a}', { a: 'x' }) === 'xx', 'eyni yer tutucu təkrarlanır');
  check(U.fillTemplate('', { a: 1 }) === '', 'boş şablon boş qalır');
  check(U.fillTemplate(null, {}) === '', 'null şablon sınmır');
  check(U.fillTemplate('{n} dəq', { n: 0 }) === '0 dəq', 'sıfır dəyər yer tutucunu doldurur');

  // Köhnə mesajın eynisi çıxırmı?
  const kohne = '<b>Rəşad</b> smendə.\n08:04 — Vaxtında';
  const yeni  = U.fillTemplate(t.arrive, { ad: 'Rəşad', saat: '08:04', qeyd: t.onTime });
  check(yeni === kohne, 'gəliş mesajı köhnə mətnin eynisidir');

  const kohneCixis = '<b>Rəşad</b> smendən çıxdı.\n17:30 — +15 dəq';
  check(U.fillTemplate(t.leave, { ad: 'Rəşad', saat: '17:30', ferq: '+15 dəq' }) === kohneCixis,
    'çıxış mesajı köhnə mətnin eynisidir');

  const kohneCerime = '\n Bu ay <b>3-ci gecikmə</b> — 27 dəq.\n <b>30 AZN cərimə</b> qeyd edildi.';
  check(U.fillTemplate(t.lateFine, { say: 3, deq: 27, mebleg: 30 }) === kohneCerime,
    'cərimə mesajı köhnə mətnin eynisidir');
}

clearCfg();
setLocal('TG_TEMPLATES', JSON.stringify({ arrive: '{ad} geldi', lunchGo: '' }));
{
  const t = U.getTgTemplates();
  check(t.arrive === '{ad} geldi', 'dəyişdirilən şablon tətbiq olunur');
  check(t.lunchGo === '', 'boş şablon icazəlidir (mesajı susdurmaq üçün)');
  check(t.leave.indexOf('{ad}') >= 0, 'toxunulmayan şablon ilkin mətndə qalır');
}

clearCfg();
setLocal('TG_TEMPLATES', 'pozulmuş{');
check(U.getTgTemplates().arrive === U.DEFAULT_TG.arrive, 'yararsız JSON → ilkin mətnlər');

clearCfg();
setLocal('TG_TEMPLATES', JSON.stringify({ arrive: 12345, uydurmaAcar: 'x' }));
{
  const t = U.getTgTemplates();
  check(t.arrive === U.DEFAULT_TG.arrive, 'sətir olmayan şablon rədd edilir');
  check(t.uydurmaAcar === undefined,      'tanınmayan açar qəbul edilmir');
}

// ══════════════════════════════════════════════════════════════════
bolme('5b) Telefon (push) bildiriş şablonları');
// ══════════════════════════════════════════════════════════════════
clearCfg();
setLocal('PUSH_TEMPLATES', '');
{
  const p = U.fillPush('mgrFine', { mebleg: 15, sebeb: 'Forma geyinməyib' });
  check(p.title === '⚠️ Cərimə Bildirişi', 'ilkin başlıq dəyişməyib');
  check(p.body === '15 AZN — Forma geyinməyib. Təsdiqləmək üçün kartınıza daxil olun.',
    'ilkin mətn köhnə bildirişin eynisidir');

  const a = U.fillPush('avansDecision', { emoji: '✅', mebleg: 200, status: 'təsdiqləndi' });
  check(a.body === '200 AZN avans tələbiniz təsdiqləndi.', 'avans qərarı mətni eynidir');

  check(U.fillPush('yoxBeleSablon', {}) === null, 'naməlum açar → null');
  check(U.PUSH_KEYS.length === 13, 'bütün push bildirişləri şablona çevrilib');
}

clearCfg();
setLocal('PUSH_TEMPLATES', JSON.stringify({
  mgrFine: { title: 'Cərimə', body: '{mebleg} manat' },
  lunchLate: { title: '', body: '' },
}));
{
  const p = U.fillPush('mgrFine', { mebleg: 15, sebeb: 'x' });
  check(p.title === 'Cərimə' && p.body === '15 manat', 'dəyişdirilən push tətbiq olunur');
  check(U.fillPush('lunchLate', { ad: 'A', deq: 40, limit: 30 }) === null,
    'başlıq və mətn boşdursa bildiriş SUSDURULUR');
  check(U.fillPush('fineAck', { ad: 'A', mebleg: 5 }).title === '✍️ Cərimə Təsdiqləndi',
    'toxunulmayan bildiriş ilkin mətndə qalır');
}

clearCfg();
setLocal('PUSH_TEMPLATES', JSON.stringify({ mgrFine: { title: 'Yalnız başlıq' } }));
{
  const p = U.fillPush('mgrFine', { mebleg: 9, sebeb: 'y' });
  check(p.title === 'Yalnız başlıq', 'yalnız başlıq dəyişdirilə bilər');
  check(p.body.indexOf('9 AZN') === 0, 'mətn ilkin qalır');
}

clearCfg();
setLocal('PUSH_TEMPLATES', 'pozulmuş{');
check(U.fillPush('mgrFine', { mebleg: 1, sebeb: 'z' }).title === '⚠️ Cərimə Bildirişi',
  'yararsız JSON → ilkin mətnlər');

clearCfg();

// ══════════════════════════════════════════════════════════════════
bolme('6) XP mühərriki konfiqurasiyanı işlədir');
// ══════════════════════════════════════════════════════════════════
clearCfg();
// Elmlər = B qrupu, səhər smeni son vaxt 07:15
const gun = (ymd, saat, deq) => ({
  type: 'GƏLİŞ', shift_type: 'sehersm',
  timestamp: new Date(`${ymd}T${String(saat).padStart(2,'0')}:${String(deq).padStart(2,'0')}:00`).toISOString(),
});
const gelisler = [gun('2026-03-02', 7, 0), gun('2026-03-03', 7, 0), gun('2026-03-04', 7, 0)];
{
  const a = U.computeEmployeeXP('Elmlər', { attendance: gelisler });
  check(a.streak === 3, 'üç vaxtında gəliş → streak 3');
  check(a.xp === 60,    'gəliş XP-si 3 × 20 = 60');

  setLocal('XP_CONFIG', JSON.stringify({ arrivalXP: 10 }));
  const b = U.computeEmployeeXP('Elmlər', { attendance: gelisler });
  check(b.xp === 30, 'gəliş XP-si 10 olanda 3 × 10 = 30');
  check(b.streak === 3, 'XP dəyişikliyi streak-ə toxunmur');
}

clearCfg();
{
  // Gecikmiş gün: 08:00 gəliş, limit 07:15 → 45 dəq gec → 50 XP cəza
  const gec = [gun('2026-03-02', 8, 0)];
  const a = U.computeEmployeeXP('Elmlər', { attendance: gec });
  check(a.xp === 0 && a.streak === 0, 'gecikmə → streak sıfırlanır, XP 0-dan aşağı düşmür');

  setLocal('DISCIPLINE_CONFIG', JSON.stringify({ latePenalty: [{ mins: 0, xp: 5 }] }));
  const b = U.computeEmployeeXP('Elmlər', { attendance: [...gelisler, gun('2026-03-05', 8, 0)] });
  check(b.xp === 55, 'cəza 5-ə endirildikdə 60 − 5 = 55');
}

clearCfg();
{
  // İcazə güzəşti: icazə 07:30, gəliş 07:33 → 5 dəq güzəşt daxilində, vaxtında sayılır
  const permMap = { '2026-03-02': 7 * 60 + 30 };
  const a = U.computeEmployeeXP('Elmlər', { attendance: [gun('2026-03-02', 7, 33)], permMap });
  check(a.streak === 1, 'icazə + 5 dəq güzəşt daxilində → vaxtında');

  const b = U.computeEmployeeXP('Elmlər', { attendance: [gun('2026-03-02', 7, 38)], permMap });
  check(b.streak === 0, 'güzəştdən kənar → gecikmə');

  setLocal('DISCIPLINE_CONFIG', JSON.stringify({ permGraceMins: 15 }));
  const c = U.computeEmployeeXP('Elmlər', { attendance: [gun('2026-03-02', 7, 38)], permMap });
  check(c.streak === 1, 'güzəşt 15 dəq olanda eyni gəliş vaxtında sayılır');
}

// ══════════════════════════════════════════════════════════════════
bolme('7) Gün sərhədi (03:00) — sistemin ən həssas nöqtəsi');
// ══════════════════════════════════════════════════════════════════
clearCfg();
{
  check(U.getDisciplineConfig().dayCutoffHour === 3, 'defolt gün sərhədi 03:00');

  // KÖHNƏ kod: if (d.getHours() < 3) d.setDate(d.getDate() - 1)
  const kohneYMD = (dt) => {
    const d = new Date(dt.getTime());
    if (d.getHours() < 3) d.setDate(d.getDate() - 1);
    return U.toYMD(d);
  };
  let eyni = true;
  for (let saat = 0; saat < 24; saat++) {
    const dt = new Date(2026, 2, 15, saat, 30);
    if (U.getLogicalYMD(dt) !== kohneYMD(dt)) eyni = false;
  }
  check(eyni, 'məntiqi gün köhnə məntiqin eynisidir (24 saat yoxlanıldı)');

  check(U.getLogicalYMD(new Date(2026, 2, 15, 2, 30))  === '2026-03-14', '02:30 → əvvəlki gün');
  check(U.getLogicalYMD(new Date(2026, 2, 15, 3, 0))   === '2026-03-15', '03:00 → həmin gün');
  check(U.getLogicalYMD(new Date(2026, 2, 15, 23, 59)) === '2026-03-15', '23:59 → həmin gün');
}

clearCfg();
setLocal('DISCIPLINE_CONFIG', JSON.stringify({ dayCutoffHour: 0 }));
{
  check(U.getLogicalYMD(new Date(2026, 2, 15, 2, 30)) === '2026-03-15',
    'sərhəd 0 olanda gecə 02:30 həmin günə yazılır (gecə işləməyən müştəri)');
  check(U.getLogicalDateStr(new Date(2026, 2, 15, 1, 0)) === new Date(2026, 2, 15).toDateString(),
    'getLogicalDateStr də sərhədi izləyir');
}

clearCfg();
setLocal('DISCIPLINE_CONFIG', JSON.stringify({ dayCutoffHour: 6 }));
check(U.getLogicalYMD(new Date(2026, 2, 15, 5, 0)) === '2026-03-14', 'sərhəd 6 olanda 05:00 əvvəlki günə düşür');

clearCfg();
setLocal('DISCIPLINE_CONFIG', JSON.stringify({ dayCutoffHour: 14 }));
check(U.getDisciplineConfig().dayCutoffHour === 3,
  'günorta sonrası sərhəd RƏDD edilir (hesabat məntiqini pozardı)');

clearCfg();
setLocal('DISCIPLINE_CONFIG', JSON.stringify({ daypartBoundaryMin: 600 }));
{
  // Cədvəlsiz gün: 11:00 gəliş. Sərhəd 600 (10:00) olduğuna görə artıq "axşam" sayılır.
  check(U.getDisciplineConfig().daypartBoundaryMin === 600, 'səhər/axşam sərhədi dəyişir');
  const axsamLimit = U.getLateLimit('Elmlər', null, 700);
  const seherLimit = U.getLateLimit('Elmlər', null, 500);
  check(axsamLimit !== seherLimit, 'sərhədin iki tərəfi fərqli hədd verir');
}

// ══════════════════════════════════════════════════════════════════
bolme('8) Məbləğ limitləri və xəbərdarlıq payı');
// ══════════════════════════════════════════════════════════════════
clearCfg();
{
  const d = U.getDisciplineConfig();
  check(d.avansMax === 1000,    'defolt avans limiti 1000 AZN');
  check(d.mgrFineMax === 1000,  'defolt menecer cərimə limiti 1000 AZN');
  check(d.lateWarnBuffer === 5, 'defolt xəbərdarlıq payı 5 dəq');
}
clearCfg();
setLocal('DISCIPLINE_CONFIG', JSON.stringify({ avansMax: 5000, mgrFineMax: 200, lateWarnBuffer: 0 }));
{
  const d = U.getDisciplineConfig();
  check(d.avansMax === 5000,   'avans limiti dəyişir');
  check(d.mgrFineMax === 200,  'cərimə limiti dəyişir');
  check(d.lateWarnBuffer === 0, 'xəbərdarlıq payı 0 ola bilər');
}
clearCfg();
setLocal('DISCIPLINE_CONFIG', JSON.stringify({ avansMax: 0 }));
check(U.getDisciplineConfig().avansMax === 1000, 'sıfır avans limiti rədd edilir (heç kim avans ala bilməzdi)');

// ══════════════════════════════════════════════════════════════════
bolme('9) Keş referans paylaşmır');
// ══════════════════════════════════════════════════════════════════
clearCfg();
setLocal('DISCIPLINE_CONFIG', JSON.stringify({ fineAmount: 40 }));
{
  const a = U.getDisciplineConfig();
  a.fineAmount = 999;
  a.latePenalty[0].xp = 999;
  const b = U.getDisciplineConfig();
  check(b.fineAmount === 40,       'obyekti dəyişmək keşi zəhərləmir');
  check(b.latePenalty[0].xp !== 999, 'iç-içə massiv də kopyalanır');
}
clearCfg();
setLocal('XP_CONFIG', JSON.stringify({ arrivalXP: 33 }));
{
  const a = U.getXPConfig();
  a.milestones[7] = 1;
  check(U.getXPConfig().milestones[7] === 50, 'XP keşi də referans paylaşmır');
}

clearCfg();

// ══════════════════════════════════════════════════════════════════
console.log('\n══════════════════════════════════════════════════');
console.log(`NƏTİCƏ: ${pass} keçdi, ${fail} uğursuz`);
if (fail) process.exit(1);
