'use strict';
require('dotenv').config();
const { db } = require('./tdb');        // avto-scope edən klient (xam `sb` işlədilmir)
const T     = require('./tenant');      // müştəri konteksti, parametrlər, filiallar
const fetch = require('node-fetch');

// ── Parametrlər ──────────────────────────────────────────────────
// Əvvəl burada qlobal Map vardı. İndi hər müştərinin öz dəsti var və
// keşi `tenant.js` saxlayır — imzalar dəyişmir, isti döngülər sinxron qalır.
function getSetting(key)          { return T.getSetting(key); }
async function setSetting(key, v) { return T.setSetting(key, v); }

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
// "Məntiqi gün" — gecə smenləri gecə yarısını keçdiyi üçün gün 00:00-da yox,
// müştərinin təyin etdiyi saatda kəsilir (defolt 03:00, DISCIPLINE_CONFIG).
// discRef() işlədilir, getDisciplineConfig() YOX: bu funksiyalar hesabatlarda
// minlərlə dəfə çağırılır, hər çağırışda dərin kopya qəbuledilməzdir.
function dayCutoff() { return discRef().dayCutoffHour; }

function getLogicalYMD(dateObj) {
  const d = new Date(dateObj.getTime());
  if (d.getHours() < dayCutoff()) d.setDate(d.getDate() - 1);
  return toYMD(d);
}
function getLogicalDateStr(dateObj) {
  const d = new Date(dateObj.getTime());
  if (d.getHours() < dayCutoff()) d.setDate(d.getDate() - 1);
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
// Saatlar `settings.SHIFT_CONFIG`-də (müştəri başına) JSON kimi saxlanılır və
// admin panelindən dəyişilir. Aşağıdakılar yalnız HAZIR ŞABLONLARDIR:
// yeni müştəri/filial yaradılanda ilkin dəyər kimi işlədilir.
//
// Əvvəl `getShiftGroup(dept)` filial ADINA baxıb A/B qrupu seçirdi
// ("Ağ Şəhər" və "Gənclik" → A). Bu, sistemi Coffeemoon-a mıxlayan yerlərdən
// biri idi — silindi. İndi hər filial öz saatlarını konfiqurasiyada daşıyır,
// yeni filial isə müştərinin defolt şablonunu miras alır.
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
// Yalnız İLKİN dəyərdir — müştəri onu DISCIPLINE_CONFIG.daypartBoundaryMin ilə dəyişir.
const DAYPART_BOUNDARY_MIN = 13 * 60;

// Müştərinin defolt smen şablonu: hazır şablon adı ('A'/'B') və ya tam JSON.
// Konfiqurasiyada olmayan filial bunu miras alır.
function defaultShiftTemplate() {
  const raw = getSetting('SHIFT_DEFAULT');
  if (!raw) return SHIFT_TABLE.B;
  if (SHIFT_TABLE[raw]) return SHIFT_TABLE[raw];
  try {
    const p = JSON.parse(raw);
    return (p && p.sehersm) ? p : SHIFT_TABLE.B;
  } catch (_) { return SHIFT_TABLE.B; }
}

// Cari müştərinin BÜTÜN filialları üçün ilkin konfiqurasiya qurur.
function defaultShiftConfig() {
  const tpl = defaultShiftTemplate();
  const cfg = {};
  for (const name of T.branchNames()) cfg[name] = JSON.parse(JSON.stringify(tpl));
  return cfg;
}

// Konfiqurasiya keşi — `getShiftInfo` sinxron və döngülərdə çağırılır (recalcAllXP),
// ona görə eyni JSON mətni təkrar parse edilmir.
// DİQQƏT: keş MÜŞTƏRİ ÜZRƏ açarlanır. Yalnız `raw` mətnə baxsaydıq, eyni
// konfiqurasiyalı iki müştəri bir-birinin filial siyahısı ilə qurulmuş
// nəticəni götürərdi (defaultShiftConfig filiallara baxır).
const _shiftCfgCache = new Map();   // tenantId → { raw, parsed }

function getShiftConfig() {
  const raw = getSetting('SHIFT_CONFIG');
  if (!raw) return defaultShiftConfig();
  const tid = T.tenantIdOrNull();
  const hit = _shiftCfgCache.get(tid);
  if (hit && hit.raw === raw) return hit.parsed;
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
    _shiftCfgCache.set(tid, { raw, parsed });
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
  return (arrivalMins < discRef().daypartBoundaryMin)
    ? d.fbMorningH * 60 + d.fbMorningM
    : d.fbEveningH * 60 + d.fbEveningM;
}

function isLate(dept, dateObj) {
  const cut = dayCutoff();
  const h = dateObj.getHours();
  let tot = h * 60 + dateObj.getMinutes();
  if (h < cut) tot += 24 * 60;
  // Gün sərhədindən əvvəlki gəliş "axşam" tərəfə aiddir (tot 24 saat əlavə edilib)
  return tot > getLateLimit(dept, null, h < cut ? discRef().daypartBoundaryMin : tot);
}

// ── DB köməkçi sorğular ───────────────────────────────────────────
async function getEmployeeShift(empId, dateStr) {
  // DİQQƏT: cedvel-də (emp_id,date_str) üzrə unikallıq məhdudiyyəti yoxdur → təkrar sətir ola bilər.
  // .single() təkrar sətirdə XƏTA verib null qaytarırdı → işçi cədvəli görmürdü (menecer görürdü).
  // İndi təkrara dözümlü: ən son yazılmış qeyd qalib (getCedvel menecer görünüşü ilə uyğun).
  const { data } = await db().from('cedvel')
    .select('shift_type')
    .eq('emp_id', String(empId)).eq('date_str', dateStr)
    .order('cedvel_id', { ascending: false })
    .limit(1);
  return (data && data.length) ? (data[0].shift_type || null) : null;
}

async function hasApprovedLeave(empId, dateStr) {
  const { data } = await db().from('izin')
    .select('start_date,end_date').eq('emp_id', String(empId)).eq('status', 'approved');
  return (data || []).some(r => dateStr >= r.start_date && dateStr <= r.end_date);
}

async function getApprovedLatePerm(empId, dateStr) {
  const { data } = await db().from('late_perms')
    .select('requested_time').eq('emp_id', String(empId)).eq('date_str', dateStr).eq('status', 'approved').single();
  return data ? { requestedTime: data.requested_time } : null;
}

// ── Streak ───────────────────────────────────────────────────────
async function calcStreak(empId, dept) {
  const { data: logs } = await db().from('attendance')
    .select('timestamp,shift_type').eq('emp_id', String(empId)).eq('type', 'GƏLİŞ')
    .order('timestamp', { ascending: false });
  if (!logs) return 0;

  // Gec gəliş icazələrini bir dəfə çək (vaxtı ilə birlikdə)
  const { data: perms } = await db().from('late_perms')
    .select('date_str,requested_time').eq('emp_id', String(empId)).eq('status', 'approved');
  const permMap = {};
  for (const p of perms || []) {
    const [ph, pm] = (p.requested_time || '23:59').split(':').map(Number);
    permMap[p.date_str] = ph * 60 + pm;
  }

  // Tam gün izinlərini bir dəfə çək
  const { data: izinRows } = await db().from('izin')
    .select('start_date,end_date').eq('emp_id', String(empId)).eq('status', 'approved');

  // Cədvəli (smenləri) bir dəfə çək — döngü içində sorğu atmamaq üçün (N+1 → 1)
  const { data: cedvelRows } = await db().from('cedvel')
    .select('date_str,shift_type').eq('emp_id', String(empId));
  const shiftMap = {};
  for (const c of cedvelRows || []) shiftMap[c.date_str] = c.shift_type || null;

  function hasIzin(dateStr) {
    return (izinRows || []).some(r => dateStr >= r.start_date && dateStr <= r.end_date);
  }
  const grace = getDisciplineConfig().permGraceMins;
  function withinPerm(dateStr, arrivalMins) {
    return dateStr in permMap && arrivalMins <= permMap[dateStr] + grace;
  }

  let streak = 0;
  for (const row of logs) {
    const d = new Date(row.timestamp);
    if (isNaN(d.getTime())) continue;
    const dateStr     = getLogicalYMD(d);
    const arrivalMins = d.getHours() * 60 + d.getMinutes();

    // Tam gün izin → streak davam edir
    if (hasIzin(dateStr)) { streak++; continue; }
    // Gec gəliş icazəsi — yalnız icazə vaxtı + güzəşt (DISCIPLINE_CONFIG) içindədirsə streak davam edir
    if (withinPerm(dateStr, arrivalMins)) { streak++; continue; }

    // Əvvəlcə cədvəldəki smen, yoxdursa gəliş anında qeyd olunmuş smen (hesabatla uyğun olsun)
    const st = row.shift_type || shiftMap[dateStr] || null;
    const lim = getLateLimit(dept, st, arrivalMins);
    if (arrivalMins <= lim) streak++;
    else break; // Gecikmiş gün — streak dayanır
  }
  return streak;
}

// ── Filial / vəzifə çevirmələri ──────────────────────────────────
// Əvvəl burada `DEPT_SLUG` hardcode 4 filial vardı və yeni filial üçün KOD
// dəyişməli idi. İndi mənbə `branches` cədvəlidir (müştəri başına).
//
// `DEPTS`, `SLUGS`, `POSITIONS` modul ixracında GETTER kimi elan olunub
// (faylın sonuna bax) — yəni `U.DEPTS` yazan 30-a yaxın çağırış yeri olduğu
// kimi qalır, sadəcə massivi cari müştərinin filiallarından alır.
function deptToSlug(dept) { const b = T.branchByName(dept); return b ? b.branch_id : ''; }
function slugToDept(slug) { const b = T.branchBySlug(slug); return b ? b.name : ''; }

function isValidPosition(p) { return T.positions().includes(p); }

// ── Maaş qaydaları ────────────────────────────────────────────────
// Bir SMEN üçün günlük məbləğ (AZN). Tam gün = 2 smen → 2 qat.
// Bunlar yalnız İLKİN dəyərdir — admin panelindən dəyişilir (settings.SALARY_CONFIG).
const DEFAULT_SALARY = {
  // Dərəcələr və taksili filiallar artıq BOŞ başlayır — bunlar hər müştəridə
  // fərqlidir və admin panelindən doldurulur. (Əvvəl Coffeemoon-un öz vəzifə
  // adları və filialları burada hardcode idi.)
  rates: {},
  defaultRate: 0,                                 // konfiqurasiyada olmayan vəzifə üçün
  taxi: 0,                                        // günlük sabit məbləğ (tam gündə DƏ bir dəfə)
  taxiDepts: [],                                  // taksi yalnız bu filiallarda
  taxiShifts: ['axsamsm', 'fullsm', 'tamgun'],    // axşam tərəfli smenlər
  // Bir işçiyə ayda ən çoxu neçə taksili gün yazıla bilər (taksi büdcəsi limiti).
  // İşçi bazasında `taxi_limit` varsa o üstündür (admin fərdi artıra bilər).
  taxiMonthlyLimit: 13,

  // Cədvəldə İSTİRAHƏT (istirahetsm) yazılan gün də ödənilir — işçi gəlmir, amma
  // günlük maaşını alır. Taksi verilmir (yola çıxmır). Boş xanalar ödənilmir —
  // yalnız menecerin açıq şəkildə istirahət təyin etdiyi günlər.
  restDayPaid: true,
  restDayMultiplier: 1,     // 1 = tam smen maaşı; 0.5 desən yarısı ödənilər
  // Bir işçiyə ayda ən çoxu neçə istirahət günü ÖDƏNİLİR. Cədvəli menecer yazır və
  // istirahət günü gəliş tələb etmir — tavan olmasa bütün ay istirahət yazılıb işləmədən
  // tam maaş almaq mümkündür. Cədvəl saxlanması bloklanmır (iş axını sınmasın),
  // yalnız hesabatda limitdən sonrakı günlər ödənilmir və admin-ə göstərilir.
  // 31 = praktiki olaraq limitsiz.
  restDayMonthlyLimit: 12,

  // ── Tutulmalar ──
  // Sistem cərimələrinin statusu: unpaid | paid | waived.
  // 'waived' (bağışlanıb) heç vaxt tutulmur; 'paid' isə nağd alınıbsa təkrar tutulmasın deyə defolt xaricdədir.
  fineStatuses: ['unpaid'],
  // İMZA QAYDASI (hər iki cərimə növü üçün ortaq).
  // true  → yalnız işçinin e-imza ilə TƏSDİQLƏDİYİ cərimələr maaş hesabatında görünür və tutulur.
  //         İmzalanmayan cərimə hesabatda ümumiyyətlə görünmür (nə məbləğdə, nə siyahıda).
  // false → imzadan asılı olmayaraq hamısı tutulur.
  // Defolt `true`-dur: işçinin xəbəri olmadan maaşından pul tutulmasın.
  //
  // Əvvəl `mgrFinesOnlyAcked` adlanırdı və YALNIZ menecer cəriməsinə aid idi
  // (sistem cəriməsi imzadan asılı olmadan tutulurdu). 2026-08-20-dən birləşdirilib.
  finesOnlyAcked: true,
  // Avans statusu: pending | approved | rejected | paid
  avansStatuses: ['approved', 'paid'],
};

// Bir günə neçə smen maaşı düşür
function shiftMultiplier(shiftType) {
  return shiftType === 'tamgun' ? 2 : 1;
}

// Keşlənən yalnız PARSE+VALIDASIYA nəticəsidir. Hər çağırışa təzə kopya qaytarılır —
// çağıran obyekti dəyişsə (məs. cfg.rates.Barista = 0) keş zəhərlənib bütün prosesə
// yayılmasın deyə. Kopyanın qiyməti ~mikrosaniyədir, `!raw` yolu onsuz da belə edir.
// Keş MÜŞTƏRİ ÜZRƏ açarlanır — `rates` müştərinin vəzifə siyahısı ilə tamamlanır,
// ona görə eyni JSON mətni iki müştəridə eyni nəticə vermir.
const _salCfgCache = new Map();   // tenantId → { raw, cfg }
function getSalaryConfig() {
  const raw = getSetting('SALARY_CONFIG');
  if (!raw) return JSON.parse(JSON.stringify(DEFAULT_SALARY));
  const tid = T.tenantIdOrNull();
  const hit = _salCfgCache.get(tid);
  if (hit && hit.raw === raw) return JSON.parse(JSON.stringify(hit.cfg));
  try {
    const p = JSON.parse(raw);
    const base = JSON.parse(JSON.stringify(DEFAULT_SALARY));
    const cfg = {
      rates: Object.assign({}, base.rates, (p && p.rates) || {}),
      taxi: typeof (p && p.taxi) === 'number' ? p.taxi : base.taxi,
      taxiDepts: Array.isArray(p && p.taxiDepts) ? p.taxiDepts : base.taxiDepts,
      taxiShifts: Array.isArray(p && p.taxiShifts) ? p.taxiShifts : base.taxiShifts,
      taxiMonthlyLimit: (Number.isFinite(p && p.taxiMonthlyLimit) && p.taxiMonthlyLimit >= 0) ? p.taxiMonthlyLimit : base.taxiMonthlyLimit,
      restDayPaid: typeof (p && p.restDayPaid) === 'boolean' ? p.restDayPaid : base.restDayPaid,
      restDayMultiplier: (Number.isFinite(p && p.restDayMultiplier) && p.restDayMultiplier >= 0 && p.restDayMultiplier <= 2)
        ? p.restDayMultiplier : base.restDayMultiplier,
      restDayMonthlyLimit: (Number.isFinite(p && p.restDayMonthlyLimit) && p.restDayMonthlyLimit >= 0 && p.restDayMonthlyLimit <= 31)
        ? Math.round(p.restDayMonthlyLimit) : base.restDayMonthlyLimit,
      fineStatuses: Array.isArray(p && p.fineStatuses) ? p.fineStatuses : base.fineStatuses,
      // DİQQƏT: köhnə `mgrFinesOnlyAcked` QƏSDƏN oxunmur. O, yalnız menecer
      // cəriməsinə aid idi və defolt `false` ilə saxlanılmışdı; oxusaydıq
      // mövcud müştərilərdə yeni imza qaydası işə düşməzdi.
      finesOnlyAcked: typeof (p && p.finesOnlyAcked) === 'boolean' ? p.finesOnlyAcked : base.finesOnlyAcked,
      avansStatuses: Array.isArray(p && p.avansStatuses) ? p.avansStatuses : base.avansStatuses,
    };
    // Müştərinin hər vəzifəsi üçün dərəcə olsun (təyin edilməyibsə 0 → hesabatda görünür)
    cfg.defaultRate = Number.isFinite(p && p.defaultRate) ? p.defaultRate : base.defaultRate;
    for (const pos of T.positions()) {
      if (typeof cfg.rates[pos] !== 'number') cfg.rates[pos] = cfg.defaultRate;
    }
    _salCfgCache.set(tid, { raw, cfg });
    return JSON.parse(JSON.stringify(cfg));
  } catch (e) {
    console.error('[SALARY_CONFIG] parse xətası — ilkin dəyərlər işlədilir:', e.message);
    return JSON.parse(JSON.stringify(DEFAULT_SALARY));
  }
}

// Həmin gün taksi qazandırırmı? (filial + smen şərti)
function isTaxiDay(dept, shiftType, cfg) {
  const c = cfg || getSalaryConfig();
  return c.taxiDepts.indexOf(dept) >= 0 && c.taxiShifts.indexOf(shiftType) >= 0;
}

// İşçinin aylıq taksi limiti: fərdi dəyər varsa o, yoxsa ümumi limit.
// `raw` — employees.taxi_limit (null/undefined ola bilər).
function taxiLimitFor(raw, cfg) {
  const c = cfg || getSalaryConfig();
  // DİQQƏT: Number(null) və Number('') → 0. Bunları əvvəlcə kəsməsək, fərdi limiti
  // OLMAYAN işçinin limiti 0 çıxır və heç vaxt taksi almır (test bunu tutdu).
  if (raw === null || raw === undefined || raw === '') return c.taxiMonthlyLimit;
  const n = Number(raw);
  return (Number.isFinite(n) && n >= 0) ? n : c.taxiMonthlyLimit;
}

// Avansın hansı aya AİD olduğu: təsdiq/ödəniş günü (`decided_ymd`), o yoxdursa tələb günü.
// Səbəb: pul qərar anında verilir. Tələb tarixi ilə bağlasaq, iyulda istənib avqustda
// təsdiqlənən avans artıq ödənilmiş iyula düşür və tutulma itir.
function avansAitYMD(row) {
  if (!row) return '';
  return row.decided_ymd || row.date_str || '';
}

// İki ayrı sorğudan (tələb tarixi üzrə + qərar tarixi üzrə) gələn avans sətirlərini
// birləşdirir, `avans_id` üzrə təkrarı atır və yalnız AİD OLDUĞU ay [start, end)
// aralığına düşənləri saxlayır. Belədə sətir nə itir, nə də iki ayda ikiqat tutulur.
function pickAvansForMonth(rows, startStr, endStr) {
  const uniq = new Map();
  for (const r of rows || []) {
    if (!r) continue;
    uniq.set(r.avans_id != null ? String(r.avans_id) : JSON.stringify(r), r);
  }
  return [...uniq.values()].filter(r => {
    const aid = avansAitYMD(r);
    return aid >= startStr && aid < endStr;
  });
}

// Verilmiş tarixin həftə başlanğıcı (bazar ertəsi) — YYYY-MM-DD
function weekStartYMD(dateObj) {
  const d = new Date(dateObj || new Date());
  d.setHours(0, 0, 0, 0);
  const g = d.getDay() === 0 ? 6 : d.getDay() - 1;   // bazar = 6
  d.setDate(d.getDate() - g);
  return toYMD(d);
}

// İSTİRAHƏT gününün ödənişi. İşçi gəlmir, amma günlük maaşını alır; taksi verilmir.
// Yalnız cədvəldə açıq şəkildə `istirahetsm` yazılan günlər — boş xanalar ödənilmir.
function computeRestDayPay(position, cfg) {
  const c = cfg || getSalaryConfig();
  if (!c.restDayPaid) return { pay: 0, taxi: 0, shifts: 0 };
  const rate = c.rates[position] || 0;
  return { pay: round2(rate * c.restDayMultiplier), taxi: 0, shifts: 0 };
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

// ── Filial açarları ───────────────────────────────────────────────
// Əvvəl açarlar `settings.SCHED_KEY_<slug>`-də idi. İndi `auth_keys` cədvəlində —
// belədə açar həm rolu, həm filialı, həm də MÜŞTƏRİni özü ilə daşıyır.
async function getBranchScheduleKeys() {
  return T.branchKeys();
}

function validateBranchScheduleKey(key) {
  return T.branchByKey(key);
}

// ── WiFi IP yoxlaması ─────────────────────────────────────────────
// IP-lər `branches.wifi_ips` sütunundadır (əvvəl `settings.IP_<slug>`).
function checkWifiIp(dept, clientIp) {
  const b = T.branchByName(dept);
  if (!b) return { ok: true };
  const reg = b.wifi_ips || '';
  if (!reg) return { ok: false, reason: 'Bu filial üçün WiFi IP hələ qeydə alınmayıb.' };
  if (!clientIp) return { ok: true };
  const allowed = reg.split(',').map(s => s.trim());
  if (allowed.some(a => a && clientIp.startsWith(a))) return { ok: true };
  return { ok: false, reason: 'Filial WiFi-ına qoşulmamısınız!' };
}

// ── Telegram ─────────────────────────────────────────────────────
// Filial chat ID-ləri `branches.tg_chat_id`-dədir (əvvəl hər filial üçün
// ayrıca `TG_CHAT_<Ad>` parametri və `deptChatId`-də if-lər zənciri vardı).
function getTelegramSettings() {
  const chats = {};
  for (const b of T.branches()) chats[b.name] = b.tg_chat_id || '';
  return {
    enabled:   getSetting('TG_ENABLED') === 'true',
    token:     getSetting('TG_TOKEN'),
    adminChat: getSetting('TG_ADMIN_CHAT'),
    chats,                                 // { filialAdı: chatId }
  };
}
function deptChatId(cfg, dept) {
  return (cfg && cfg.chats && cfg.chats[dept]) || '';
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

// ── Telegram mesaj şablonları ─────────────────────────────────────
// Əvvəl bu mətnlər server.js-də şablon sətri kimi hardcode idi. İndi hər müştəri
// öz dilini/tonunu paneldən yazır. Şablonda `{ad}` kimi yer tutucular işlədilir.
//
// QAYDA: yer tutucu naməlum olsa OLDUĞU KİMİ qalır (silinmir) — belədə yazı
// səhvi mesajı görünməz etmir, gözə çarpır və düzəldilir.
const DEFAULT_TG = {
  arrive:     '<b>{ad}</b> smendə.\n{saat}{qeyd}',
  leave:      '<b>{ad}</b> smendən çıxdı.\n{saat} — {ferq}',
  lunchGo:    '<b>{ad}</b> naharda.\n{saat}',
  lunchBack:  '<b>{ad}</b> nahar bitdi.\n{saat} — {deq} dəq',
  mgrIn:      '<b>Menecer</b> işdə.\n{saat}',
  mgrOut:     '<b>Menecer</b> smendən çıxdı.\n{saat} — {ferq}',
  // Gəliş mesajının sonuna qoşulan {qeyd} hissəsi
  onTime:     ' — Vaxtında',
  late1:      '\n Bu ay <b>1-ci gecikmə</b> — {deq} dəq. Xəbərdarlıq.',
  late2:      '\n Bu ay <b>{say}-ci gecikmə</b> — {deq} dəq. Ciddi xəbərdarlıq!',
  lateFine:   '\n Bu ay <b>{say}-ci gecikmə</b> — {deq} dəq.\n <b>{mebleg} AZN cərimə</b> qeyd edildi.',
  deptChange: '<b>{ad}</b> filialı dəyişdi: {kohne} → <b>{yeni}</b>',
  newDevice:  '<b>{brend}</b>\n\n📱 <b>Yeni Scan Cihazı qeydə alındı</b>\n\n🔑 <code>{cihaz}</code>',
  nightClose: '🤖 <b>Gecəlik avtomatik bağlama</b>\n\n{say} açıq smen avtomatik olaraq bağlandı.',
  emergency:  '🚨 <b>TƏCİLİ BİLDİRİŞ</b>\n\n👤 <b>{ad}</b> ({filial})\n\n💬 {mesaj}',
};
const TG_KEYS = Object.keys(DEFAULT_TG);

const _tgCache = new Map();   // tenantId → { raw, cfg }
function getTgTemplates() {
  const raw = getSetting('TG_TEMPLATES');
  if (!raw) return Object.assign({}, DEFAULT_TG);
  const tid = T.tenantIdOrNull();
  const hit = _tgCache.get(tid);
  if (hit && hit.raw === raw) return Object.assign({}, hit.cfg);
  try {
    const p = JSON.parse(raw);
    const cfg = Object.assign({}, DEFAULT_TG);
    for (const k of TG_KEYS) {
      // Boş sətir QƏSDƏN icazəlidir: müştəri həmin mesajı susdura bilər.
      if (p && typeof p[k] === 'string') cfg[k] = p[k];
    }
    _tgCache.set(tid, { raw, cfg });
    return Object.assign({}, cfg);
  } catch (e) {
    console.error('[TG_TEMPLATES] parse xətası — ilkin mətnlər işlədilir:', e.message);
    return Object.assign({}, DEFAULT_TG);
  }
}

// Şablonu doldurur. Dəyər `undefined`/`null` olsa yer tutucu olduğu kimi qalır.
function fillTemplate(tpl, vars) {
  if (typeof tpl !== 'string' || !tpl) return '';
  return tpl.replace(/\{(\w+)\}/g, (m, k) =>
    (vars && vars[k] !== undefined && vars[k] !== null) ? String(vars[k]) : m);
}

// Şablon açarı ilə mesaj göndər — server.js-də hardcode sətir qalmasın deyə.
async function sendTgTemplate(key, vars, dept) {
  const text = fillTemplate(getTgTemplates()[key], vars);
  if (!text.trim()) return;          // müştəri bu mesajı söndürüb
  await sendTelegramMsg(text, dept);
}

// ── Push (telefon) bildiriş şablonları ────────────────────────────
// Telegram şablonları ilə eyni məntiq, sadəcə hər bildirişin BAŞLIĞI və
// MƏTNİ ayrıdır. Başlıq da, mətn də boşdursa bildiriş ümumiyyətlə göndərilmir.
const DEFAULT_PUSH = {
  izinDecision:     { title: '{emoji} İzin Tələbi',        body: '{bas} – {son} tarixlərə müraciətiniz {status}.' },
  latePermRequest:  { title: '🕐 Gec Gəliş İcazəsi',       body: '{ad}: {tarix} — {saat}' },
  latePermDecision: { title: '{emoji} Gec Gəliş İcazəsi',  body: '{tarix} tarixi üçün {saat} icazəniz {status}.' },
  avansRequest:     { title: '💵 Yeni Avans Tələbi',       body: '{ad}: {mebleg} AZN{qeyd}' },
  avansDecision:    { title: '{emoji} Avans Tələbi',       body: '{mebleg} AZN avans tələbiniz {status}.' },
  mgrFine:          { title: '⚠️ Cərimə Bildirişi',        body: '{mebleg} AZN — {sebeb}. Təsdiqləmək üçün kartınıza daxil olun.' },
  fineAck:          { title: '✍️ Cərimə Təsdiqləndi',      body: '{ad}: {mebleg} AZN cəriməsini təsdiqlədi (imzaladı).' },
  lunchLate:        { title: '⚠️ Nahar gecikməsi',         body: '{ad}: nahardan {deq} dəq sonra qayıtdı (limit {limit} dəq).' },
  execGlobal:       { title: '📢 {icraci} — ümumi mesaj',  body: '{mesaj}' },
  execMsg:          { title: '📩 {icraci} — mesaj',        body: '{mesaj}' },
  execAck:          { title: '✅ Mesaj təsdiqləndi',        body: '{filial} meneceri {nov} təsdiqlədi ({saat}).' },
  announce:         { title: '{emoji} {basliq}',           body: '{metn}' },
  examDone:         { title: '📝 İmtahan tamamlandı',      body: '{metn}' },
};
const PUSH_KEYS = Object.keys(DEFAULT_PUSH);

const _pushCache = new Map();
function getPushTemplates() {
  const raw = getSetting('PUSH_TEMPLATES');
  if (!raw) return JSON.parse(JSON.stringify(DEFAULT_PUSH));
  const tid = T.tenantIdOrNull();
  const hit = _pushCache.get(tid);
  if (hit && hit.raw === raw) return JSON.parse(JSON.stringify(hit.cfg));
  try {
    const p   = JSON.parse(raw);
    const cfg = JSON.parse(JSON.stringify(DEFAULT_PUSH));
    for (const k of PUSH_KEYS) {
      const v = p && p[k];
      if (!v || typeof v !== 'object') continue;
      if (typeof v.title === 'string') cfg[k].title = v.title;
      if (typeof v.body  === 'string') cfg[k].body  = v.body;
    }
    _pushCache.set(tid, { raw, cfg });
    return JSON.parse(JSON.stringify(cfg));
  } catch (e) {
    console.error('[PUSH_TEMPLATES] parse xətası — ilkin mətnlər işlədilir:', e.message);
    return JSON.parse(JSON.stringify(DEFAULT_PUSH));
  }
}

// Şablonu doldurur. Başlıq və mətn hər ikisi boşdursa `null` qaytarır —
// çağıran tərəf bildirişi ÜMUMİYYƏTLƏ göndərmir (susdurma yolu).
function fillPush(key, vars) {
  const t = getPushTemplates()[key];
  if (!t) return null;
  const title = fillTemplate(t.title, vars);
  const body  = fillTemplate(t.body,  vars);
  if (!title.trim() && !body.trim()) return null;
  return { title, body };
}

// ── İNTİZAM QAYDALARI (cərimə / gecikmə / nahar) ──────────────────
// Bunlar əvvəl kodda sabit rəqəm idi (30 AZN, 3-cü gecikmə, 45/21 dəq…).
// Hər müştəridə fərqlidir → paneldən idarə olunur (settings.DISCIPLINE_CONFIG).
const DEFAULT_DISCIPLINE = {
  fineAmount:     30,   // AZN — cərimə məbləği
  fineAfterLates: 2,    // bu qədər gecikmədən SONRA cərimə başlayır (2 → 3-cü gecikmə)
  permGraceMins:  5,    // gec gəliş icazəsi vaxtına verilən əlavə güzəşt
  lunchMaxMins:   30,   // nahar limiti — bundan çox → menecerə bildiriş
  lateWarnBuffer: 5,    // işçi kartında "gecikmisən" xəbərdarlığı bu qədər sonra çıxır
  avansMax:       1000, // işçinin bir dəfəyə istəyə biləcəyi ən çox avans (AZN)
  mgrFineMax:     1000, // menecerin yaza biləcəyi ən çox cərimə (AZN)
  // ── Gün sərhədi ──
  // Gecə smenləri gecə yarısını keçdiyi üçün "gün" saat 00:00-da yox, bu saatda kəsilir.
  // 03:00-dan əvvəlki gəliş ƏVVƏLKİ günə yazılır. Gecə işləməyən müştəri 0 qoya bilər.
  dayCutoffHour:  3,
  // Cədvəldə smen yazılmayıbsa gəlişin səhər yoxsa axşam smeni olduğunu bu dəqiqə ayırır
  // (13:00 — ondan əvvəl səhər, sonra axşam sayılır).
  daypartBoundaryMin: 13 * 60,
  // Gecikmə XP cəzası: SIRALAMA VACİBDİR — ilk uyğun gələn tətbiq olunur,
  // ona görə siyahı `mins` üzrə azalan olmalıdır (validasiya bunu təmin edir).
  latePenalty: [
    { mins: 45, xp: 50 },
    { mins: 21, xp: 30 },
    { mins: 0,  xp: 15 },
  ],
  // Streak qalxanı: uzun streak-i olan işçinin cəzası azalır
  streakShield: [
    { streak: 60, mult: 0.25 },
    { streak: 30, mult: 0.5  },
  ],
};

const _discCache = new Map();
function getDisciplineConfig() {
  const raw = getSetting('DISCIPLINE_CONFIG');
  if (!raw) return JSON.parse(JSON.stringify(DEFAULT_DISCIPLINE));
  const tid = T.tenantIdOrNull();
  const hit = _discCache.get(tid);
  if (hit && hit.raw === raw) return JSON.parse(JSON.stringify(hit.cfg));
  try {
    const p    = JSON.parse(raw);
    const base = JSON.parse(JSON.stringify(DEFAULT_DISCIPLINE));
    const num = (v, fb, min, max) => {
      const n = Number(v);
      return (Number.isFinite(n) && n >= min && n <= max) ? n : fb;
    };
    const cfg = {
      fineAmount:     num(p && p.fineAmount,     base.fineAmount,     0, 100000),
      fineAfterLates: Math.round(num(p && p.fineAfterLates, base.fineAfterLates, 0, 31)),
      permGraceMins:  Math.round(num(p && p.permGraceMins,  base.permGraceMins,  0, 180)),
      lunchMaxMins:   Math.round(num(p && p.lunchMaxMins,   base.lunchMaxMins,   1, 480)),
      lateWarnBuffer: Math.round(num(p && p.lateWarnBuffer, base.lateWarnBuffer, 0, 180)),
      avansMax:       num(p && p.avansMax,   base.avansMax,   1, 1000000),
      mgrFineMax:     num(p && p.mgrFineMax, base.mgrFineMax, 1, 1000000),
      // 0–6 aralığı: gün sərhədini günortadan sonraya çəkmək məntiqsizdir və
      // bütün streak/hesabat məntiqini pozardı, ona görə qəsdən dar saxlanılıb.
      dayCutoffHour:  Math.round(num(p && p.dayCutoffHour, base.dayCutoffHour, 0, 6)),
      daypartBoundaryMin: Math.round(num(p && p.daypartBoundaryMin, base.daypartBoundaryMin, 0, 1439)),
      latePenalty:    sanitizeTiers(p && p.latePenalty,  base.latePenalty,  'mins',   0, 1440, 'xp',   0, 100000),
      streakShield:   sanitizeTiers(p && p.streakShield, base.streakShield, 'streak', 1, 3650, 'mult', 0, 1),
    };
    _discCache.set(tid, { raw, cfg });
    return JSON.parse(JSON.stringify(cfg));
  } catch (e) {
    console.error('[DISCIPLINE_CONFIG] parse xətası — ilkin dəyərlər işlədilir:', e.message);
    return JSON.parse(JSON.stringify(DEFAULT_DISCIPLINE));
  }
}

// UCUZ, KOPYALAMAYAN oxu — yalnız daxili istifadə üçün.
//
// NİYƏ: `getDisciplineConfig()` hər çağırışda dərin kopya qaytarır (keş
// zəhərlənməsin deyə). `getLogicalYMD` isə bir hesabatda MİNLƏRLƏ dəfə
// çağırılır — orada hər dəfə JSON.parse(JSON.stringify(...)) etmək olmaz.
// Bu funksiya keşdəki obyektin ÖZÜNÜ qaytarır. Qaytarılan obyekti DƏYİŞMƏ.
function discRef() {
  const raw = getSetting('DISCIPLINE_CONFIG');
  if (!raw) return DEFAULT_DISCIPLINE;
  const tid = T.tenantIdOrNull();
  let hit = _discCache.get(tid);
  if (!hit || hit.raw !== raw) {
    getDisciplineConfig();               // keşi doldurur (validasiya orada)
    hit = _discCache.get(tid);
  }
  return (hit && hit.raw === raw) ? hit.cfg : DEFAULT_DISCIPLINE;
}

// Pilləli siyahını təmizləyir: yanlış sətirlər atılır, qalanlar AZALAN sıralanır.
// Sıralama olmasa "ilk uyğun gələn" məntiqi səhv pilləni seçər (məs. 0 dəq hamısını tutar).
function sanitizeTiers(rows, fallback, kA, minA, maxA, kB, minB, maxB) {
  if (!Array.isArray(rows)) return fallback;
  const out = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const a = Number(r[kA]), b = Number(r[kB]);
    if (!Number.isFinite(a) || a < minA || a > maxA) continue;
    if (!Number.isFinite(b) || b < minB || b > maxB) continue;
    out.push({ [kA]: a, [kB]: b });
  }
  if (!out.length) return fallback;
  out.sort((x, y) => y[kA] - x[kA]);
  return out;
}

// Gecikməyə düşən XP cəzası (streak qalxanı tətbiq olunmuş halda).
// `streakBefore` — gecikmədən ƏVVƏLKİ streak.
function latePenaltyXP(lateMins, streakBefore, cfg) {
  const c    = cfg || getDisciplineConfig();
  const mins = Math.max(0, Number(lateMins) || 0);
  const tier = c.latePenalty.find(t => mins >= t.mins);
  let penalty = tier ? tier.xp : 0;
  const shield = c.streakShield.find(s => (Number(streakBefore) || 0) >= s.streak);
  if (shield) penalty = Math.round(penalty * shield.mult);
  return penalty;
}

// ── XP MÜKAFATLARI ────────────────────────────────────────────────
// Gəliş XP-si, streak çoxaldıcısı, milestone bonusları, imtahan/reytinq XP-si.
const DEFAULT_XP = {
  arrivalXP:    20,       // vaxtında gəliş (çoxaldıcıya vurulur)
  openAnswerXP: 15,       // imtahanda açıq cavab keçəndə
  multipliers: [
    { streak: 60, mult: 2.0  },
    { streak: 30, mult: 1.75 },
    { streak: 14, mult: 1.5  },
    { streak: 7,  mult: 1.25 },
  ],
  milestones: { 7: 50, 14: 100, 30: 250, 60: 500, 100: 1000 },
  examTiers: [            // test faizinə görə XP
    { pct: 90, xp: 100 },
    { pct: 80, xp: 75  },
    { pct: 60, xp: 50  },
  ],
  ratingXP: { 3: 15, 4: 30, 5: 50 },   // trainer reytinqi (ulduz → XP)
};

const _xpCache = new Map();
function getXPConfig() {
  const raw = getSetting('XP_CONFIG');
  if (!raw) return JSON.parse(JSON.stringify(DEFAULT_XP));
  const tid = T.tenantIdOrNull();
  const hit = _xpCache.get(tid);
  if (hit && hit.raw === raw) return JSON.parse(JSON.stringify(hit.cfg));
  try {
    const p    = JSON.parse(raw);
    const base = JSON.parse(JSON.stringify(DEFAULT_XP));
    const num = (v, fb, min, max) => {
      const n = Number(v);
      return (Number.isFinite(n) && n >= min && n <= max) ? n : fb;
    };
    // Açar→rəqəm xəritəsi (milestones, ratingXP): açar müsbət tam ədəd olmalıdır
    const numMap = (v, fb) => {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return fb;
      const out = {};
      for (const k of Object.keys(v)) {
        const key = Math.round(Number(k)), val = Number(v[k]);
        if (!Number.isFinite(key) || key <= 0) continue;
        if (!Number.isFinite(val) || val < 0 || val > 100000) continue;
        out[key] = val;
      }
      return Object.keys(out).length ? out : fb;
    };
    const cfg = {
      arrivalXP:    num(p && p.arrivalXP,    base.arrivalXP,    0, 100000),
      openAnswerXP: num(p && p.openAnswerXP, base.openAnswerXP, 0, 100000),
      multipliers:  sanitizeTiers(p && p.multipliers, base.multipliers, 'streak', 1, 3650, 'mult', 0, 100),
      examTiers:    sanitizeTiers(p && p.examTiers,   base.examTiers,   'pct',    0, 100,  'xp',   0, 100000),
      milestones:   numMap(p && p.milestones, base.milestones),
      ratingXP:     numMap(p && p.ratingXP,   base.ratingXP),
    };
    _xpCache.set(tid, { raw, cfg });
    return JSON.parse(JSON.stringify(cfg));
  } catch (e) {
    console.error('[XP_CONFIG] parse xətası — ilkin dəyərlər işlədilir:', e.message);
    return JSON.parse(JSON.stringify(DEFAULT_XP));
  }
}

// İmtahan faizinə düşən XP
function examXP(pct, cfg) {
  const c = cfg || getXPConfig();
  const t = c.examTiers.find(x => (Number(pct) || 0) >= x.pct);
  return t ? t.xp : 0;
}

// ── XP mühərriki ──────────────────────────────────────────────────
// XP çoxaldıcısı — streak nə qədər uzundursa, vaxtında gəlişin XP-si o qədər artır.
// Pillələr `XP_CONFIG.multipliers`-dədir (əvvəl burada hardcode idi).
function getXPMultiplier(streak, cfg) {
  const c = cfg || getXPConfig();
  const t = c.multipliers.find(x => (Number(streak) || 0) >= x.streak);
  return t ? t.mult : 1.0;
}

// GERİYƏ UYĞUNLUQ: `U.MS_BONUSES` yazan köhnə kod var. Getter kimi elan olunub —
// cari müştərinin konfiqurasiyasından gəlir, çağırış yerləri dəyişmir.
// (`U.DEPTS`/`U.POSITIONS` ilə eyni hiylə.)
function milestoneBonuses(cfg) { return (cfg || getXPConfig()).milestones; }

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

  // Konfiqurasiya bir dəfə oxunur — döngə içində yüzlərlə dəfə oxunmasın.
  const xpCfg   = getXPConfig();
  const discCfg = getDisciplineConfig();
  const msBonus = xpCfg.milestones;

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
    const withinPerm = (ds in permMap) && arr <= permMap[ds] + discCfg.permGraceMins;
    const onTime = onIzin(ds) || withinPerm || arr <= lim;
    const streakBefore = streak;

    if (onTime) {
      streak++;
      xp += Math.round(xpCfg.arrivalXP * getXPMultiplier(streak, xpCfg));
      if (msBonus[streak] && !claimed.has(streak)) { xp += msBonus[streak]; claimed.add(streak); }
    } else {
      xp = Math.max(0, xp - latePenaltyXP(arr - lim, streakBefore, discCfg));
      streak = 0;                       // validateAndLog hər cərimədə 0-da saxlayır
    }
    dayStreak[ds] = streak;
  }

  // 2) Nahar XP-si LƏĞV EDİLDİ — nahara görə artıq XP verilmir (nə çıxışda, nə recalc-da).

  // 3) İmtahan XP-si (özü imtahanı: test balına görə; açıq cavab keçibsə +15)
  for (const ex of exams) {
    const ans = Array.isArray(ex.answers) ? ex.answers : [];
    const examStreak = dayStreak[ex.date_str] || 0;
    const mult = getXPMultiplier(examStreak, xpCfg);
    if (ex.trainer_name === 'Özü') {
      const testTotal = ans.filter(a => a.type === 'test').length;
      const score     = ans.filter(a => a.type === 'test' && a.passed === true).length;
      const pct       = testTotal > 0 ? Math.round(score / testTotal * 100) : 0;
      const xpBase    = examXP(pct, xpCfg);
      if (xpBase > 0) xp += Math.round(xpBase * mult);
    }
    const openPassed = ans.filter(a => a.type === 'open' && a.passed === true).length;
    if (openPassed) xp += openPassed * Math.round(xpCfg.openAnswerXP * mult);
  }

  // 4) Trainer manual XP + reytinqlər (xp_audit_log — düz toplam, çoxaldıcısız)
  xp += auditSum;

  return { xp: Math.max(0, Math.round(xp)), streak, milestones: [...claimed].sort((a, b) => a - b) };
}

module.exports = {
  getSetting, setSetting,
  getXPMultiplier, computeEmployeeXP,
  // İntizam / XP / Telegram konfiqurasiyaları (əvvəl kodda hardcode idi)
  DEFAULT_DISCIPLINE, getDisciplineConfig, latePenaltyXP,
  DEFAULT_XP, getXPConfig, examXP, milestoneBonuses,
  DEFAULT_TG, TG_KEYS, getTgTemplates, fillTemplate, sendTgTemplate,
  DEFAULT_PUSH, PUSH_KEYS, getPushTemplates, fillPush,
  toYMD, fmtTime, getLogicalYMD, getLogicalDateStr,
  generateDynamicPin, TIME_STEP,
  getShiftInfo, isLate, SHIFT_TABLE, SHIFT_TYPES, SHIFT_NAMES, ALL_SHIFT_TYPES,
  DEFAULT_SALARY, getSalaryConfig, shiftMultiplier, computeDayPay, round2,
  isTaxiDay, taxiLimitFor, weekStartYMD, computeRestDayPay,
  avansAitYMD, pickAvansForMonth,
  getShiftConfig, defaultShiftConfig, defaultShiftTemplate, getLateLimit, shiftLabel,
  getEmployeeShift, hasApprovedLeave, getApprovedLatePerm,
  deptToSlug, slugToDept,
  isValidPosition,
  getBranchScheduleKeys, validateBranchScheduleKey,
  checkWifiIp,
  getTelegramSettings, sendTelegramMsg, deptChatId,
  calcStreak,
};

// ── Dinamik siyahılar ────────────────────────────────────────────
// `DEPTS`, `SLUGS`, `POSITIONS` əvvəl sabit massiv idi. İndi cari müştərinin
// bazasından gəlir, amma GETTER kimi elan olunub — yəni `U.DEPTS` yazan
// bütün mövcud kod (server.js-də ~30 yer) olduğu kimi işləməyə davam edir.
// Funksiyaya çevirsəydik hər çağırış yerini əl ilə düzəltmək lazım gələcəkdi.
Object.defineProperties(module.exports, {
  DEPTS:     { enumerable: true, get: () => T.branchNames() },
  SLUGS:     { enumerable: true, get: () => T.branchSlugs() },
  POSITIONS: { enumerable: true, get: () => T.positions() },
  // Milestone bonusları da eyni üsulla: `U.MS_BONUSES` yazan kod dəyişmir,
  // dəyər isə artıq müştərinin XP konfiqurasiyasından gəlir.
  MS_BONUSES: { enumerable: true, get: () => getXPConfig().milestones },
});