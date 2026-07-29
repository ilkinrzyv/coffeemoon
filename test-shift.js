'use strict';
// ══════════════════════════════════════════════════════════════════
//  Smen saatları konfiqurasiyasının testi —  işlət:  node test-shift.js
// ══════════════════════════════════════════════════════════════════
//  Ən vacib sual: saatlar konfiqurasiyaya köçürüldükdən sonra sistem
//  ƏVVƏLKİ İLƏ EYNİ davranırmı? (XP/streak/cərimə hesabı buna bağlıdır)
//  Supabase-ə qoşulmur — saxta env dəyərləri ilə işləyir.
// ══════════════════════════════════════════════════════════════════

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://test.local';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test';

const U = require('./utils');

let pass = 0, fail = 0;
function check(ok, label) { if (ok) pass++; else { fail++; console.log('  ✗ ' + label); } }

// ── KÖHNƏ məntiqin eynisi (dəyişiklikdən əvvəlki kod) ──
const OLD = {
  A: {
    sehersm:     { startH:7,  startM:30, durH:9,  lateH:7,  lateM:15, label:'Səhər (07:30-16:30)'      },
    axsamsm:     { startH:16, startM:0,  durH:9,  lateH:16, lateM:0,  label:'Axşam (16:00-01:00)'      },
    fullsm:      { startH:14, startM:0,  durH:11, lateH:14, lateM:0,  label:'Axşam Full (14:00-01:00)' },
    seherfullsm: { startH:7,  startM:30, durH:11, lateH:7,  lateM:15, label:'Səhər Full (07:30-18:30)' },
  },
  B: {
    sehersm:     { startH:7,  startM:30, durH:8,  lateH:7,  lateM:15, label:'Səhər (07:30-15:30)'      },
    axsamsm:     { startH:15, startM:0,  durH:8,  lateH:15, lateM:0,  label:'Axşam (15:00-23:00)'      },
    fullsm:      { startH:13, startM:0,  durH:10, lateH:13, lateM:0,  label:'Axşam Full (13:00-23:00)' },
    seherfullsm: { startH:7,  startM:30, durH:10, lateH:7,  lateM:15, label:'Səhər Full (07:30-17:30)' },
  },
};
const oldGroup = (d) => (d === 'Ağ Şəhər' || d === 'Gənclik') ? 'A' : 'B';
function oldShiftInfo(dept, st) {
  if (!st || st === 'istirahetsm' || st === '') return null;
  const g = oldGroup(dept);
  return (OLD[g] && OLD[g][st]) || null;
}
function oldLim(dept, st, arr) {
  const si = oldShiftInfo(dept, st);
  return si ? (si.lateH * 60 + si.lateM)
    : (arr < 13 * 60 ? 7 * 60 + 30 : (dept === 'Ağ Şəhər' || dept === 'Gənclik') ? 16 * 60 : 15 * 60);
}
function oldIsLate(dept, d) {
  const h = d.getHours();
  let tot = h * 60 + d.getMinutes();
  if (h < 3) tot += 24 * 60;
  const lim = (h >= 3 && h < 13) ? 7 * 60 + 30
    : (dept === 'Gənclik' || dept === 'Ağ Şəhər') ? 16 * 60 : 15 * 60;
  return tot > lim;
}

const TYPES = ['sehersm', 'axsamsm', 'fullsm', 'seherfullsm'];

// ── 1) İlkin vəziyyət: köhnə ilə tam eyni olmalıdır ──
console.log('1) Konfiqurasiya YOXDUR → köhnə davranışla eynilik');
for (const dept of U.DEPTS) {
  for (const t of TYPES) {
    const o = oldShiftInfo(dept, t), n = U.getShiftInfo(dept, t);
    check(!!n && o.startH === n.startH && o.startM === n.startM && o.durH === n.durH
      && o.lateH === n.lateH && o.lateM === n.lateM, `${dept}/${t} saatları fərqlidir`);
    check(o.label === n.label, `${dept}/${t} etiket fərqlidir: köhnə "${o.label}" ≠ yeni "${n && n.label}"`);
  }
  check(U.getShiftInfo(dept, 'istirahetsm') === null, `${dept} istirahetsm null qaytarmır`);
  check(U.getShiftInfo(dept, '') === null, `${dept} boş smen null qaytarmır`);
}

// gecikmə həddi — bütün filial × smen × hər 10 dəqiqə
let limChecked = 0;
for (const dept of U.DEPTS) {
  for (const st of [...TYPES, null, '', 'istirahetsm']) {
    for (let arr = 0; arr < 24 * 60; arr += 10) {
      if (oldLim(dept, st, arr) !== U.getLateLimit(dept, st, arr)) {
        check(false, `${dept}/${st}/${arr}dəq → köhnə ${oldLim(dept, st, arr)} ≠ yeni ${U.getLateLimit(dept, st, arr)}`);
      }
      limChecked++;
    }
  }
}
check(true, '');
console.log(`  ${limChecked} gecikmə həddi ssenarisi yoxlanıldı`);

// isLate — bütün gün, hər 5 dəqiqə
let lateChecked = 0;
for (const dept of U.DEPTS) {
  for (let m = 0; m < 24 * 60; m += 5) {
    const d = new Date(2026, 6, 15, Math.floor(m / 60), m % 60);
    if (oldIsLate(dept, d) !== U.isLate(dept, d)) {
      check(false, `isLate ${dept} ${Math.floor(m / 60)}:${m % 60} → köhnə ${oldIsLate(dept, d)} ≠ yeni ${U.isLate(dept, d)}`);
    }
    lateChecked++;
  }
}
console.log(`  ${lateChecked} isLate ssenarisi yoxlanıldı`);

// ── 2) Konfiqurasiya dəyişəndə həqiqətən tətbiq olunur ──
console.log('\n2) Saat dəyişikliyi tətbiq olunur');
const cfg = U.defaultShiftConfig();
cfg['Sahil'].sehersm.startH = 8;
cfg['Sahil'].sehersm.startM = 0;
cfg['Sahil'].sehersm.lateH  = 8;
cfg['Sahil'].sehersm.lateM  = 10;
cfg['Sahil'].sehersm.durH   = 9;
cfg['Sahil'].fbEveningH     = 17;
cfg['Sahil'].fbEveningM     = 30;
U.setSetting('SHIFT_CONFIG', JSON.stringify(cfg)).catch(() => {});  // yalnız yaddaş keşi (DB yazısı uğursuz olur — normaldır)

check(U.getLateLimit('Sahil', 'sehersm', 8 * 60) === 8 * 60 + 10, 'yeni səhər həddi tətbiq olunmadı');
check(U.getShiftInfo('Sahil', 'sehersm').label === 'Səhər (08:00-17:00)', 'etiket yeni saatla qurulmadı: ' + U.getShiftInfo('Sahil', 'sehersm').label);
check(U.getLateLimit('Sahil', null, 18 * 60) === 17 * 60 + 30, 'yeni axşam ehtiyat həddi tətbiq olunmadı');
check(U.getLateLimit('Elmlər', 'sehersm', 8 * 60) === 7 * 60 + 15, 'başqa filial təsirlənməməli idi');
check(U.getShiftInfo('Gənclik', 'axsamsm').startH === 16, 'Gənclik saatları dəyişməməli idi');

// ── 3) Pozulmuş/yarımçıq konfiqurasiya sistemi sındırmır ──
console.log('\n3) Pozulmuş konfiqurasiyada təhlükəsiz geri dönüş');
U.setSetting('SHIFT_CONFIG', '{bu düzgün json deyil').catch(() => {});
check(U.getLateLimit('Sahil', 'sehersm', 8 * 60) === 7 * 60 + 15, 'pozulmuş JSON-da ilkin dəyərə qayıtmır');
check(U.getShiftInfo('Sahil', 'sehersm') !== null, 'pozulmuş JSON-da smen null olur');

U.setSetting('SHIFT_CONFIG', JSON.stringify({ 'Sahil': { sehersm: { startH: 9, startM: 0, durH: 8, lateH: 9, lateM: 5 } } })).catch(() => {});
check(U.getLateLimit('Sahil', 'sehersm', 9 * 60) === 9 * 60 + 5, 'yarımçıq konfiqdə mövcud smen işləmir');
check(U.getLateLimit('Sahil', 'axsamsm', 15 * 60) === 15 * 60, 'yarımçıq konfiqdə çatışmayan smen ilkin dəyərlə tamamlanmır');
check(U.getLateLimit('Elmlər', 'sehersm', 8 * 60) === 7 * 60 + 15, 'yarımçıq konfiqdə çatışmayan filial ilkin dəyərlə tamamlanmır');

console.log(`\n${'═'.repeat(50)}\nNƏTİCƏ: ${pass} keçdi, ${fail} uğursuz`);
process.exit(fail ? 1 : 0);
