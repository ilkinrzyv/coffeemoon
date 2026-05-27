'use strict';
require('dotenv').config();
const { db }   = require('./db');
const fetch    = require('node-fetch');

// ── Sadə TTL cache (CacheService yerinə) ────────────────────────
const _cache = new Map();

function cacheSet(key, value, ttlSeconds = 1800) {
  _cache.set(key, { value, expires: Date.now() + ttlSeconds * 1000 });
}
function cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) { _cache.delete(key); return null; }
  return entry.value;
}
function cacheDelete(key) { _cache.delete(key); }

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
function getMondayYMD(d) {
  const dow = d.getDay();
  const delta = dow === 0 ? 6 : dow - 1;
  const m = new Date(d.getTime() - delta * 86400000);
  m.setHours(0, 0, 0, 0);
  return toYMD(m);
}
function getDayShort(dateStr) {
  const names = ['B.e.','Ç.a.','Çər.','C.a.','Cüm.','Şən.','Baz.'];
  const d = new Date(dateStr);
  return names[d.getDay() === 0 ? 6 : d.getDay() - 1];
}

// ── PIN generasiyası (həm server, həm client-də eyni alqoritm) ──
function generateDynamicPin(secret, tw) {
  const str = String(secret) + String(tw);
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = Math.imul(31, hash) + str.charCodeAt(i) | 0;
  }
  hash ^= (hash << 13);
  hash ^= (hash >>> 17);
  hash ^= (hash << 5);
  return (Math.abs(Math.imul(hash, 1664525) + 1013904223) % 10000)
    .toString().padStart(4, '0');
}

// ── Smen məntiqi ─────────────────────────────────────────────────
const TIME_STEP = 10000;

function getShiftGroup(dept) {
  return (dept === 'Ağ Şəhər' || dept === 'Gənclik') ? 'A' : 'B';
}

const SHIFT_TABLE = {
  A: {
    sehersm:     { startH:7,  startM:30, durH:9,  lateH:7,  lateM:30, label:'Səhər (07:30-16:30)'       },
    axsamsm:     { startH:16, startM:0,  durH:9,  lateH:16, lateM:0,  label:'Axşam (16:00-01:00)'       },
    fullsm:      { startH:14, startM:0,  durH:11, lateH:14, lateM:0,  label:'Axşam Full (14:00-01:00)'  },
    seherfullsm: { startH:7,  startM:30, durH:11, lateH:7,  lateM:30, label:'Səhər Full (07:30-18:30)'  },
  },
  B: {
    sehersm:     { startH:7,  startM:30, durH:8,  lateH:7,  lateM:30, label:'Səhər (07:30-15:30)'       },
    axsamsm:     { startH:15, startM:0,  durH:8,  lateH:15, lateM:0,  label:'Axşam (15:00-23:00)'       },
    fullsm:      { startH:13, startM:0,  durH:10, lateH:13, lateM:0,  label:'Axşam Full (13:00-23:00)'  },
    seherfullsm: { startH:7,  startM:30, durH:10, lateH:7,  lateM:30, label:'Səhər Full (07:30-17:30)'  },
  },
};

function getShiftInfo(dept, shiftType) {
  if (!shiftType || shiftType === 'istirahetsm' || shiftType === '') return null;
  const g = getShiftGroup(dept);
  return (SHIFT_TABLE[g] && SHIFT_TABLE[g][shiftType]) || null;
}

// Fallback gecikmə yoxlaması (cədvəl olmayan günlər üçün)
function isLate(dept, dateObj) {
  const h = dateObj.getHours();
  let tot = h * 60 + dateObj.getMinutes();
  if (h < 3) tot += 24 * 60;
  const lim = (h >= 3 && h < 13)
    ? 7 * 60 + 30
    : (dept === 'Gənclik' || dept === 'Ağ Şəhər') ? 16 * 60 : 15 * 60;
  return tot > lim;
}

// ── Cədvəl & İzin köməkçiləri ────────────────────────────────────
function getEmployeeShift(empId, dateStr) {
  const row = db.prepare(
    'SELECT shiftType FROM cedvel WHERE empId=? AND dateStr=?'
  ).get(String(empId), dateStr);
  return row ? row.shiftType || null : null;
}

function hasApprovedLeave(empId, dateStr) {
  const rows = db.prepare(
    "SELECT startDate,endDate FROM izin WHERE empId=? AND status='approved'"
  ).all(String(empId));
  return rows.some(r => dateStr >= r.startDate && dateStr <= r.endDate);
}

function getApprovedLatePerm(empId, dateStr) {
  return db.prepare(
    "SELECT requestedTime FROM latePerms WHERE empId=? AND dateStr=? AND status='approved'"
  ).get(String(empId), dateStr) || null;
}

// ── Şöbə / slug çevrimlər ────────────────────────────────────────
function deptToSlug(dept) {
  const m = { 'Elmlər':'elmler','Sahil':'sahil','Gənclik':'genclik','Ağ Şəhər':'agseher' };
  return m[dept] || '';
}
function slugToDept(slug) {
  const m = { elmler:'Elmlər', sahil:'Sahil', genclik:'Gənclik', agseher:'Ağ Şəhər' };
  return m[slug] || '';
}
function deptToIpKey(dept) { return deptToSlug(dept); }

// ── Parametr oxuma ────────────────────────────────────────────────
function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? row.value : '';
}
function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(key, String(value));
}

// ── Telegram göndərmə ─────────────────────────────────────────────
function getTelegramSettings() {
  return {
    enabled:      getSetting('TG_ENABLED') === 'true',
    token:        getSetting('TG_TOKEN'),
    adminChat:    getSetting('TG_ADMIN_CHAT'),
    chatElmler:   getSetting('TG_CHAT_Elmler'),
    chatSahil:    getSetting('TG_CHAT_Sahil'),
    chatGenclik:  getSetting('TG_CHAT_Genclik'),
    chatAgSeher:  getSetting('TG_CHAT_AgSeher'),
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

// ── Filial açarları ───────────────────────────────────────────────
const SLUGS = ['elmler', 'sahil', 'genclik', 'agseher'];

function getBranchScheduleKeys() {
  const result = {};
  for (const slug of SLUGS) {
    let k = getSetting('SCHED_KEY_' + slug);
    if (!k) {
      k = 'SK' + Math.random().toString(36).substring(2, 10).toUpperCase();
      setSetting('SCHED_KEY_' + slug, k);
    }
    result[slugToDept(slug)] = k;
  }
  return result;
}

function validateBranchScheduleKey(key) {
  for (const slug of SLUGS) {
    if (getSetting('SCHED_KEY_' + slug) === key) {
      return { valid: true, dept: slugToDept(slug) };
    }
  }
  return { valid: false };
}

// ── WiFi IP yoxlaması ─────────────────────────────────────────────
function checkWifiIp(dept, clientIp) {
  const key = deptToIpKey(dept);
  if (!key) return { ok: true };
  const reg = getSetting('IP_' + key);
  if (!reg) return { ok: false, reason: 'Bu filial üçün WiFi IP hələ qeydə alınmayıb.' };
  if (!clientIp) return { ok: true };
  const allowed = reg.split(',').map(s => s.trim());
  if (allowed.some(a => a && clientIp.indexOf(a) === 0)) return { ok: true };
  return { ok: false, reason: 'Filial WiFi-ına qoşulmamısınız!' };
}

// ── Streak hesablaması ────────────────────────────────────────────
function calcStreak(empId, dept) {
  const logs = db.prepare(
    "SELECT timestamp FROM attendance WHERE empId=? AND type='GƏLİŞ' ORDER BY timestamp DESC"
  ).all(String(empId));

  let streak = 0;
  for (const row of logs) {
    const d = new Date(row.timestamp);
    if (isNaN(d.getTime())) continue;
    const dateStr = getLogicalYMD(d);
    const h = d.getHours(), m = d.getMinutes();
    const tot = h * 60 + m;
    const st = getEmployeeShift(empId, dateStr);
    const si = st ? getShiftInfo(dept, st) : null;
    const lim = si ? (si.lateH * 60 + si.lateM)
      : (h < 13 ? 7 * 60 + 30
        : (dept === 'Ağ Şəhər' || dept === 'Gənclik') ? 16 * 60 : 15 * 60);
    if (tot <= lim) streak++;
    else break;
  }
  return streak;
}

module.exports = {
  cacheSet, cacheGet, cacheDelete,
  toYMD, fmtTime, getLogicalYMD, getLogicalDateStr, getMondayYMD, getDayShort,
  generateDynamicPin, TIME_STEP,
  getShiftGroup, getShiftInfo, isLate, SHIFT_TABLE,
  getEmployeeShift, hasApprovedLeave, getApprovedLatePerm,
  deptToSlug, slugToDept, deptToIpKey,
  getSetting, setSetting,
  getTelegramSettings, sendTelegramMsg,
  deptChatId,
  getBranchScheduleKeys, validateBranchScheduleKey,
  checkWifiIp, calcStreak,
};
