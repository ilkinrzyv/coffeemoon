'use strict';
require('dotenv').config();
const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const { initialize, db } = require('./db');
const U        = require('./utils');

const app       = express();
const PORT      = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'moC7O5F2F6E3E8on';

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ══════════════════════════════════════════════════════════════════
//  SƏHIFƏ MARŞRUTLARI (Page Routes)
// ══════════════════════════════════════════════════════════════════

function readTemplate(name) {
  return fs.readFileSync(path.join(__dirname, 'public', name), 'utf8');
}
function replaceVars(html, vars) {
  return Object.entries(vars).reduce(
    (h, [k, v]) => h.replace(new RegExp(`<\\?= ${k} \\?>`, 'g'), v),
    html
  );
}

// Scan səhifəsi (cihaz skan terminali)
app.get('/scan', (req, res) => {
  res.send(readTemplate('passpage.html'));
});

// İşçi kartı
app.get('/mycode', (req, res) => {
  const { secret = '', name = 'İşçi' } = req.query;
  res.send(replaceVars(readTemplate('mycode.html'), {
    secret,
    empName: name,
  }));
});

// Köməkçi çeklist səhifəsi
app.get('/checklist', (req, res) => {
  const { key = '' } = req.query;
  const check = U.validateBranchScheduleKey(key);
  if (!check.valid) return res.send('<h2 style="color:red;font-family:sans-serif;padding:2rem">İcazəsiz giriş.</h2>');
  res.send(replaceVars(readTemplate('checklist.html'), {
    branchKey: key,
    dept:      check.dept,
    scriptUrl: `${req.protocol}://${req.get('host')}`,
  }));
});

// Menecer paneli
app.get('/manager', (req, res) => {
  const { key = '' } = req.query;
  const check = U.validateBranchScheduleKey(key);
  if (!check.valid) return res.send('<h2 style="color:red;font-family:sans-serif;padding:2rem">İcazəsiz giriş.</h2>');
  res.send(replaceVars(readTemplate('manager.html'), {
    branchKey: key,
    dept:      check.dept,
    scriptUrl: `${req.protocol}://${req.get('host')}`,
  }));
});

// Admin paneli
app.get('/admin', (req, res) => {
  const { key = '' } = req.query;
  if (key !== ADMIN_KEY) return res.send('<h2 style="color:red;font-family:sans-serif;padding:2rem">İcazə yoxdur.</h2>');
  res.send(replaceVars(readTemplate('admin.html'), {
    adminKey:  ADMIN_KEY,
    scriptUrl: `${req.protocol}://${req.get('host')}`,
  }));
});

// Köklü URL → admin yönləndirmə
app.get('/', (req, res) => res.redirect(`/admin?key=${ADMIN_KEY}`));

// ══════════════════════════════════════════════════════════════════
//  API MARŞRUT KEÇİDİ
// ══════════════════════════════════════════════════════════════════

// Bütün API çağırışları {args:[...]} ilə POST /api/:fn-ə gəlir
app.post('/api/:fn', async (req, res) => {
  const fn   = req.params.fn;
  const args = Array.isArray(req.body?.args) ? req.body.args : [];
  try {
    const handler = API[fn];
    if (!handler) return res.status(404).json({ error: 'Funksiya tapılmadı: ' + fn });
    const result = await handler(...args);
    res.json(result);
  } catch (e) {
    console.error(`[API] ${fn}:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════
//  API FUNKSİYALARI
// ══════════════════════════════════════════════════════════════════
const API = {};

// ── İŞÇİLƏR ─────────────────────────────────────────────────────

API.getEmployees = () => {
  const emps = db.prepare('SELECT * FROM employees ORDER BY name').all();
  return emps.map(emp => ({
    id:      emp.id,
    name:    emp.name,
    dept:    emp.dept,
    secret:  emp.secret,
    message: emp.message || '',
    streak:  U.calcStreak(emp.id, emp.dept),
  })).sort((a, b) => b.streak - a.streak);
};

API.addEmployee = (name, dept) => {
  if (!name || !dept) return { success: false, reason: 'Ad və Filial tələb olunur.' };
  const id     = 'E' + Date.now().toString(36).toUpperCase().slice(-5);
  const secret = Math.random().toString(36).substring(2, 10).toUpperCase();
  db.prepare('INSERT INTO employees (id,name,dept,secret) VALUES (?,?,?,?)').run(id, name, dept, secret);
  return { success: true };
};

API.removeEmployee = (id) => {
  const r = db.prepare('DELETE FROM employees WHERE id=?').run(id);
  return { success: r.changes > 0 };
};

API.updateEmployeeMessage = (id, msg) => {
  const r = db.prepare('UPDATE employees SET message=? WHERE id=?').run(msg || '', id);
  return { success: r.changes > 0 };
};

API.bindDevice = (secret, deviceId) => {
  if (!secret) return { success: false, reason: 'Xətalı link!' };
  const emp = db.prepare('SELECT * FROM employees WHERE secret=?').get(secret);
  if (!emp) return { success: false, reason: 'İşçi tapılmadı.' };
  if (!emp.deviceId) {
    db.prepare('UPDATE employees SET deviceId=? WHERE secret=?').run(deviceId, secret);
  }
  return { success: true, message: emp.message || '' };
};

API.resetDevice = (id) => {
  const r = db.prepare("UPDATE employees SET deviceId='' WHERE id=?").run(id);
  return { success: r.changes > 0 };
};

// ── SCAN CİHAZLAR ────────────────────────────────────────────────

API.checkScanDevice = async (deviceId) => {
  if (!deviceId) return { allowed: false, pending: false, reason: 'Cihaz ID tapılmadı.' };
  const dev = db.prepare('SELECT * FROM scanDevices WHERE deviceId=?').get(deviceId);
  if (dev) {
    if (dev.status === 'active')  return { allowed: true, branch: dev.branch, label: dev.label };
    if (dev.status === 'pending') return { allowed: false, pending: true, reason: 'Cihazınız admin tərəfindən hələ təsdiqlənməyib.' };
    if (dev.status === 'blocked') return { allowed: false, pending: false, reason: 'Bu cihaz admin tərəfindən bloklanıb.' };
  }
  db.prepare("INSERT OR IGNORE INTO scanDevices (deviceId,status) VALUES (?,'pending')").run(deviceId);
  await U.sendTelegramMsg(`☕ <b>Coffeemoon</b>\n\n📱 <b>Yeni Scan Cihazı qeydə alındı</b>\nAdmin panelindən təsdiqləyin.\n\n🔑 <code>${deviceId}</code>`, null);
  return { allowed: false, pending: true, reason: 'Cihazınız qeydə alındı. Admin təsdiqini gözləyin.' };
};

API.getScanDevices = () => {
  return db.prepare('SELECT * FROM scanDevices ORDER BY createdAt DESC').all().map(d => ({
    id:        d.deviceId,
    branch:    d.branch || '',
    status:    d.status || 'pending',
    createdAt: d.createdAt || '',
    label:     d.label || '',
  }));
};

API.approveScanDevice = (deviceId, branch, label) => {
  const exists = db.prepare('SELECT 1 FROM scanDevices WHERE deviceId=?').get(deviceId);
  if (exists) {
    db.prepare("UPDATE scanDevices SET branch=?,status='active',label=? WHERE deviceId=?")
      .run(branch, label || branch, deviceId);
  } else {
    db.prepare("INSERT INTO scanDevices (deviceId,branch,status,label) VALUES (?,'active',?,?)")
      .run(deviceId, branch, label || branch);
  }
  return { success: true };
};

API.blockScanDevice = (deviceId) => {
  const r = db.prepare("UPDATE scanDevices SET status='blocked' WHERE deviceId=?").run(deviceId);
  return { success: r.changes > 0 };
};

API.removeScanDevice = (deviceId) => {
  const r = db.prepare('DELETE FROM scanDevices WHERE deviceId=?').run(deviceId);
  return { success: r.changes > 0 };
};

// ── CƏDVƏL ───────────────────────────────────────────────────────

API.getCedvel = (dept, weekStart) => {
  const start = new Date(weekStart);
  const dates = [];
  for (let d = 0; d < 7; d++) {
    const dd = new Date(start.getTime() + d * 86400000);
    dates.push(U.toYMD(dd));
  }
  const emps = db.prepare('SELECT * FROM employees WHERE dept=? ORDER BY name').all(dept);
  const rows = db.prepare(
    `SELECT empId,dateStr,shiftType FROM cedvel WHERE dept=? AND dateStr IN (${dates.map(() => '?').join(',')})`
  ).all(dept, ...dates);

  const map = {};
  for (const r of rows) {
    if (!map[r.empId]) map[r.empId] = {};
    map[r.empId][r.dateStr] = r.shiftType;
  }
  return emps.map(e => ({
    empId:   e.id,
    empName: e.name,
    dept:    e.dept,
    schedule: dates.map(ds => ({ date: ds, shiftType: (map[e.id] && map[e.id][ds]) || '' })),
  }));
};

API.saveCedvel = (entries) => {
  if (!entries || !entries.length) return { success: true };
  const empIdSet = {}, dateSet = {};
  entries.forEach(e => { if (e.empId) empIdSet[String(e.empId)] = 1; if (e.dateStr) dateSet[e.dateStr] = 1; });

  // Mövcud sırları sil
  const empIds = Object.keys(empIdSet);
  const dateSl = Object.keys(dateSet);
  if (empIds.length && dateSl.length) {
    db.prepare(
      `DELETE FROM cedvel WHERE empId IN (${empIds.map(() => '?').join(',')}) AND dateStr IN (${dateSl.map(() => '?').join(',')})`
    ).run(...empIds, ...dateSl);
  }

  // Yalnız dolu smenləri əlavə et
  const ins = db.prepare('INSERT INTO cedvel (cedvelId,empId,empName,dept,dateStr,shiftType) VALUES (?,?,?,?,?,?)');
  const many = db.transaction((rows) => {
    for (const entry of rows) {
      if (!entry.empId || !entry.dateStr || !entry.shiftType) continue;
      const nid = 'C' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 1000).toString(36).toUpperCase();
      ins.run(nid, entry.empId, entry.empName, entry.dept, entry.dateStr, entry.shiftType);
    }
  });
  many(entries);
  return { success: true };
};

API.getBranchScheduleKeys = () => U.getBranchScheduleKeys();
API.validateBranchScheduleKey = (key) => U.validateBranchScheduleKey(key);

API.getCedvelForManager = (key, weekStart) => {
  const c = U.validateBranchScheduleKey(key);
  if (!c.valid) return null;
  return API.getCedvel(c.dept, weekStart);
};

API.saveCedvelForManager = (key, entries) => {
  const c = U.validateBranchScheduleKey(key);
  if (!c.valid) return { success: false, reason: 'İcazəsiz.' };
  return API.saveCedvel(entries);
};

// ── İZİN ─────────────────────────────────────────────────────────

API.getIzinList = () => {
  return db.prepare('SELECT * FROM izin ORDER BY createdAt DESC').all().map(r => ({
    id:        r.izinId,
    empId:     r.empId,
    empName:   r.empName,
    dept:      r.dept,
    startDate: r.startDate,
    endDate:   r.endDate,
    type:      r.type || '',
    note:      r.note || '',
    status:    r.status || '',
    createdAt: r.createdAt || '',
  }));
};

API.addIzin = (data) => {
  const id = 'I' + Date.now().toString(36).toUpperCase().slice(-6);
  db.prepare('INSERT INTO izin (izinId,empId,empName,dept,startDate,endDate,type,note,status) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, data.empId, data.empName, data.dept, data.startDate, data.endDate, data.type || 'İzin', data.note || '', 'pending');
  return { success: true };
};

API.updateIzinStatus = (izinId, status) => {
  const r = db.prepare('UPDATE izin SET status=? WHERE izinId=?').run(status, izinId);
  return { success: r.changes > 0 };
};

API.removeIzin = (izinId) => {
  const r = db.prepare('DELETE FROM izin WHERE izinId=?').run(izinId);
  return { success: r.changes > 0 };
};

// ── HESABAT & XƏBƏRDARLIQ ────────────────────────────────────────

API.getMonthlyReport = (year, month) => {
  const emps = db.prepare('SELECT * FROM employees').all();
  return emps.map(emp => {
    const logs = db.prepare(
      "SELECT * FROM attendance WHERE empId=? AND strftime('%Y',timestamp)=? AND strftime('%m',timestamp)=?"
    ).all(String(emp.id), String(year), String(month).padStart(2, '0'));

    const gelisLogs = logs.filter(r => r.type === 'GƏLİŞ');
    const cixisLogs = logs.filter(r => r.type === 'CIXIS');
    let lateCount = 0, onTime = 0, totalHours = 0;

    for (const r of gelisLogs) {
      const d = new Date(r.timestamp);
      const ds = U.getLogicalYMD(d);
      const st = U.getEmployeeShift(emp.id, ds);
      const si = st ? U.getShiftInfo(emp.dept, st) : null;
      const late = si
        ? (d.getHours() * 60 + d.getMinutes()) > (si.lateH * 60 + si.lateM)
        : U.isLate(emp.dept, d);
      if (late) lateCount++; else onTime++;
    }
    for (const r of cixisLogs) {
      const ds = U.getLogicalYMD(new Date(r.timestamp));
      const st = U.getEmployeeShift(emp.id, ds);
      const si = st ? U.getShiftInfo(emp.dept, st) : null;
      const dur = si ? si.durH : ((emp.dept === 'Ağ Şəhər' || emp.dept === 'Gənclik') ? 9 : 8);
      const ot = r.overtime || '';
      const sign = ot.startsWith('+') ? 1 : ot.startsWith('-') ? -1 : 0;
      const m = ot.match(/(\d+)\s*saat\s*(\d+)/);
      totalHours += m ? dur + sign * (parseInt(m[1]) + parseInt(m[2]) / 60) : dur;
    }
    const total = gelisLogs.length;
    return {
      empId:      emp.id,
      empName:    emp.name,
      dept:       emp.dept,
      totalDays:  total,
      onTime,
      late:       lateCount,
      pct:        total > 0 ? Math.round(onTime / total * 100) : 0,
      totalHours: Math.round(totalHours * 10) / 10,
    };
  }).sort((a, b) => b.pct - a.pct);
};

API.getWarnings = () => {
  const emps = db.prepare('SELECT * FROM employees').all();
  const now = new Date();
  const dow = now.getDay();
  const monday = new Date(now.getTime() - (dow === 0 ? 6 : dow - 1) * 86400000);
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday.getTime() + 6 * 86400000);
  sunday.setHours(23, 59, 59, 999);
  const mStr = monday.toISOString().slice(0, 10);
  const sStr = sunday.toISOString().slice(0, 10);

  const warnings = [];
  for (const emp of emps) {
    const logs = db.prepare(
      "SELECT * FROM attendance WHERE empId=? AND type='GƏLİŞ' AND date(timestamp)>=? AND date(timestamp)<=?"
    ).all(String(emp.id), mStr, sStr);
    let late = 0;
    for (const r of logs) {
      const d = new Date(r.timestamp);
      const ds = U.getLogicalYMD(d);
      const st = U.getEmployeeShift(emp.id, ds);
      const si = st ? U.getShiftInfo(emp.dept, st) : null;
      const isL = si
        ? (d.getHours() * 60 + d.getMinutes()) > (si.lateH * 60 + si.lateM)
        : U.isLate(emp.dept, d);
      if (isL) late++;
    }
    if (late >= 3) warnings.push({ empId: emp.id, empName: emp.name, dept: emp.dept, lateCount: late });
  }
  return warnings.sort((a, b) => b.lateCount - a.lateCount);
};

// ── DAVAMIYYƏT LOGu ───────────────────────────────────────────────

API.validateAndLog = async (enteredPin, clientIp, _forceMode) => {
  if (!enteredPin) return { valid: false, reason: 'Kod daxil edilməyib' };
  const emps = db.prepare('SELECT * FROM employees').all();
  const cW   = Math.floor(Date.now() / U.TIME_STEP);
  let matched = null;
  for (const emp of emps) {
    if (
      enteredPin === U.generateDynamicPin(emp.secret, cW) ||
      enteredPin === U.generateDynamicPin(emp.secret, cW - 1)
    ) { matched = emp; break; }
  }
  if (!matched) return { valid: false, reason: 'Yanlış və ya vaxtı keçmiş kod!' };

  // Passpage cihazının WiFi yoxlaması
  const wc = U.checkWifiIp(matched.dept, clientIp || '');
  if (!wc.ok) return { valid: false, reason: wc.reason };

  // İşçinin telefon IP yoxlaması
  const empIp = U.cacheGet('EMP_IP_' + matched.secret);
  if (empIp === null) return { valid: false, reason: 'Mobil kartınız açıq deyil. Əvvəlcə kartı açın.' };
  const empWc = U.checkWifiIp(matched.dept, empIp || '');
  if (!empWc.ok) return { valid: false, reason: 'Telefonunuz filial WiFi-ına qoşulmayıb!' };

  const ts       = new Date();
  const todayStr = U.getLogicalDateStr(ts);
  const todayYMD = U.getLogicalYMD(ts);

  const todayShift = U.getEmployeeShift(matched.id, todayYMD);
  if (todayShift === 'istirahetsm') return { valid: false, reason: 'Bu gün sizin istirahət gününüzdür!' };
  if (U.hasApprovedLeave(matched.id, todayYMD)) return { valid: false, reason: 'Bu gün üçün təsdiq edilmiş izniniz var.' };

  const todayLogs = db.prepare(
    'SELECT * FROM attendance WHERE empId=? ORDER BY timestamp'
  ).all(String(matched.id)).filter(r => U.getLogicalDateStr(new Date(r.timestamp)) === todayStr);

  const shiftInfo = todayShift ? U.getShiftInfo(matched.dept, todayShift) : null;

  if (todayLogs.length === 0) {
    // GƏLİŞ
    const nowMins = ts.getHours() * 60 + ts.getMinutes() +
      (ts.getHours() < 3 && shiftInfo && shiftInfo.startH >= 12 ? 24 * 60 : 0);
    let late = shiftInfo
      ? nowMins > (shiftInfo.lateH * 60 + shiftInfo.lateM)
      : U.isLate(matched.dept, ts);
    if (late) {
      const perm = U.getApprovedLatePerm(matched.id, todayYMD);
      if (perm) {
        const [ph, pm] = perm.requestedTime.split(':').map(Number);
        if ((ts.getHours() * 60 + ts.getMinutes()) <= ph * 60 + pm + 5) late = false;
      }
    }
    const lateStr = late
      ? `\n⚠️ <b>GECİKMƏ!</b>${shiftInfo ? ` (limit: ${String(shiftInfo.lateH).padStart(2,'0')}:${String(shiftInfo.lateM).padStart(2,'0')})` : ''}`
      : '\n✅ Vaxtında';
    db.prepare('INSERT INTO attendance (empId,empName,dept,timestamp,type,overtime,shiftType) VALUES (?,?,?,?,?,?,?)')
      .run(matched.id, matched.name, matched.dept, ts.toISOString(), 'GƏLİŞ', '', todayShift || '');
    await U.sendTelegramMsg(`<b>Smendə</b>\n <b>${matched.name}</b>\n ${lateStr}\n ${U.fmtTime(ts)}`, matched.dept);
    return { valid: true, empName: matched.name, dept: matched.dept, type: 'GƏLİŞ', overtime: '' };

  } else if (todayLogs.length === 1) {
    // CIXIS
    const reqH = shiftInfo ? shiftInfo.durH : ((matched.dept === 'Ağ Şəhər' || matched.dept === 'Gənclik') ? 9 : 8);
    const diffMs  = ts.getTime() - new Date(todayLogs[0].timestamp).getTime() - reqH * 3600000;
    const absMs   = Math.abs(diffMs);
    const dh = Math.floor(absMs / 3600000), dm = Math.floor((absMs % 3600000) / 60000);
    const overtimeStr = (dh === 0 && dm === 0) ? 'Tam vaxtında'
      : `${diffMs >= 0 ? '+' : '-'}${dh} saat ${dm} dəq`;
    db.prepare('INSERT INTO attendance (empId,empName,dept,timestamp,type,overtime,shiftType) VALUES (?,?,?,?,?,?,?)')
      .run(matched.id, matched.name, matched.dept, ts.toISOString(), 'CIXIS', overtimeStr, todayShift || '');
    const otE = diffMs > 0 ? '🟢' : diffMs < 0 ? '🔴' : '⚪';
    await U.sendTelegramMsg(`<b>Smen bitdi</b>\n <b>${matched.name}</b>\n ${U.fmtTime(ts)}\n${otE} Fərq: <b>${overtimeStr}</b>`, matched.dept);
    return { valid: true, empName: matched.name, dept: matched.dept, type: 'CIXIS', overtime: overtimeStr };

  } else {
    return { valid: false, reason: 'Bu gün üçün artıq qeyd var' };
  }
};

API.getOnlineEmployees = () => {
  const todayStr = U.getLogicalDateStr(new Date());
  const all = db.prepare('SELECT * FROM attendance ORDER BY timestamp').all();
  const empMap = {};
  for (const row of all) {
    if (!row.empId || !row.timestamp) continue;
    if (String(row.empId).startsWith('MGR-')) continue;
    const rd = new Date(row.timestamp);
    if (isNaN(rd.getTime())) continue;
    if (U.getLogicalDateStr(rd) !== todayStr) continue;
    if (!empMap[row.empId]) empMap[row.empId] = { name: row.empName, dept: row.dept, gelis: null, cixis: false };
    if (row.type === 'GƏLİŞ') empMap[row.empId].gelis = rd;
    if (row.type === 'CIXIS') empMap[row.empId].cixis = true;
  }
  return Object.values(empMap)
    .filter(e => e.gelis && !e.cixis)
    .map(e => ({ name: e.name, dept: e.dept, checkInTime: U.fmtTime(e.gelis), checkInMs: e.gelis.getTime() }))
    .sort((a, b) => a.checkInMs - b.checkInMs);
};

API.registerEmployeeSession = (secret, clientIp) => {
  if (!secret) return { ok: false };
  U.cacheSet('EMP_IP_' + secret, clientIp || '', 1800);
  return { ok: true };
};

// ── DASHBOARD ─────────────────────────────────────────────────────

API.getDashboardData = async (secret) => {
  const emp = db.prepare('SELECT * FROM employees WHERE secret=?').get(secret);
  if (!emp) return null;

  const now = new Date();
  const monday = new Date(now.getTime() - ((now.getDay() === 0 ? 6 : now.getDay() - 1) * 86400000));
  monday.setHours(0, 0, 0, 0);
  const DAY_NAMES = ['B.e.','Ç.a.','Çər.','C.a.','Cüm.','Şən.','Baz.'];

  const allDeptSched = API.getCedvel(emp.dept, U.toYMD(monday));

  const weekSchedule = [];
  for (let d = 0; d < 7; d++) {
    const dd  = new Date(monday.getTime() + d * 86400000);
    const ds  = U.toYMD(dd);
    const st  = U.getEmployeeShift(emp.id, ds);
    const si  = st ? U.getShiftInfo(emp.dept, st) : null;
    const dayIdx = dd.getDay() === 0 ? 6 : dd.getDay() - 1;
    const myGroup = (st === 'axsamsm' || st === 'fullsm') ? 'evening' : 'morning';
    const colleagues = [];
    if (st && st !== 'istirahetsm') {
      for (const other of allDeptSched) {
        if (other.empId === emp.id) continue;
        const od = other.schedule[d];
        if (!od || !od.shiftType || od.shiftType === 'istirahetsm') continue;
        const tg = (od.shiftType === 'axsamsm' || od.shiftType === 'fullsm') ? 'evening' : 'morning';
        if (tg === myGroup) colleagues.push(other.empName.split(' ')[0]);
      }
    }
    weekSchedule.push({ date: ds, dayName: DAY_NAMES[dayIdx], shiftType: st || '', label: si ? si.label : st === 'istirahetsm' ? 'İstirahət' : '-', isToday: U.toYMD(now) === ds, colleagues });
  }

  const nextMonday = new Date(monday.getTime() + 7 * 86400000);
  const allDeptSchedNext = API.getCedvel(emp.dept, U.toYMD(nextMonday));
  const nextWeekSchedule = [];
  for (let nd = 0; nd < 7; nd++) {
    const ndd = new Date(nextMonday.getTime() + nd * 86400000);
    const nds = U.toYMD(ndd);
    const nst = U.getEmployeeShift(emp.id, nds);
    const nsi = nst ? U.getShiftInfo(emp.dept, nst) : null;
    const nDayIdx = ndd.getDay() === 0 ? 6 : ndd.getDay() - 1;
    const nMyGroup = (nst === 'axsamsm' || nst === 'fullsm') ? 'evening' : 'morning';
    const nColleagues = [];
    if (nst && nst !== 'istirahetsm') {
      for (const other of allDeptSchedNext) {
        if (other.empId === emp.id) continue;
        const od = other.schedule[nd];
        if (!od || !od.shiftType || od.shiftType === 'istirahetsm') continue;
        const tg = (od.shiftType === 'axsamsm' || od.shiftType === 'fullsm') ? 'evening' : 'morning';
        if (tg === nMyGroup) nColleagues.push(other.empName.split(' ')[0]);
      }
    }
    nextWeekSchedule.push({ date: nds, dayName: DAY_NAMES[nDayIdx], shiftType: nst || '', label: nsi ? nsi.label : nst === 'istirahetsm' ? 'İstirahət' : '-', isToday: false, colleagues: nColleagues });
  }

  const mon = now.getMonth() + 1, yr = now.getFullYear();
  const report = await API.getMonthlyReport(yr, mon);
  const myR = report.find(r => r.empId === emp.id) || { totalDays: 0, onTime: 0, late: 0, pct: 0 };
  return {
    streak:            U.calcStreak(emp.id, emp.dept),
    dept:              emp.dept,
    weekSchedule,
    nextWeekSchedule,
    monthStats:        { days: myR.totalDays, onTime: myR.onTime, late: myR.late, pct: myR.pct },
    announcements:     await API.getAnnouncements(),
  };
};

// ── NAHAR ────────────────────────────────────────────────────────

API.logLunch = async (enteredPin, clientIp, lunchType) => {
  if (!enteredPin) return { valid: false, reason: 'Kod daxil edilməyib' };
  if (lunchType !== 'NAHAR_GET' && lunchType !== 'NAHAR_QAY') return { valid: false, reason: 'Yanlış nahar növü' };

  const emps = db.prepare('SELECT * FROM employees').all();
  const cW   = Math.floor(Date.now() / U.TIME_STEP);
  let matched = null;
  for (const emp of emps) {
    if (enteredPin === U.generateDynamicPin(emp.secret, cW) ||
        enteredPin === U.generateDynamicPin(emp.secret, cW - 1)) { matched = emp; break; }
  }
  if (!matched) return { valid: false, reason: 'Yanlış və ya vaxtı keçmiş kod!' };
  if (clientIp) {
    const wc = U.checkWifiIp(matched.dept, clientIp);
    if (!wc.ok) return { valid: false, reason: wc.reason };
  }

  const ts       = new Date();
  const todayStr = U.getLogicalDateStr(ts);

  const attLogs = db.prepare('SELECT * FROM attendance WHERE empId=?').all(String(matched.id));
  const hasTodayGelis = attLogs.some(r => U.getLogicalDateStr(new Date(r.timestamp)) === todayStr && r.type === 'GƏLİŞ');
  const hasTodayCixis = attLogs.some(r => U.getLogicalDateStr(new Date(r.timestamp)) === todayStr && r.type === 'CIXIS');
  if (!hasTodayGelis) return { valid: false, reason: 'Əvvəlcə giriş qeydə alınmalıdır!' };
  if (hasTodayCixis)  return { valid: false, reason: 'Artıq smen çıxışı qeydə alınıb!' };

  const naharLogs = db.prepare('SELECT * FROM nahar WHERE empId=?').all(String(matched.id))
    .filter(r => U.getLogicalDateStr(new Date(r.timestamp)) === todayStr);
  const naharGet = naharLogs.filter(r => r.type === 'NAHAR_GET');
  const naharQay = naharLogs.filter(r => r.type === 'NAHAR_QAY');

  if (lunchType === 'NAHAR_GET') {
    if (naharGet.length > 0) return { valid: false, reason: 'Artıq nahara çıxmısınız!' };
    const id = 'NH-' + Date.now().toString(36).toUpperCase();
    db.prepare('INSERT INTO nahar (naharId,empId,empName,dept,timestamp,type) VALUES (?,?,?,?,?,?)')
      .run(id, matched.id, matched.name, matched.dept, ts.toISOString(), 'NAHAR_GET');
    await U.sendTelegramMsg(`<b>${matched.name}</b>\n<b>Naharda</b>\n${U.fmtTime(ts)}`, matched.dept);
    return { valid: true, empName: matched.name, dept: matched.dept, type: 'NAHAR_GET' };
  }

  if (naharGet.length === 0) return { valid: false, reason: 'Əvvəlcə nahara çıxış qeydə alınmalıdır!' };
  if (naharQay.length > 0)   return { valid: false, reason: 'Nahardan qayıdışınız artıq qeydə alınıb!' };
  const getTs   = new Date(naharGet[0].timestamp);
  const diffMin = Math.round((ts.getTime() - getTs.getTime()) / 60000);
  const id2 = 'NH-' + Date.now().toString(36).toUpperCase();
  db.prepare('INSERT INTO nahar (naharId,empId,empName,dept,timestamp,type) VALUES (?,?,?,?,?,?)')
    .run(id2, matched.id, matched.name, matched.dept, ts.toISOString(), 'NAHAR_QAY');
  await U.sendTelegramMsg(`<b>${matched.name}</b>\n<b>Nahar bitdi</b>\n${U.fmtTime(ts)}\nNahar müddəti: <b>${diffMin} dəq</b>`, matched.dept);
  return { valid: true, empName: matched.name, dept: matched.dept, type: 'NAHAR_QAY', duration: diffMin };
};

// ── MENECER DAVAMİYYƏTİ ──────────────────────────────────────────

API.logManagerCheckin = async (branchKey, type) => {
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return { valid: false, reason: 'İcazəsiz giriş.' };
  const dept    = check.dept;
  const MGR_ID  = 'MGR-' + dept.replace(/\s+/g, '');
  const mgrName = 'Menecer (' + dept + ')';
  const ts      = new Date();
  const todayStr = U.getLogicalDateStr(ts);

  const todayLogs = db.prepare('SELECT * FROM attendance WHERE empId=?').all(MGR_ID)
    .filter(r => U.getLogicalDateStr(new Date(r.timestamp)) === todayStr);

  if (type === 'GELIS') {
    if (todayLogs.some(r => r.type === 'GELIS' || r.type === 'GƏLİŞ')) return { valid: false, reason: 'Giriş artıq qeydə alınıb!' };
    db.prepare('INSERT INTO attendance (empId,empName,dept,timestamp,type,overtime,shiftType) VALUES (?,?,?,?,?,?,?)')
      .run(MGR_ID, mgrName, dept, ts.toISOString(), 'GELIS', '', '');
    await U.sendTelegramMsg(`<b>Menecer işdə</b>\n${U.fmtTime(ts)}`, dept);
    return { valid: true, type: 'GELIS', time: U.fmtTime(ts) };
  }
  if (type === 'CIXIS') {
    const gelisRow = todayLogs.find(r => r.type === 'GELIS' || r.type === 'GƏLİŞ');
    if (!gelisRow) return { valid: false, reason: 'Əvvəlcə giriş qeydə alınmalıdır!' };
    if (todayLogs.some(r => r.type === 'CIXIS')) return { valid: false, reason: 'Çıxış artıq qeydə alınıb!' };
    const diffMs = ts.getTime() - new Date(gelisRow.timestamp).getTime();
    const dh = Math.floor(diffMs / 3600000), dm = Math.floor((diffMs % 3600000) / 60000);
    const dur = `${dh} saat ${dm} dəq`;
    db.prepare('INSERT INTO attendance (empId,empName,dept,timestamp,type,overtime,shiftType) VALUES (?,?,?,?,?,?,?)')
      .run(MGR_ID, mgrName, dept, ts.toISOString(), 'CIXIS', dur, '');
    await U.sendTelegramMsg(`<b>Menecer Çıxdı</b>\n${U.fmtTime(ts)}\nİş müddəti: <b>${dur}</b>`, dept);
    return { valid: true, type: 'CIXIS', time: U.fmtTime(ts), duration: dur };
  }
  return { valid: false, reason: 'Yanlış əməliyyat.' };
};

API.getManagersLiveStatus = () => {
  const todayStr = U.getLogicalDateStr(new Date());
  const DEPTS    = ['Elmlər','Sahil','Gənclik','Ağ Şəhər'];
  const result   = {};
  for (const dept of DEPTS) {
    const slug    = U.deptToSlug(dept);
    const mgrId   = 'MGR-' + dept.replace(/\s+/g, '');
    const logs    = db.prepare('SELECT * FROM attendance WHERE empId=? ORDER BY timestamp').all(mgrId)
      .filter(r => U.getLogicalDateStr(new Date(r.timestamp)) === todayStr);
    let gelisDate = null, cixisDate = null;
    for (const r of logs) {
      const rd = new Date(r.timestamp);
      if (r.type === 'GELIS' || r.type === 'GƏLİŞ') gelisDate = rd;
      if (r.type === 'CIXIS') cixisDate = rd;
    }
    result[dept] = {
      mgrName:  U.getSetting('MGR_NAME_' + slug) || `Menecer · ${dept}`,
      gelis:    gelisDate ? U.fmtTime(gelisDate) : null,
      gelisMs:  gelisDate ? gelisDate.getTime() : null,
      cixis:    cixisDate ? U.fmtTime(cixisDate) : null,
      isOnline: !!(gelisDate && !cixisDate),
      hadGelis: !!gelisDate,
    };
  }
  return result;
};

// ── MENECER İNFO & MESAJLAR ──────────────────────────────────────

const MGR_SLUGS = ['elmler','sahil','genclik','agseher'];

API.getMgrInfo = () => {
  const result = { names: {}, globalMsg: '', msgs: {} };
  result.globalMsg = U.getSetting('MGR_GLOBAL_MSG');
  for (const slug of MGR_SLUGS) {
    result.names[slug] = U.getSetting('MGR_NAME_' + slug);
    result.msgs[slug]  = U.getSetting('MGR_MSG_'  + slug);
  }
  return result;
};

API.saveMgrInfo = (data) => {
  if (data.globalMsg !== undefined) U.setSetting('MGR_GLOBAL_MSG', data.globalMsg || '');
  for (const slug of MGR_SLUGS) {
    if (data.names?.[slug] !== undefined) U.setSetting('MGR_NAME_' + slug, data.names[slug] || '');
    if (data.msgs?.[slug]  !== undefined) U.setSetting('MGR_MSG_'  + slug, data.msgs[slug]  || '');
  }
  return { success: true };
};

API.getMgrInfoForBranch = (branchKey) => {
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return null;
  const slug = U.deptToSlug(check.dept);
  return {
    dept:      check.dept,
    mgrName:   U.getSetting('MGR_NAME_' + slug),
    globalMsg: U.getSetting('MGR_GLOBAL_MSG'),
    branchMsg: U.getSetting('MGR_MSG_' + slug),
  };
};

// ── TELEGRAM ─────────────────────────────────────────────────────

API.getTelegramSettings = () => U.getTelegramSettings();

API.saveTelegramSettings = (data) => {
  U.setSetting('TG_TOKEN',       data.token      || '');
  U.setSetting('TG_ADMIN_CHAT',  data.adminChat  || '');
  U.setSetting('TG_ENABLED',     data.enabled ? 'true' : 'false');
  U.setSetting('TG_CHAT_Elmler', data.chatElmler  || '');
  U.setSetting('TG_CHAT_Sahil',  data.chatSahil   || '');
  U.setSetting('TG_CHAT_Genclik',data.chatGenclik || '');
  U.setSetting('TG_CHAT_AgSeher',data.chatAgSeher || '');
  return { success: true };
};

API.testTelegram = async () => {
  const cfg = U.getTelegramSettings();
  if (!cfg.token)     return { success: false, reason: 'Token boşdur.' };
  if (!cfg.adminChat) return { success: false, reason: 'Chat ID boşdur.' };
  try {
    const r = await fetch(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.adminChat, text: '☕ <b>Coffeemoon</b>\n\n✅ Telegram bağlantısı uğurla quruldu!', parse_mode: 'HTML' }),
    });
    const d = await r.json();
    return d.ok ? { success: true } : { success: false, reason: d.description };
  } catch (e) { return { success: false, reason: e.toString() }; }
};

// ── WiFi IP ──────────────────────────────────────────────────────

API.getBranchIPs = () => ({
  elmler:  U.getSetting('IP_elmler'),
  sahil:   U.getSetting('IP_sahil'),
  genclik: U.getSetting('IP_genclik'),
  agseher: U.getSetting('IP_agseher'),
});

API.saveBranchIPs = (data) => {
  U.setSetting('IP_elmler',  data.elmler  || '');
  U.setSetting('IP_sahil',   data.sahil   || '');
  U.setSetting('IP_genclik', data.genclik || '');
  U.setSetting('IP_agseher', data.agseher || '');
  return { success: true };
};

// ── ÇEKLİST ─────────────────────────────────────────────────────

API.getChecklistItems = () => {
  return db.prepare('SELECT * FROM checklistItems ORDER BY sortOrder').all().map(r => ({
    itemId:    r.itemId,
    text:      r.text,
    category:  r.category,
    sortOrder: r.sortOrder,
    active:    r.active === 1,
  }));
};

API.saveChecklistItems = (items) => {
  db.prepare('DELETE FROM checklistItems').run();
  const ins = db.prepare('INSERT INTO checklistItems (itemId,text,category,sortOrder,active) VALUES (?,?,?,?,?)');
  const many = db.transaction(rows => rows.forEach((item, i) => ins.run(item.itemId, item.text, item.category, i + 1, item.active ? 1 : 0)));
  many(items);
  return { success: true };
};

API.getChecklistForBranch = (branchKey) => {
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return { valid: false, reason: 'İcazəsiz giriş.' };
  const dept  = check.dept;
  const today = U.toYMD(new Date());
  const items = db.prepare("SELECT * FROM checklistItems WHERE active=1 ORDER BY sortOrder").all();
  const logs  = db.prepare('SELECT * FROM checklistLogs WHERE date=? AND dept=?').all(today, dept);
  const logMap = {};
  for (const r of logs) {
    logMap[r.itemId] = { checked: r.checked === 1, checkedAt: r.checkedAt || '', mgrNote: r.mgrNote || '', adminNote: r.adminNote || '' };
  }
  items.forEach(item => {
    const log = logMap[item.itemId] || {};
    item.checked   = log.checked   || false;
    item.checkedAt = log.checkedAt || '';
    item.mgrNote   = log.mgrNote   || '';
    item.adminNote = log.adminNote || '';
    item.active    = item.active === 1;
  });
  return { valid: true, dept, date: today, items };
};

API.submitChecklistItem = (branchKey, itemId, checked, mgrNote) => {
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return { valid: false, reason: 'İcazəsiz giriş.' };
  const dept  = check.dept;
  const today = U.toYMD(new Date());
  const ts    = new Date();
  const existing = db.prepare('SELECT logId FROM checklistLogs WHERE date=? AND dept=? AND itemId=?').get(today, dept, String(itemId));
  if (existing) {
    db.prepare('UPDATE checklistLogs SET checked=?,checkedAt=?,mgrNote=? WHERE logId=?')
      .run(checked ? 1 : 0, checked ? U.fmtTime(ts) : '', mgrNote || '', existing.logId);
  } else {
    const itemText = (db.prepare('SELECT text FROM checklistItems WHERE itemId=?').get(String(itemId)) || {}).text || '';
    const logId = 'CL-' + Date.now().toString(36).toUpperCase();
    db.prepare('INSERT INTO checklistLogs (logId,date,dept,itemId,itemText,checked,checkedAt,mgrNote,adminNote) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(logId, today, dept, itemId, itemText, checked ? 1 : 0, checked ? U.fmtTime(ts) : '', mgrNote || '', '');
  }
  return { valid: true, checkedAt: checked ? U.fmtTime(ts) : '' };
};

API.getChecklistReport = (dateStr) => {
  const date  = dateStr || U.toYMD(new Date());
  const items = db.prepare("SELECT * FROM checklistItems WHERE active=1 ORDER BY sortOrder").all().map(r => ({ ...r, active: r.active === 1 }));
  const DEPTS = ['Ağ Şəhər','Gənclik','Elmlər','Sahil'];
  const report = {};
  for (const dept of DEPTS) {
    report[dept] = {};
    for (const item of items) report[dept][item.itemId] = { checked: false, checkedAt: '', mgrNote: '', adminNote: '' };
  }
  const logs = db.prepare('SELECT * FROM checklistLogs WHERE date=?').all(date);
  for (const r of logs) {
    if (report[r.dept] && report[r.dept][r.itemId] !== undefined) {
      report[r.dept][r.itemId] = { checked: r.checked === 1, checkedAt: r.checkedAt || '', mgrNote: r.mgrNote || '', adminNote: r.adminNote || '' };
    }
  }
  return { date, items, report };
};

API.saveAdminNote = (dateStr, dept, itemId, adminNote) => {
  const date = dateStr || U.toYMD(new Date());
  const existing = db.prepare('SELECT logId FROM checklistLogs WHERE date=? AND dept=? AND itemId=?').get(date, dept, String(itemId));
  if (existing) {
    db.prepare('UPDATE checklistLogs SET adminNote=? WHERE logId=?').run(adminNote || '', existing.logId);
  } else {
    const itemText = (db.prepare('SELECT text FROM checklistItems WHERE itemId=?').get(String(itemId)) || {}).text || '';
    const logId = 'CL-' + Date.now().toString(36).toUpperCase();
    db.prepare('INSERT INTO checklistLogs (logId,date,dept,itemId,itemText,checked,checkedAt,mgrNote,adminNote) VALUES (?,?,?,?,?,0,"","",?)')
      .run(logId, date, dept, itemId, itemText, adminNote || '');
  }
  return { success: true };
};

// ── MENECER TƏSDİQ SİSTEMİ ───────────────────────────────────────

API.getMgrAckStatus = (branchKey) => {
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return null;
  const today = U.toYMD(new Date());
  const row = db.prepare('SELECT * FROM mgrAcks WHERE date=? AND dept=?').get(today, check.dept);
  if (!row) return { globalAcked: false, globalAckedAt: '', branchAcked: false, branchAckedAt: '' };
  return { globalAcked: row.globalAcked === 1, globalAckedAt: row.globalAckedAt || '', branchAcked: row.branchAcked === 1, branchAckedAt: row.branchAckedAt || '' };
};

API.ackMgrMessage = (branchKey, msgType) => {
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return { success: false };
  const dept  = check.dept;
  const today = U.toYMD(new Date());
  const ts    = U.fmtTime(new Date());
  const existing = db.prepare('SELECT ackId FROM mgrAcks WHERE date=? AND dept=?').get(today, dept);
  if (existing) {
    if (msgType === 'global') db.prepare('UPDATE mgrAcks SET globalAcked=1,globalAckedAt=? WHERE ackId=?').run(ts, existing.ackId);
    else                      db.prepare('UPDATE mgrAcks SET branchAcked=1,branchAckedAt=? WHERE ackId=?').run(ts, existing.ackId);
  } else {
    const ackId = 'ACK-' + Date.now().toString(36).toUpperCase();
    const g = msgType === 'global' ? 1 : 0, gT = msgType === 'global' ? ts : '';
    const b = msgType === 'branch' ? 1 : 0, bT = msgType === 'branch' ? ts : '';
    db.prepare('INSERT INTO mgrAcks (ackId,date,dept,globalAcked,globalAckedAt,branchAcked,branchAckedAt) VALUES (?,?,?,?,?,?,?)')
      .run(ackId, today, dept, g, gT, b, bT);
  }
  return { success: true, time: ts };
};

API.getMgrAcksForAdmin = (dateStr) => {
  const date  = dateStr || U.toYMD(new Date());
  const DEPTS = ['Ağ Şəhər','Gənclik','Elmlər','Sahil'];
  const result = {};
  for (const d of DEPTS) result[d] = { globalAcked: false, globalAckedAt: '', branchAcked: false, branchAckedAt: '' };
  const rows = db.prepare('SELECT * FROM mgrAcks WHERE date=?').all(date);
  for (const r of rows) {
    if (!result[r.dept]) continue;
    result[r.dept] = { globalAcked: r.globalAcked === 1, globalAckedAt: r.globalAckedAt || '', branchAcked: r.branchAcked === 1, branchAckedAt: r.branchAckedAt || '' };
  }
  return { date, acks: result };
};

// ── TULLANTI / MƏHSULLAR ─────────────────────────────────────────

const WASTE_LIMITS = { 'Gənclik': 2.5, 'Ağ Şəhər': 3.0, 'Elmlər': 3.5, 'Sahil': 4.0 };
function getWasteLimit(dept) { return WASTE_LIMITS[dept] ?? 3.0; }

API.getProducts = () => {
  return db.prepare("SELECT * FROM products WHERE active=1 ORDER BY name").all().map(p => ({
    productId: p.productId, name: p.name, unit: p.unit,
  }));
};

API.addProduct = (name, unit) => {
  if (!name?.trim()) return { success: false, reason: 'Ad boş ola bilməz.' };
  const id = 'PRD-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substring(2, 4).toUpperCase();
  db.prepare('INSERT INTO products (productId,name,unit,active) VALUES (?,?,?,1)').run(id, name.trim(), unit || 'ədəd');
  return { success: true, productId: id };
};

API.deleteProduct = (productId) => {
  const r = db.prepare('UPDATE products SET active=0 WHERE productId=?').run(productId);
  return r.changes > 0 ? { success: true } : { success: false, reason: 'Tapılmadı.' };
};

API.getProductLogsForBranch = (branchKey, monthStr) => {
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return { valid: false, reason: 'İcazəsiz.' };
  const dept     = check.dept;
  const products = API.getProducts();
  const logs     = db.prepare("SELECT * FROM productLogs WHERE dept=? AND substr(dateStr,1,7)=?").all(dept, monthStr);
  const totals   = {};
  for (const r of logs) {
    if (!totals[r.productId]) totals[r.productId] = { incoming: 0, wasted: 0 };
    totals[r.productId].incoming += r.incoming || 0;
    totals[r.productId].wasted   += r.wasted   || 0;
  }
  let totalIn = 0, totalWasted = 0;
  const items = products.map(p => {
    const t = totals[p.productId] || { incoming: 0, wasted: 0 };
    totalIn     += t.incoming;
    totalWasted += t.wasted;
    return { ...p, totalIncoming: t.incoming, totalWasted: t.wasted };
  });
  const limit = getWasteLimit(dept);
  const pct   = totalIn > 0 ? Math.round(totalWasted / totalIn * 1000) / 10 : 0;
  return { valid: true, dept, monthStr, items, limit, totalIn, totalWasted, pct, exceeded: totalIn > 0 && pct > limit };
};

API.saveProductLogs = (branchKey, monthStr, logs) => {
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return { valid: false, reason: 'İcazəsiz.' };
  const dept    = check.dept;
  const todayYMD = U.toYMD(new Date());
  const ins = db.prepare('INSERT INTO productLogs (logId,dateStr,dept,productId,productName,incoming,wasted) VALUES (?,?,?,?,?,?,?)');
  const many = db.transaction(rows => {
    for (const log of rows) {
      if (!log.productId) continue;
      const inc = Number(log.incoming) || 0, wst = Number(log.wasted) || 0;
      if (inc === 0 && wst === 0) continue;
      const logId = 'PL-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substring(2, 4).toUpperCase();
      ins.run(logId, todayYMD, dept, log.productId, log.name || '', inc, wst);
    }
  });
  many(logs);
  const allLogs = db.prepare("SELECT * FROM productLogs WHERE dept=? AND substr(dateStr,1,7)=?").all(dept, monthStr);
  let totalIn = 0, totalWasted = 0;
  for (const r of allLogs) { totalIn += r.incoming || 0; totalWasted += r.wasted || 0; }
  const limit = getWasteLimit(dept);
  const pct   = totalIn > 0 ? Math.round(totalWasted / totalIn * 1000) / 10 : 0;
  return { valid: true, pct, limit, exceeded: totalIn > 0 && pct > limit, totalIn, totalWasted };
};

API.getWasteStatsForAdmin = (dateStr) => {
  const DEPTS  = ['Elmlər','Sahil','Gənclik','Ağ Şəhər'];
  const deptMap = {};
  for (const d of DEPTS) deptMap[d] = { dept: d, totalIn: 0, totalWasted: 0, products: [], limit: getWasteLimit(d) };
  const logs = db.prepare("SELECT * FROM productLogs WHERE substr(dateStr,1,7)=?").all(dateStr);
  for (const r of logs) {
    if (!deptMap[r.dept]) continue;
    if (!r.incoming && !r.wasted) continue;
    deptMap[r.dept].totalIn     += r.incoming || 0;
    deptMap[r.dept].totalWasted += r.wasted   || 0;
    deptMap[r.dept].products.push({ name: r.productName, incoming: r.incoming || 0, wasted: r.wasted || 0 });
  }
  return DEPTS.map(d => {
    const s   = deptMap[d];
    const pct = s.totalIn > 0 ? Math.round(s.totalWasted / s.totalIn * 1000) / 10 : 0;
    return { dept: s.dept, totalIn: s.totalIn, totalWasted: s.totalWasted, pct, limit: s.limit, exceeded: s.totalIn > 0 && pct > s.limit, hasData: s.totalIn > 0 || s.totalWasted > 0, products: s.products };
  });
};

// ── MENECER HƏFTƏLIK QRAFİK ───────────────────────────────────────

API.getMgrWeekSchedule = (branchKey, weekStart) => {
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return null;
  const dept  = check.dept;
  const start = new Date(weekStart);
  const dates = [];
  for (let d = 0; d < 7; d++) dates.push(U.toYMD(new Date(start.getTime() + d * 86400000)));
  const rows = db.prepare(`SELECT dateStr,shiftType FROM mgrSchedule WHERE dept=? AND dateStr IN (${dates.map(() => '?').join(',')})`).all(dept, ...dates);
  const map = {};
  for (const r of rows) map[r.dateStr] = r.shiftType;
  return { dept, schedule: dates.map(ds => ({ date: ds, shiftType: map[ds] || '' })) };
};

API.saveMgrWeekSchedule = (branchKey, entries) => {
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return { success: false, reason: 'İcazəsiz.' };
  const dept  = check.dept;
  const dates = entries.map(e => e.dateStr).filter(Boolean);
  if (dates.length) {
    db.prepare(`DELETE FROM mgrSchedule WHERE dept=? AND dateStr IN (${dates.map(() => '?').join(',')})`).run(dept, ...dates);
  }
  const ins = db.prepare('INSERT INTO mgrSchedule (schedId,dept,dateStr,shiftType) VALUES (?,?,?,?)');
  const many = db.transaction(rows => {
    for (const e of rows) {
      if (!e.dateStr || !e.shiftType) continue;
      const sid = 'MS-' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 1000).toString(36).toUpperCase();
      ins.run(sid, dept, e.dateStr, e.shiftType);
    }
  });
  many(entries);
  return { success: true };
};

API.getMgrScheduleForAdmin = (weekStart) => {
  const DEPTS = ['Ağ Şəhər','Gənclik','Elmlər','Sahil'];
  const start = new Date(weekStart);
  const dates = [];
  for (let d = 0; d < 7; d++) dates.push(U.toYMD(new Date(start.getTime() + d * 86400000)));
  const rows = db.prepare(`SELECT dept,dateStr,shiftType FROM mgrSchedule WHERE dateStr IN (${dates.map(() => '?').join(',')})`).all(...dates);
  const map = {};
  for (const dept of DEPTS) map[dept] = {};
  for (const r of rows) { if (map[r.dept]) map[r.dept][r.dateStr] = r.shiftType; }
  const DAY_NAMES = ['B.e.','Ç.a.','Çər.','C.a.','Cüm.','Şən.','Baz.'];
  return {
    dates: dates.map(ds => { const dd = new Date(ds); return { date: ds, dayName: DAY_NAMES[dd.getDay() === 0 ? 6 : dd.getDay() - 1] }; }),
    managers: DEPTS.map(dept => {
      const slug = U.deptToSlug(dept);
      return { dept, mgrName: U.getSetting('MGR_NAME_' + slug) || dept, schedule: dates.map(ds => map[dept][ds] || '') };
    }),
  };
};

// ── GEC GƏLİŞ İCAZƏSİ ────────────────────────────────────────────

API.requestLatePerm = (secret, dateStr, requestedTime) => {
  if (!secret || !dateStr || !requestedTime) return { success: false, reason: 'Məlumatlar natamamdır.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr))  return { success: false, reason: 'Tarix formatı yanlışdır.' };
  if (!/^\d{2}:\d{2}$/.test(requestedTime))   return { success: false, reason: 'Vaxt formatı yanlışdır.' };
  const emp = db.prepare('SELECT * FROM employees WHERE secret=?').get(secret);
  if (!emp) return { success: false, reason: 'İşçi tapılmadı.' };
  const existing = db.prepare("SELECT status FROM latePerms WHERE empId=? AND dateStr=?").get(String(emp.id), dateStr);
  if (existing && (existing.status === 'pending' || existing.status === 'approved')) {
    return { success: false, reason: 'Bu tarix üçün artıq icazəniz mövcuddur.' };
  }
  const permId = 'LP-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substring(2, 5).toUpperCase();
  db.prepare('INSERT INTO latePerms (permId,empId,empName,dept,dateStr,requestedTime,status) VALUES (?,?,?,?,?,?,?)')
    .run(permId, emp.id, emp.name, emp.dept, dateStr, requestedTime, 'pending');
  return { success: true, permId };
};

API.getLatePermsForManager = (branchKey) => {
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return [];
  const today = U.toYMD(new Date());
  return db.prepare("SELECT * FROM latePerms WHERE dept=? ORDER BY createdAt DESC LIMIT 30").all(check.dept)
    .map(r => ({ permId: r.permId, empId: r.empId, empName: r.empName, dept: r.dept, dateStr: r.dateStr, requestedTime: r.requestedTime, status: r.status, createdAt: r.createdAt }))
    .sort((a, b) => {
      if (a.status === 'pending' && b.status !== 'pending') return -1;
      if (a.status !== 'pending' && b.status === 'pending') return 1;
      return b.dateStr.localeCompare(a.dateStr);
    });
};

API.approveLatePerm = (branchKey, permId, action) => {
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return { success: false, reason: 'İcazəsiz.' };
  if (action !== 'approved' && action !== 'rejected') return { success: false, reason: 'Yanlış əməliyyat.' };
  const r = db.prepare("UPDATE latePerms SET status=?,approvedAt=datetime('now','localtime') WHERE permId=? AND dept=?")
    .run(action, permId, check.dept);
  return r.changes > 0 ? { success: true } : { success: false, reason: 'Tapılmadı.' };
};

API.getMyLatePerms = (secret) => {
  if (!secret) return [];
  const emp = db.prepare('SELECT * FROM employees WHERE secret=?').get(secret);
  if (!emp) return [];
  const today = U.toYMD(new Date());
  return db.prepare("SELECT * FROM latePerms WHERE empId=? AND dateStr>=? ORDER BY dateStr LIMIT 5").all(String(emp.id), today)
    .map(r => ({ permId: r.permId, dateStr: r.dateStr, requestedTime: r.requestedTime, status: r.status }));
};

// ── YENİLİKLƏR ───────────────────────────────────────────────────

API.getAnnouncements = () => {
  return db.prepare('SELECT * FROM announcements ORDER BY pinned DESC, date DESC').all().map(r => ({
    id:     r.id,
    title:  r.title,
    body:   r.body,
    type:   r.type || 'info',
    pinned: r.pinned === 1,
    date:   r.date ? r.date.slice(0, 10).split('-').reverse().join('.') : '',
  }));
};

API.saveAnnouncement = (data) => {
  if (data.id) {
    const r = db.prepare('UPDATE announcements SET title=?,body=?,type=?,pinned=? WHERE id=?')
      .run(data.title, data.body, data.type || 'info', data.pinned ? 1 : 0, data.id);
    if (r.changes > 0) return { ok: true };
  }
  const newId = 'YN-' + Date.now().toString(36).toUpperCase();
  db.prepare('INSERT INTO announcements (id,title,body,type,pinned) VALUES (?,?,?,?,?)')
    .run(newId, data.title, data.body, data.type || 'info', data.pinned ? 1 : 0);
  return { ok: true, id: newId };
};

API.deleteAnnouncement = (id) => {
  const r = db.prepare('DELETE FROM announcements WHERE id=?').run(id);
  return r.changes > 0 ? { ok: true } : { ok: false };
};

// ── MENECER DASHBOARDu (tək sorğu ilə hər şey) ───────────────────

API.getManagerDashboard = async (branchKey, weekStart) => {
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return null;
  const [cedvel, mgrInfo, ackStatus, mgrSched, latePerms] = await Promise.all([
    Promise.resolve(API.getCedvel(check.dept, weekStart)),
    Promise.resolve(API.getMgrInfoForBranch(branchKey)),
    Promise.resolve(API.getMgrAckStatus(branchKey)),
    Promise.resolve(API.getMgrWeekSchedule(branchKey, weekStart)),
    Promise.resolve(API.getLatePermsForManager(branchKey)),
  ]);
  return { cedvel, mgrInfo, ackStatus, mgrSched, latePerms };
};

// ══════════════════════════════════════════════════════════════════
//  SERVER BAŞLAT (async — DB init gözlənilir)
// ══════════════════════════════════════════════════════════════════

(async () => {
  try {
    await initialize();
    console.log('✅  Verilənlər bazası hazırdır');
    app.listen(PORT, () => {
      console.log(`☕  Coffeemoon server http://localhost:${PORT} ünvanında işləyir`);
      console.log(`🔑  Admin paneli: http://localhost:${PORT}/admin?key=${ADMIN_KEY}`);
      const keys = U.getBranchScheduleKeys();
      for (const [dept, key] of Object.entries(keys)) {
        console.log(`🏪  ${dept}: http://localhost:${PORT}/manager?key=${key}`);
      }
    });
  } catch (e) {
    console.error('Başlama xətası:', e);
    process.exit(1);
  }
})();
