'use strict';
require('dotenv').config();
const sb    = require('./db');
const fetch = require('node-fetch');

// ── Settings cache (başlayanda yüklənir) ─────────────────────────
const _settings = new Map();

async function loadSettings() {
  const { data } = await sb.from('settings').select('*');
  if (data) data.forEach(r => _settings.set(r.key, r.value));
}

function getSetting(key) {
  return _settings.get(key) || '';
}

async function setSetting(key, value) {
  _settings.set(key, String(value));
  await sb.from('settings').upsert({ key, value: String(value) }, { onConflict: 'key' });
}

// ── Tarix köməkçiləri ────────────────────────────────────────────
function toYMD(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}
function fmtTime(d) {
  return String(d.getHours()).padStart(2, '0') + ':' +
    String(d.getMinutes()).padStart(2, '0');
}
function getLogicalYMD(dateObj) {
  const d = new Date(dateObj.getTime());
  if (d.getHours() < 3) d.setDate(d.getDate() - 1);
  return toYMD(d);
}
function getLogicalDateStr(dateObj) {
  const d = new Date(dateObj.getTime());
  if (d.getHours() < 3) d.setDate(d.getDate() - 1);
  return d.toDateString();
}

// ── PIN ──────────────────────────────────────────────────────────
const TIME_STEP = 10000;
function generateDynamicPin(secret, tw) {
  const str = String(secret) + String(tw);
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = Math.imul(31, hash) + str.charCodeAt(i) | 0;
  hash ^= (hash << 13); hash ^= (hash >>> 17); hash ^= (hash << 5);
  return (Math.abs(Math.imul(hash, 1664525) + 1013904223) % 10000).toString().padStart(4, '0');
}

// ── Smen məntiqi ─────────────────────────────────────────────────
// Saatlar artıq HARDCODE DEYİL: admin panelindən dəyişilir və `settings.SHIFT_CONFIG`-də
// JSON kimi saxlanılır. Aşağıdakı cədvəl yalnız İLKİN DƏYƏRDİR (konfiqurasiya yoxdursa/pozulubsa).
// Beləliklə mövcud davranış birinci gün eyni qalır.
const SHIFT_TABLE = {
  A: {
    sehersm:     { startH:7,  startM:30, durH:9,  lateH:7,  lateM:15 },
    axsamsm:     { startH:16, startM:0,  durH:9,  lateH:16, lateM:0  },
    fullsm:      { startH:14, startM:0,  durH:11, lateH:14, lateM:0  },
    seherfullsm: { startH:7,  startM:30, durH:11, lateH:7,  lateM:15 },
    // Cədvəldə smen təyin olunmayıbsa istifadə olunan ehtiyat hədlər:
    fbMorningH:7, fbMorningM:30, fbEveningH:16, fbEveningM:0,
  },
  B: {
    sehersm:     { startH:7,  startM:30, durH:8,  lateH:7,  lateM:15 },
    axsamsm:     { startH:15, startM:0,  durH:8,  lateH:15, lateM:0  },
    fullsm:      { startH:13, startM:0,  durH:10, lateH:13, lateM:0  },
    seherfullsm: { startH:7,  startM:30, durH:10, lateH:7,  lateM:15 },
    fbMorningH:7, fbMorningM:30, fbEveningH:15, fbEveningM:0,
  },
};

// Saatları admin panelindən tənzimlənən smenlər
const SHIFT_TYPES = ['sehersm', 'axsamsm', 'fullsm', 'seherfullsm'];
// `tamgun` bu siyahıda YOXDUR — onun saatları ayrıca saxlanmır, səhər başlanğıcı +
// axşam bitişindən HESABLANIR. Belədə admin səhər/axşamı dəyişəndə tam gün özü uyğunlaşır.
const SHIFT_NAMES = {
  sehersm:'Səhər', axsamsm:'Axşam', fullsm:'Axşam Full', seherfullsm:'Səhər Full',
  tamgun:'Tam gün',
};
const ALL_SHIFT_TYPES = SHIFT_TYPES.concat(['tamgun']);

// Gəlişin "səhər" yoxsa "axşam" hissəsinə aid olduğunu ayıran sərhəd (cədvəlsiz günlər üçün).
// Bu iş saatı deyil, daxili bölgü həddidir — ona görə konfiqurasiyaya çıxarılmayıb.
const DAYPART_BOUNDARY_MIN = 13 * 60;

function getShiftGroup(dept) {
  return (dept === 'Ağ Şəhər' || dept === 'Gənclik') ? 'A' : 'B';
}

// İlkin (hardcode) cədvəldən filial üzrə konfiqurasiya qur
function defaultShiftConfig() {
  const cfg = {};
  for (const dept of Object.keys(DEPT_SLUG)) {
    const g = SHIFT_TABLE[getShiftGroup(dept)];
    cfg[dept] = JSON.parse(JSON.stringify(g));
  }
  return cfg;
}

// Konfiqurasiya keşi — `getShiftInfo` sinxron və döngülərdə çağırılır (recalcAllXP),
// ona görə eyni JSON mətni təkrar parse edilmir.
let _shiftCfgRaw = null, _shiftCfgParsed = null;

function getShiftConfig() {
  const raw = getSetting('SHIFT_CONFIG');
  if (!raw) return defaultShiftConfig();
  if (raw === _shiftCfgRaw && _shiftCfgParsed) return _shiftCfgParsed;
  try {
    const parsed = JSON.parse(raw);
    const base = defaultShiftConfig();
    // Çatışmayan filial/smen olarsa ilkin dəyərlə tamamla (yarımçıq konfiq sistemi sındırmasın)
    for (const dept of Object.keys(base)) {
      if (!parsed[dept]) { parsed[dept] = base[dept]; continue; }
      for (const t of SHIFT_TYPES) if (!parsed[dept][t]) parsed[dept][t] = base[dept][t];
      for (const k of ['fbMorningH', 'fbMorningM', 'fbEveningH', 'fbEveningM']) {
        if (typeof parsed[dept][k] !== 'number') parsed[dept][k] = base[dept][k];
      }
    }
    _shiftCfgRaw = raw; _shiftCfgParsed = parsed;
    return parsed;
  } catch (e) {
    console.error('[SHIFT_CONFIG] parse xətası — ilkin dəyərlər işlədilir:', e.message);
    return defaultShiftConfig();
  }
}

function pad2(n) { return String(n).padStart(2, '0'); }

// Smen etiketi saatlardan avtomatik qurulur: "Səhər (07:30-15:30)"
function shiftLabel(type, s) {
  const endTot = (s.startH * 60 + s.startM + s.durH * 60) % (24 * 60);
  return `${SHIFT_NAMES[type] || type} (${pad2(s.startH)}:${pad2(s.startM)}-${pad2(Math.floor(endTot / 60))}:${pad2(endTot % 60)})`;
}

function getShiftInfo(dept, shiftType) {
  if (!shiftType || shiftType === 'istirahetsm' || shiftType === '') return null;
  const d = getShiftConfig()[dept];
  if (!d) return null;

  // TAM GÜN = səhər başlanğıcından axşamın bitişinə qədər (iki smen).
  // Saatları ayrıca saxlanmır — səhər/axşam dəyişəndə özü uyğunlaşsın deyə hesablanır.
  if (shiftType === 'tamgun') {
    const s = d.sehersm, a = d.axsamsm;
    if (!s || !a) return null;
    const start = s.startH * 60 + s.startM;
    let end = a.startH * 60 + a.startM + a.durH * 60;
    if (end <= start) end += 24 * 60;                 // gecə yarısını keçirsə
    const info = { startH: s.startH, startM: s.startM, durH: (end - start) / 60, lateH: s.lateH, lateM: s.lateM };
    return { ...info, label: shiftLabel('tamgun', info) };
  }

  const s = d[shiftType];
  if (!s) return null;
  return { ...s, label: shiftLabel(shiftType, s) };
}

// ⭐ TƏK MƏNBƏ: gecikmə həddi (dəqiqə ilə).
// Smen məlumdursa onun `lateH/lateM`-i, deyilsə filialın ehtiyat həddi işlədilir.
// Əvvəl bu məntiq 7 ayrı yerdə təkrarlanırdı (7:30 / 16:00 / 15:00 hardcode).
function getLateLimit(dept, shiftType, arrivalMins) {
  const si = shiftType ? getShiftInfo(dept, shiftType) : null;
  if (si) return si.lateH * 60 + si.lateM;
  const d = getShiftConfig()[dept] || defaultShiftConfig()[dept] || SHIFT_TABLE.B;
  return (arrivalMins < DAYPART_BOUNDARY_MIN)
    ? d.fbMorningH * 60 + d.fbMorningM
    : d.fbEveningH * 60 + d.fbEveningM;
}

function isLate(dept, dateObj) {
  const h = dateObj.getHours();
  let tot = h * 60 + dateObj.getMinutes();
  if (h < 3) tot += 24 * 60;
  // Gecə 03:00-dan əvvəlki gəliş "axşam" tərəfə aiddir (tot 24 saat əlavə edilib)
  return tot > getLateLimit(dept, null, h < 3 ? DAYPART_BOUNDARY_MIN : tot);
}

// ── DB köməkçi sorğular ───────────────────────────────────────────
async function getEmployeeShift(empId, dateStr) {
  // DİQQƏT: cedvel-də (emp_id,date_str) üzrə unikallıq məhdudiyyəti yoxdur → təkrar sətir ola bilər.
  // .single() təkrar sətirdə XƏTA verib null qaytarırdı → işçi cədvəli görmürdü (menecer görürdü).
  // İndi təkrara dözümlü: ən son yazılmış qeyd qalib (getCedvel menecer görünüşü ilə uyğun).
  const { data } = await sb.from('cedvel')
    .select('shift_type')
    .eq('emp_id', String(empId)).eq('date_str', dateStr)
    .order('cedvel_id', { ascending: false })
    .limit(1);
  return (data && data.length) ? (data[0].shift_type || null) : null;
}

async function hasApprovedLeave(empId, dateStr) {
  const { data } = await sb.from('izin')
    .select('start_date,end_date').eq('emp_id', String(empId)).eq('status', 'approved');
  return (data || []).some(r => dateStr >= r.start_date && dateStr <= r.end_date);
}

async function getApprovedLatePerm(empId, dateStr) {
  const { data } = await sb.from('late_perms')
    .select('requested_time').eq('emp_id', String(empId)).eq('date_str', dateStr).eq('status', 'approved').single();
  return data ? { requestedTime: data.requested_time } : null;
}

// ── Streak ───────────────────────────────────────────────────────
async function calcStreak(empId, dept) {
  const { data: logs } = await sb.from('attendance')
    .select('timestamp,shift_type').eq('emp_id', String(empId)).eq('type', 'GƏLİŞ')
    .order('timestamp', { ascending: false });
  if (!logs) return 0;

  // Gec gəliş icazələrini bir dəfə çək (vaxtı ilə birlikdə)
  const { data: perms } = await sb.from('late_perms')
    .select('date_str,requested_time').eq('emp_id', String(empId)).eq('status', 'approved');
  const permMap = {};
  for (const p of perms || []) {
    const [ph, pm] = (p.requested_time || '23:59').split(':').map(Number);
    permMap[p.date_str] = ph * 60 + pm;
  }

  // Tam gün izinlərini bir dəfə çək
  const { data: izinRows } = await sb.from('izin')
    .select('start_date,end_date').eq('emp_id', String(empId)).eq('status', 'approved');

  // Cədvəli (smenləri) bir dəfə çək — döngü içində sorğu atmamaq üçün (N+1 → 1)
  const { data: cedvelRows } = await sb.from('cedvel')
    .select('date_str,shift_type').eq('emp_id', String(empId));
  const shiftMap = {};
  for (const c of cedvelRows || []) shiftMap[c.date_str] = c.shift_type || null;

  function hasIzin(dateStr) {
    return (izinRows || []).some(r => dateStr >= r.start_date && dateStr <= r.end_date);
  }
  function withinPerm(dateStr, arrivalMins) {
    return dateStr in permMap && arrivalMins <= permMap[dateStr] + 5;
  }

  let streak = 0;
  for (const row of logs) {
    const d = new Date(row.timestamp);
    if (isNaN(d.getTime())) continue;
    const dateStr     = getLogicalYMD(d);
    const arrivalMins = d.getHours() * 60 + d.getMinutes();

    // Tam gün izin → streak davam edir
    if (hasIzin(dateStr)) { streak++; continue; }
    // Gec gəliş icazəsi — yalnız icazə vaxtı + 5 dəq içindədirsə streak davam edir
    if (withinPerm(dateStr, arrivalMins)) { streak++; continue; }

    // Əvvəlcə cədvəldəki smen, yoxdursa gəliş anında qeyd olunmuş smen (hesabatla uyğun olsun)
    const st = row.shift_type || shiftMap[dateStr] || null;
    const lim = getLateLimit(dept, st, arrivalMins);
    if (arrivalMins <= lim) streak++;
    else break; // Gecikmiş gün — streak dayanır
  }
  return streak;
}

// ── Şöbə/slug çevirmələri ────────────────────────────────────────
// Yeni filial əlavə etmək üçün yalnız bu obyekti yeniləmək kifayətdir:
const DEPT_SLUG = { 'Elmlər':'elmler','Sahil':'sahil','Gənclik':'genclik','Ağ Şəhər':'agseher' };
const SLUG_DEPT = Object.fromEntries(Object.entries(DEPT_SLUG).map(([d,s]) => [s,d]));
const SLUGS     = Object.values(DEPT_SLUG);
const DEPTS     = Object.keys(DEPT_SLUG);

// ── Vəzifələr ─────────────────────────────────────────────────────
// employees.position sütununda saxlanılır. Adı `role` DEYİL — çünki `role`
// artıq imtahan suallarında (kassir/barista/umumi) və auth rollarında işlənir.
const POSITIONS = ['Barista', 'Cashier', 'Team Leader', 'Cleaner'];
function isValidPosition(p) { return POSITIONS.includes(p); }

// ── Maaş qaydaları ────────────────────────────────────────────────
// Bir SMEN üçün günlük məbləğ (AZN). Tam gün = 2 smen → 2 qat.
// Bunlar yalnız İLKİN dəyərdir — admin panelindən dəyişilir (settings.SALARY_CONFIG).
const DEFAULT_SALARY = {
  rates: { 'Team Leader': 23.33, 'Barista': 20, 'Cashier': 20, 'Cleaner': 18.33 },
  taxi: 7,                                        // günlük sabit məbləğ (tam gündə DƏ 7, iki qat deyil)
  taxiDepts: ['Ağ Şəhər', 'Gənclik'],             // taksi yalnız bu filiallarda
  taxiShifts: ['axsamsm', 'fullsm', 'tamgun'],    // axşam tərəfli smenlər
};

// Bir günə neçə smen maaşı düşür
function shiftMultiplier(shiftType) {
  return shiftType === 'tamgun' ? 2 : 1;
}

let _salCfgRaw = null, _salCfgParsed = null;
function getSalaryConfig() {
  const raw = getSetting('SALARY_CONFIG');
  if (!raw) return JSON.parse(JSON.stringify(DEFAULT_SALARY));
  if (raw === _salCfgRaw && _salCfgParsed) return _salCfgParsed;
  try {
    const p = JSON.parse(raw);
    const base = JSON.parse(JSON.stringify(DEFAULT_SALARY));
    const cfg = {
      rates: Object.assign({}, base.rates, (p && p.rates) || {}),
      taxi: typeof (p && p.taxi) === 'number' ? p.taxi : base.taxi,
      taxiDepts: Array.isArray(p && p.taxiDepts) ? p.taxiDepts : base.taxiDepts,
      taxiShifts: Array.isArray(p && p.taxiShifts) ? p.taxiShifts : base.taxiShifts,
    };
    // Vəzifə siyahısında olmayan açarları at, çatışmayanı ilkin dəyərlə tamamla
    for (const pos of POSITIONS) if (typeof cfg.rates[pos] !== 'number') cfg.rates[pos] = base.rates[pos];
    _salCfgRaw = raw; _salCfgParsed = cfg;
    return cfg;
  } catch (e) {
    console.error('[SALARY_CONFIG] parse xətası — ilkin dəyərlər işlədilir:', e.message);
    return JSON.parse(JSON.stringify(DEFAULT_SALARY));
  }
}

// Bir iş gününün ödənişi: { pay, taxi, shifts }
// shiftType — həmin günün cədvəldəki smeni (yoxdursa gəliş anındakı smen).
function computeDayPay(position, dept, shiftType, cfg) {
  const c = cfg || getSalaryConfig();
  const rate = c.rates[position] || 0;
  const mult = shiftMultiplier(shiftType);
  const taxi = (c.taxiDepts.indexOf(dept) >= 0 && c.taxiShifts.indexOf(shiftType) >= 0) ? c.taxi : 0;
  return { pay: round2(rate * mult), taxi: round2(taxi), shifts: mult };
}
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function deptToSlug(dept)  { return DEPT_SLUG[dept] || ''; }
function slugToDept(slug)  { return SLUG_DEPT[slug] || ''; }

// ── Filial açarları ───────────────────────────────────────────────
async function getBranchScheduleKeys() {
  const result = {};
  for (const slug of SLUGS) {
    let k = getSetting('SCHED_KEY_' + slug);
    if (!k) {
      k = 'SK' + Math.random().toString(36).substring(2, 10).toUpperCase();
      await setSetting('SCHED_KEY_' + slug, k);
    }
    result[slugToDept(slug)] = k;
  }
  return result;
}

function validateBranchScheduleKey(key) {
  for (const slug of SLUGS) {
    if (getSetting('SCHED_KEY_' + slug) === key) return { valid: true, dept: slugToDept(slug) };
  }
  return { valid: false };
}

// ── WiFi IP yoxlaması ─────────────────────────────────────────────
function checkWifiIp(dept, clientIp) {
  const key = deptToSlug(dept);
  if (!key) return { ok: true };
  const reg = getSetting('IP_' + key);
  if (!reg) return { ok: false, reason: 'Bu filial üçün WiFi IP hələ qeydə alınmayıb.' };
  if (!clientIp) return { ok: true };
  const allowed = reg.split(',').map(s => s.trim());
  if (allowed.some(a => a && clientIp.startsWith(a))) return { ok: true };
  return { ok: false, reason: 'Filial WiFi-ına qoşulmamısınız!' };
}

// ── Telegram ─────────────────────────────────────────────────────
function getTelegramSettings() {
  return {
    enabled:     getSetting('TG_ENABLED') === 'true',
    token:       getSetting('TG_TOKEN'),
    adminChat:   getSetting('TG_ADMIN_CHAT'),
    chatElmler:  getSetting('TG_CHAT_Elmler'),
    chatSahil:   getSetting('TG_CHAT_Sahil'),
    chatGenclik: getSetting('TG_CHAT_Genclik'),
    chatAgSeher: getSetting('TG_CHAT_AgSeher'),
  };
}
function deptChatId(cfg, dept) {
  if (dept === 'Elmlər')   return cfg.chatElmler;
  if (dept === 'Sahil')    return cfg.chatSahil;
  if (dept === 'Gənclik')  return cfg.chatGenclik;
  if (dept === 'Ağ Şəhər') return cfg.chatAgSeher;
  return '';
}
async function sendTelegramMsg(text, dept) {
  const cfg = getTelegramSettings();
  if (!cfg.enabled || !cfg.token) return;
  const targets = {};
  if (cfg.adminChat) targets[cfg.adminChat] = 1;
  const dc = deptChatId(cfg, dept || '');
  if (dc) targets[dc] = 1;
  for (const cid of Object.keys(targets)) {
    try {
      await fetch(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: cid, text, parse_mode: 'HTML' }),
      });
    } catch (_) {}
  }
}

// ── XP mühərriki ──────────────────────────────────────────────────
// XP çoxaldıcısı — streak nə qədər uzundursa, vaxtında gəlişin XP-si o qədər artır.
function getXPMultiplier(streak) {
  if (streak >= 60) return 2.0;
  if (streak >= 30) return 1.75;
  if (streak >= 14) return 1.5;
  if (streak >= 7)  return 1.25;
  return 1.0;
}

const MS_BONUSES = { 7: 50, 14: 100, 30: 250, 60: 500, 100: 1000 };

// İşçinin XP-sini sıfırdan, mövcud məlumatlardan yenidən hesablayır (recalcAllXP üçün).
// validateAndLog / logLunch / imtahan qaydalarını eyni ardıcıllıqla təkrar oynayır.
// Qaytarır: { xp, streak, milestones } — heç nə yazmır (təmiz funksiya).
function computeEmployeeXP(dept, opts) {
  const o        = opts || {};
  const attend   = o.attendance || [];
  const izinRows = o.izinRows   || [];
  const permMap  = o.permMap    || {};
  const cedvelMap= o.cedvelMap  || {};
  const auditSum = o.auditSum   || 0;
  const exams    = o.exams      || [];

  const onIzin = (ds) => izinRows.some(r => ds >= r.start_date && ds <= r.end_date);

  // 1) Gəlişləri xronoloji oynat → streak proqresiyası + gəliş XP-si
  const arrivals = attend
    .filter(r => r.type === 'GƏLİŞ')
    .map(r => ({ d: new Date(r.timestamp), shift: r.shift_type || '' }))
    .filter(r => !isNaN(r.d.getTime()))
    .sort((a, b) => a.d - b.d);

  let xp = 0, streak = 0;
  const claimed   = new Set();
  const dayStreak = {};   // logicalYMD → streak (gəlişdən sonra)

  for (const a of arrivals) {
    const ds   = getLogicalYMD(a.d);
    const arr  = a.d.getHours() * 60 + a.d.getMinutes();
    const st   = a.shift || cedvelMap[ds] || null;   // calcStreak ilə eyni mənbə (gəliş anındakı smen)
    const lim  = getLateLimit(dept, st, arr);
    const withinPerm = (ds in permMap) && arr <= permMap[ds] + 5;
    const onTime = onIzin(ds) || withinPerm || arr <= lim;
    const streakBefore = streak;

    if (onTime) {
      streak++;
      xp += Math.round(20 * getXPMultiplier(streak));
      if (MS_BONUSES[streak] && !claimed.has(streak)) { xp += MS_BONUSES[streak]; claimed.add(streak); }
    } else {
      const lateMins = arr - lim;
      let penalty = lateMins >= 45 ? 50 : lateMins >= 21 ? 30 : 15;
      if (streakBefore >= 60) penalty = Math.round(penalty * 0.25);
      else if (streakBefore >= 30) penalty = Math.round(penalty * 0.5);
      xp = Math.max(0, xp - penalty);   // validateAndLog hər cərimədə 0-da saxlayır
      streak = 0;
    }
    dayStreak[ds] = streak;
  }

  // 2) Nahar XP-si LƏĞV EDİLDİ — nahara görə artıq XP verilmir (nə çıxışda, nə recalc-da).

  // 3) İmtahan XP-si (özü imtahanı: test balına görə; açıq cavab keçibsə +15)
  for (const ex of exams) {
    const ans = Array.isArray(ex.answers) ? ex.answers : [];
    const examStreak = dayStreak[ex.date_str] || 0;
    const mult = getXPMultiplier(examStreak);
    if (ex.trainer_name === 'Özü') {
      const testTotal = ans.filter(a => a.type === 'test').length;
      const score     = ans.filter(a => a.type === 'test' && a.passed === true).length;
      const pct       = testTotal > 0 ? Math.round(score / testTotal * 100) : 0;
      const xpBase    = pct >= 90 ? 100 : pct >= 80 ? 75 : pct >= 60 ? 50 : 0;
      if (xpBase > 0) xp += Math.round(xpBase * mult);
    }
    const openPassed = ans.filter(a => a.type === 'open' && a.passed === true).length;
    if (openPassed) xp += openPassed * Math.round(15 * mult);
  }

  // 4) Trainer manual XP + reytinqlər (xp_audit_log — düz toplam, çoxaldıcısız)
  xp += auditSum;

  return { xp: Math.max(0, Math.round(xp)), streak, milestones: [...claimed].sort((a, b) => a - b) };
}

module.exports = {
  loadSettings, getSetting, setSetting,
  getXPMultiplier, computeEmployeeXP, MS_BONUSES,
  toYMD, fmtTime, getLogicalYMD, getLogicalDateStr,
  generateDynamicPin, TIME_STEP,
  getShiftInfo, isLate, SHIFT_TABLE, SHIFT_TYPES, SHIFT_NAMES, ALL_SHIFT_TYPES,
  DEFAULT_SALARY, getSalaryConfig, shiftMultiplier, computeDayPay, round2,
  getShiftConfig, defaultShiftConfig, getLateLimit, shiftLabel,
  getEmployeeShift, hasApprovedLeave, getApprovedLatePerm,
  deptToSlug, slugToDept, SLUGS, DEPTS,
  POSITIONS, isValidPosition,
  getBranchScheduleKeys, validateBranchScheduleKey,
  checkWifiIp,
  getTelegramSettings, sendTelegramMsg, deptChatId,
  calcStreak,
};