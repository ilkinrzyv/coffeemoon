'use strict';
require('dotenv').config();
const express = require('express');
const path    = require('path');
const fs      = require('fs');
const sb      = require('./db');
const U       = require('./utils');

const app       = express();
const PORT      = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'coffeemoon';

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ══════════════════════════════════════════════════════════════════
//  SƏHIFƏ MARŞRUTLARI
// ══════════════════════════════════════════════════════════════════

function readTemplate(name) {
  return fs.readFileSync(path.join(__dirname, 'public', name), 'utf8');
}
function replaceVars(html, vars) {
  return Object.entries(vars).reduce(
    (h, [k, v]) => h.replace(new RegExp(`<\\?= ${k} \\?>`, 'g'), v), html
  );
}

app.get('/scan',  (_, res) => res.send(readTemplate('passpage.html')));

app.get('/mycode', (req, res) => {
  const { secret = '', name = 'İşçi' } = req.query;
  res.send(replaceVars(readTemplate('mycode.html'), { secret, empName: name }));
});

app.get('/checklist', (req, res) => {
  const { key = '' } = req.query;
  const check = U.validateBranchScheduleKey(key);
  if (!check.valid) return res.send('<h2 style="color:red;font-family:sans-serif;padding:2rem">İcazəsiz giriş.</h2>');
  res.send(replaceVars(readTemplate('checklist.html'), {
    branchKey: key, dept: check.dept,
    scriptUrl: `${req.protocol}://${req.get('host')}`,
  }));
});

app.get('/manager', (req, res) => {
  const { key = '' } = req.query;
  const check = U.validateBranchScheduleKey(key);
  if (!check.valid) return res.send('<h2 style="color:red;font-family:sans-serif;padding:2rem">İcazəsiz giriş.</h2>');
  res.send(replaceVars(readTemplate('manager.html'), {
    branchKey: key, dept: check.dept,
    scriptUrl: `${req.protocol}://${req.get('host')}`,
  }));
});

app.get('/admin', (req, res) => {
  if (req.query.key !== ADMIN_KEY)
    return res.send('<h2 style="color:red;font-family:sans-serif;padding:2rem">İcazə yoxdur.</h2>');
  res.send(replaceVars(readTemplate('admin.html'), {
    adminKey:  ADMIN_KEY,
    scriptUrl: `${req.protocol}://${req.get('host')}`,
  }));
});

app.get('/', (req, res) => res.redirect(`/admin?key=${ADMIN_KEY}`));

// ══════════════════════════════════════════════════════════════════
//  API MARŞRUTU
// ══════════════════════════════════════════════════════════════════

app.post('/api/:fn', async (req, res) => {
  const fn   = req.params.fn;
  const args = Array.isArray(req.body?.args) ? req.body.args : [];
  try {
    const handler = API[fn];
    if (!handler) return res.status(404).json({ error: 'Funksiya tapılmadı: ' + fn });
    const result = await handler(...args);
    res.json(result ?? null);
  } catch (e) {
    console.error(`[API] ${fn}:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════
//  KÖMƏKÇI
// ══════════════════════════════════════════════════════════════════

function sbErr(label, error) {
  if (error) console.error(`[SB] ${label}:`, error.message);
}

// ══════════════════════════════════════════════════════════════════
//  API FUNKSİYALARI
// ══════════════════════════════════════════════════════════════════
const API = {};

// ── İŞÇİLƏR ─────────────────────────────────────────────────────

API.getEmployees = async () => {
  const { data, error } = await sb.from('employees').select('*').order('name');
  sbErr('getEmployees', error);
  const emps = data || [];
  const result = await Promise.all(emps.map(async emp => ({
    id:      emp.id,
    name:    emp.name,
    dept:    emp.dept,
    secret:  emp.secret,
    message: emp.message || '',
    streak:  await U.calcStreak(emp.id, emp.dept),
  })));
  return result.sort((a, b) => b.streak - a.streak);
};

API.addEmployee = async (name, dept) => {
  if (!name || !dept) return { success: false, reason: 'Ad və Filial tələb olunur.' };
  const id     = 'E' + Date.now().toString(36).toUpperCase().slice(-5);
  const secret = Math.random().toString(36).substring(2, 10).toUpperCase();
  const { error } = await sb.from('employees').insert({ id, name, dept, secret });
  sbErr('addEmployee', error);
  return { success: !error };
};

API.removeEmployee = async (id) => {
  const { error } = await sb.from('employees').delete().eq('id', id);
  return { success: !error };
};

API.updateEmployeeMessage = async (id, msg) => {
  const { error } = await sb.from('employees').update({ message: msg || '' }).eq('id', id);
  return { success: !error };
};

API.bindDevice = async (secret, deviceId) => {
  if (!secret) return { success: false, reason: 'Xətalı link!' };
  const { data: emp } = await sb.from('employees').select('*').eq('secret', secret).single();
  if (!emp) return { success: false, reason: 'İşçi tapılmadı.' };

  if (!emp.deviceId) {
    await sb.from('employees').update({ deviceId }).eq('secret', secret);
    return { success: true, message: emp.message || '' };
  }

  if (emp.deviceId !== deviceId) {
    return {
      success: false,
      reason: 'Bu kart başqa cihazda qeydiyyatlıdır. Dəyişdirmək üçün adminə müraciət edin.',
      deviceLocked: true,
    };
  }

  return { success: true, message: emp.message || '' };
};

API.resetDevice = async (id) => {
  const { error } = await sb.from('employees').update({ deviceId: '' }).eq('id', id);
  return { success: !error };
};

// ── SCAN CİHAZLAR ────────────────────────────────────────────────

API.checkScanDevice = async (deviceId) => {
  if (!deviceId) return { allowed: false, pending: false, reason: 'Cihaz ID tapılmadı.' };
  const { data: dev } = await sb.from('scanDevices').select('*').eq('deviceId', deviceId).single();
  if (dev) {
    if (dev.status === 'active')  return { allowed: true, branch: dev.branch, label: dev.label };
    if (dev.status === 'pending') return { allowed: false, pending: true, reason: 'Cihazınız admin tərəfindən hələ təsdiqlənməyib.' };
    if (dev.status === 'blocked') return { allowed: false, pending: false, reason: 'Bu cihaz admin tərəfindən bloklanıb.' };
  }
  await sb.from('scanDevices').upsert({ deviceId, status: 'pending' }, { onConflict: 'deviceId' });
  await U.sendTelegramMsg(`☕ <b>Coffeemoon</b>\n\n📱 <b>Yeni Scan Cihazı qeydə alındı</b>\n\n🔑 <code>${deviceId}</code>`, null);
  return { allowed: false, pending: true, reason: 'Cihazınız qeydə alındı. Admin təsdiqini gözləyin.' };
};

API.getScanDevices = async () => {
  const { data } = await sb.from('scanDevices').select('*').order('createdAt', { ascending: false });
  return (data || []).map(d => ({
    id: d.deviceId, branch: d.branch || '', status: d.status || 'pending',
    createdAt: d.createdAt || '', label: d.label || '',
  }));
};

API.approveScanDevice = async (deviceId, branch, label) => {
  const { error } = await sb.from('scanDevices')
    .upsert({ deviceId, branch, status: 'active', label: label || branch }, { onConflict: 'deviceId' });
  return { success: !error };
};

API.blockScanDevice = async (deviceId) => {
  const { error } = await sb.from('scanDevices').update({ status: 'blocked' }).eq('deviceId', deviceId);
  return { success: !error };
};

API.removeScanDevice = async (deviceId) => {
  const { error } = await sb.from('scanDevices').delete().eq('deviceId', deviceId);
  return { success: !error };
};

// ── CƏDVƏL ───────────────────────────────────────────────────────

API.getCedvel = async (dept, weekStart) => {
  const start = new Date(weekStart);
  const dates = [];
  for (let d = 0; d < 7; d++) {
    const dd = new Date(start.getTime() + d * 86400000);
    dates.push(U.toYMD(dd));
  }
  const { data: emps } = await sb.from('employees').select('*').eq('dept', dept).order('name');
  const { data: rows } = await sb.from('cedvel').select('*').eq('dept', dept).in('dateStr', dates);
  const map = {};
  for (const r of rows || []) {
    if (!map[r.empId]) map[r.empId] = {};
    map[r.empId][r.dateStr] = r.shiftType;
  }
  return (emps || []).map(e => ({
    empId: e.id, empName: e.name, dept: e.dept,
    schedule: dates.map(ds => ({ date: ds, shiftType: (map[e.id]?.[ds]) || '' })),
  }));
};

API.saveCedvel = async (entries) => {
  if (!entries?.length) return { success: true };
  const empIds = [...new Set(entries.map(e => String(e.empId)).filter(Boolean))];
  const dates  = [...new Set(entries.map(e => e.dateStr).filter(Boolean))];
  if (empIds.length && dates.length) {
    await sb.from('cedvel').delete().in('empId', empIds).in('dateStr', dates);
  }
  const toInsert = entries
    .filter(e => e.empId && e.dateStr && e.shiftType)
    .map(e => ({
      cedvelId:  'C' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random()*1000).toString(36).toUpperCase(),
      empId:     e.empId, empName: e.empName, dept: e.dept,
      dateStr:   e.dateStr, shiftType: e.shiftType,
    }));
  if (toInsert.length) await sb.from('cedvel').insert(toInsert);
  return { success: true };
};

API.getBranchScheduleKeys = async () => U.getBranchScheduleKeys();
API.validateBranchScheduleKey = (key) => U.validateBranchScheduleKey(key);

API.getCedvelForManager = async (key, weekStart) => {
  const c = U.validateBranchScheduleKey(key);
  if (!c.valid) return null;
  return API.getCedvel(c.dept, weekStart);
};

API.saveCedvelForManager = async (key, entries) => {
  const c = U.validateBranchScheduleKey(key);
  if (!c.valid) return { success: false, reason: 'İcazəsiz.' };
  return API.saveCedvel(entries);
};

// ── İZİN ─────────────────────────────────────────────────────────

API.getIzinList = async () => {
  const { data } = await sb.from('izin').select('*').order('createdAt', { ascending: false });
  return (data || []).map(r => ({
    id: r.izinId, empId: r.empId, empName: r.empName, dept: r.dept,
    startDate: r.startDate, endDate: r.endDate,
    type: r.type || '', note: r.note || '', status: r.status || '',
    createdAt: r.createdAt || '',
  }));
};

API.addIzin = async (data) => {
  const id = 'I' + Date.now().toString(36).toUpperCase().slice(-6);
  const { error } = await sb.from('izin').insert({
    izinId: id, empId: data.empId, empName: data.empName, dept: data.dept,
    startDate: data.startDate, endDate: data.endDate,
    type: data.type || 'İzin', note: data.note || '', status: 'pending',
  });
  return { success: !error };
};

API.updateIzinStatus = async (izinId, status) => {
  const { error } = await sb.from('izin').update({ status }).eq('izinId', izinId);
  return { success: !error };
};

API.removeIzin = async (izinId) => {
  const { error } = await sb.from('izin').delete().eq('izinId', izinId);
  return { success: !error };
};

// ── HESABAT ───────────────────────────────────────────────────────

API.getMonthlyReport = async (year, month) => {
  const { data: emps } = await sb.from('employees').select('*');
  const m = String(month).padStart(2, '0');
  const { data: logs } = await sb.from('attendance').select('*')
    .gte('timestamp', `${year}-${m}-01`)
    .lt('timestamp', month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`);

  return (emps || []).map(emp => {
    const myLogs    = (logs || []).filter(r => r.empId === emp.id);
    const gelisLogs = myLogs.filter(r => r.type === 'GƏLİŞ');
    const cixisLogs = myLogs.filter(r => r.type === 'CIXIS');
    let lateCount = 0, onTime = 0, totalHours = 0;
    for (const r of gelisLogs) {
      const d = new Date(r.timestamp);
      const si = r.shiftType ? U.getShiftInfo(emp.dept, r.shiftType) : null;
      const late = si
        ? (d.getHours() * 60 + d.getMinutes()) > (si.lateH * 60 + si.lateM)
        : U.isLate(emp.dept, d);
      if (late) lateCount++; else onTime++;
    }
    for (const r of cixisLogs) {
      const si  = r.shiftType ? U.getShiftInfo(emp.dept, r.shiftType) : null;
      const dur = si ? si.durH : ((emp.dept === 'Ağ Şəhər' || emp.dept === 'Gənclik') ? 9 : 8);
      const ot  = r.overtime || '';
      const sign = ot.startsWith('+') ? 1 : ot.startsWith('-') ? -1 : 0;
      const mt   = ot.match(/(\d+)\s*saat\s*(\d+)/);
      totalHours += mt ? dur + sign * (parseInt(mt[1]) + parseInt(mt[2]) / 60) : dur;
    }
    const total = gelisLogs.length;
    return { empId: emp.id, empName: emp.name, dept: emp.dept, totalDays: total, onTime,
      late: lateCount, pct: total > 0 ? Math.round(onTime / total * 100) : 0,
      totalHours: Math.round(totalHours * 10) / 10 };
  }).sort((a, b) => b.pct - a.pct);
};

API.getWarnings = async () => {
  const { data: emps } = await sb.from('employees').select('*');
  const now    = new Date();
  const dow    = now.getDay();
  const monday = new Date(now.getTime() - (dow === 0 ? 6 : dow - 1) * 86400000);
  monday.setHours(0, 0, 0, 0);
  const { data: logs } = await sb.from('attendance').select('*')
    .eq('type', 'GƏLİŞ').gte('timestamp', monday.toISOString());
  const warnings = [];
  for (const emp of emps || []) {
    const myLogs = (logs || []).filter(r => r.empId === emp.id);
    let late = 0;
    for (const r of myLogs) {
      const d  = new Date(r.timestamp);
      const si = r.shiftType ? U.getShiftInfo(emp.dept, r.shiftType) : null;
      const isL = si
        ? (d.getHours() * 60 + d.getMinutes()) > (si.lateH * 60 + si.lateM)
        : U.isLate(emp.dept, d);
      if (isL) late++;
    }
    if (late >= 3) warnings.push({ empId: emp.id, empName: emp.name, dept: emp.dept, lateCount: late });
  }
  return warnings.sort((a, b) => b.lateCount - a.lateCount);
};

// ── DAVAMIYYƏT ────────────────────────────────────────────────────

API.validateAndLog = async (enteredPin, clientIp) => {
  if (!enteredPin) return { valid: false, reason: 'Kod daxil edilməyib' };
  const { data: emps } = await sb.from('employees').select('*');
  const cW = Math.floor(Date.now() / U.TIME_STEP);
  const matched = (emps || []).find(emp =>
    enteredPin === U.generateDynamicPin(emp.secret, cW) ||
    enteredPin === U.generateDynamicPin(emp.secret, cW - 1)
  );
  if (!matched) return { valid: false, reason: 'Yanlış və ya vaxtı keçmiş kod!' };

  const wc = U.checkWifiIp(matched.dept, clientIp || '');
  if (!wc.ok) return { valid: false, reason: wc.reason };

  const empIp = U.cacheGet('EMP_IP_' + matched.secret);
  if (empIp === null) return { valid: false, reason: 'Mobil kartınız açıq deyil. Əvvəlcə kartı açın.' };
  const empWc = U.checkWifiIp(matched.dept, empIp || '');
  if (!empWc.ok) return { valid: false, reason: 'Telefonunuz filial WiFi-ına qoşulmayıb!' };

  const ts       = new Date();
  const todayStr = U.getLogicalDateStr(ts);
  const todayYMD = U.getLogicalYMD(ts);

  const todayShift = await U.getEmployeeShift(matched.id, todayYMD);
  if (todayShift === 'istirahetsm') return { valid: false, reason: 'Bu gün sizin istirahət gününüzdür!' };
  if (await U.hasApprovedLeave(matched.id, todayYMD)) return { valid: false, reason: 'Bu gün üçün təsdiq edilmiş izniniz var.' };

  const { data: allLogs } = await sb.from('attendance').select('*').eq('empId', String(matched.id));
  const todayLogs = (allLogs || []).filter(r => U.getLogicalDateStr(new Date(r.timestamp)) === todayStr);
  const shiftInfo = todayShift ? U.getShiftInfo(matched.dept, todayShift) : null;

  if (todayLogs.length === 0) {
    const nowMins = ts.getHours() * 60 + ts.getMinutes() +
      (ts.getHours() < 3 && shiftInfo && shiftInfo.startH >= 12 ? 24 * 60 : 0);
    let late = shiftInfo
      ? nowMins > (shiftInfo.lateH * 60 + shiftInfo.lateM)
      : U.isLate(matched.dept, ts);
    if (late) {
      const perm = await U.getApprovedLatePerm(matched.id, todayYMD);
      if (perm) {
        const [ph, pm] = perm.requestedTime.split(':').map(Number);
        if ((ts.getHours() * 60 + ts.getMinutes()) <= ph * 60 + pm + 5) late = false;
      }
    }
    const lateStr = late
      ? `\n⚠️ <b>GECİKMƏ!</b>${shiftInfo ? ` (limit: ${String(shiftInfo.lateH).padStart(2,'0')}:${String(shiftInfo.lateM).padStart(2,'0')})` : ''}`
      : '\n✅ Vaxtında';
    await sb.from('attendance').insert({
      empId: matched.id, empName: matched.name, dept: matched.dept,
      timestamp: ts.toISOString(), type: 'GƏLİŞ', overtime: '', shiftType: todayShift || '',
    });
    await U.sendTelegramMsg(`<b>Smendə</b>\n <b>${matched.name}</b>\n${lateStr}\n ${U.fmtTime(ts)}`, matched.dept);
    return { valid: true, empName: matched.name, dept: matched.dept, type: 'GƏLİŞ', overtime: '' };

  } else if (todayLogs.length === 1) {
    const reqH = shiftInfo ? shiftInfo.durH
      : ((matched.dept === 'Ağ Şəhər' || matched.dept === 'Gənclik') ? 9 : 8);
    const diffMs = ts.getTime() - new Date(todayLogs[0].timestamp).getTime() - reqH * 3600000;
    const absMs  = Math.abs(diffMs);
    const dh = Math.floor(absMs / 3600000), dm = Math.floor((absMs % 3600000) / 60000);
    const overtimeStr = (dh === 0 && dm === 0) ? 'Tam vaxtında'
      : `${diffMs >= 0 ? '+' : '-'}${dh} saat ${dm} dəq`;
    await sb.from('attendance').insert({
      empId: matched.id, empName: matched.name, dept: matched.dept,
      timestamp: ts.toISOString(), type: 'CIXIS', overtime: overtimeStr, shiftType: todayShift || '',
    });
    const otE = diffMs > 0 ? '🟢' : diffMs < 0 ? '🔴' : '⚪';
    await U.sendTelegramMsg(`<b>Smen bitdi</b>\n <b>${matched.name}</b>\n ${U.fmtTime(ts)}\n${otE} Fərq: <b>${overtimeStr}</b>`, matched.dept);
    return { valid: true, empName: matched.name, dept: matched.dept, type: 'CIXIS', overtime: overtimeStr };
  }
  return { valid: false, reason: 'Bu gün üçün artıq qeyd var' };
};

API.getOnlineEmployees = async () => {
  const todayStr = U.getLogicalDateStr(new Date());
  const { data: logs } = await sb.from('attendance').select('*').order('timestamp');
  const empMap = {};
  for (const row of logs || []) {
    if (!row.empId || String(row.empId).startsWith('MGR-')) continue;
    const rd = new Date(row.timestamp);
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
  const { data: emp } = await sb.from('employees').select('*').eq('secret', secret).single();
  if (!emp) return null;
  const now    = new Date();
  const monday = new Date(now.getTime() - ((now.getDay() === 0 ? 6 : now.getDay() - 1) * 86400000));
  monday.setHours(0, 0, 0, 0);
  const DAY_NAMES = ['B.e.','Ç.a.','Çər.','C.a.','Cüm.','Şən.','Baz.'];

  const allDeptSched = await API.getCedvel(emp.dept, U.toYMD(monday));
  const buildWeek = async (startDate, deptSched) => {
    const week = [];
    for (let d = 0; d < 7; d++) {
      const dd     = new Date(startDate.getTime() + d * 86400000);
      const ds     = U.toYMD(dd);
      const st     = await U.getEmployeeShift(emp.id, ds);
      const si     = st ? U.getShiftInfo(emp.dept, st) : null;
      const dayIdx = dd.getDay() === 0 ? 6 : dd.getDay() - 1;
      const myGroup = (st === 'axsamsm' || st === 'fullsm') ? 'evening' : 'morning';
      const colleagues = [];
      if (st && st !== 'istirahetsm') {
        for (const other of deptSched) {
          if (other.empId === emp.id) continue;
          const od = other.schedule[d];
          if (!od?.shiftType || od.shiftType === 'istirahetsm') continue;
          const tg = (od.shiftType === 'axsamsm' || od.shiftType === 'fullsm') ? 'evening' : 'morning';
          if (tg === myGroup) colleagues.push(other.empName.split(' ')[0]);
        }
      }
      week.push({ date: ds, dayName: DAY_NAMES[dayIdx], shiftType: st || '',
        label: si ? si.label : st === 'istirahetsm' ? 'İstirahət' : '-',
        isToday: U.toYMD(now) === ds, colleagues });
    }
    return week;
  };

  const nextMonday = new Date(monday.getTime() + 7 * 86400000);
  const allDeptSchedNext = await API.getCedvel(emp.dept, U.toYMD(nextMonday));
  const [weekSchedule, nextWeekSchedule] = await Promise.all([
    buildWeek(monday, allDeptSched),
    buildWeek(nextMonday, allDeptSchedNext),
  ]);

  const report = await API.getMonthlyReport(now.getFullYear(), now.getMonth() + 1);
  const myR    = report.find(r => r.empId === emp.id) || { totalDays:0, onTime:0, late:0, pct:0 };
  return {
    streak:          await U.calcStreak(emp.id, emp.dept),
    dept:            emp.dept,
    weekSchedule,
    nextWeekSchedule,
    monthStats:      { days: myR.totalDays, onTime: myR.onTime, late: myR.late, pct: myR.pct },
    announcements:   await API.getAnnouncements(),
  };
};

// ── NAHAR ────────────────────────────────────────────────────────

API.logLunch = async (enteredPin, clientIp, lunchType) => {
  if (!enteredPin) return { valid: false, reason: 'Kod daxil edilməyib' };
  if (lunchType !== 'NAHAR_GET' && lunchType !== 'NAHAR_QAY') return { valid: false, reason: 'Yanlış nahar növü' };
  const { data: emps } = await sb.from('employees').select('*');
  const cW = Math.floor(Date.now() / U.TIME_STEP);
  const matched = (emps || []).find(emp =>
    enteredPin === U.generateDynamicPin(emp.secret, cW) ||
    enteredPin === U.generateDynamicPin(emp.secret, cW - 1)
  );
  if (!matched) return { valid: false, reason: 'Yanlış və ya vaxtı keçmiş kod!' };
  if (clientIp) { const wc = U.checkWifiIp(matched.dept, clientIp); if (!wc.ok) return { valid: false, reason: wc.reason }; }

  const ts       = new Date();
  const todayStr = U.getLogicalDateStr(ts);
  const { data: attLogs } = await sb.from('attendance').select('*').eq('empId', String(matched.id));
  const hasTodayGelis = (attLogs || []).some(r => U.getLogicalDateStr(new Date(r.timestamp)) === todayStr && r.type === 'GƏLİŞ');
  const hasTodayCixis = (attLogs || []).some(r => U.getLogicalDateStr(new Date(r.timestamp)) === todayStr && r.type === 'CIXIS');
  if (!hasTodayGelis) return { valid: false, reason: 'Əvvəlcə giriş qeydə alınmalıdır!' };
  if (hasTodayCixis)  return { valid: false, reason: 'Artıq smen çıxışı qeydə alınıb!' };

  const { data: naharLogs } = await sb.from('nahar').select('*').eq('empId', String(matched.id));
  const naharGet = (naharLogs || []).filter(r => U.getLogicalDateStr(new Date(r.timestamp)) === todayStr && r.type === 'NAHAR_GET');
  const naharQay = (naharLogs || []).filter(r => U.getLogicalDateStr(new Date(r.timestamp)) === todayStr && r.type === 'NAHAR_QAY');

  if (lunchType === 'NAHAR_GET') {
    if (naharGet.length > 0) return { valid: false, reason: 'Artıq nahara çıxmısınız!' };
    await sb.from('nahar').insert({ naharId: 'NH-' + Date.now().toString(36).toUpperCase(), empId: matched.id, empName: matched.name, dept: matched.dept, timestamp: ts.toISOString(), type: 'NAHAR_GET' });
    await U.sendTelegramMsg(`<b>${matched.name}</b>\n<b>Naharda</b>\n${U.fmtTime(ts)}`, matched.dept);
    return { valid: true, empName: matched.name, dept: matched.dept, type: 'NAHAR_GET' };
  }
  if (naharGet.length === 0) return { valid: false, reason: 'Əvvəlcə nahara çıxış qeydə alınmalıdır!' };
  if (naharQay.length > 0)   return { valid: false, reason: 'Nahardan qayıdışınız artıq qeydə alınıb!' };
  const diffMin = Math.round((ts.getTime() - new Date(naharGet[0].timestamp).getTime()) / 60000);
  await sb.from('nahar').insert({ naharId: 'NH-' + Date.now().toString(36).toUpperCase(), empId: matched.id, empName: matched.name, dept: matched.dept, timestamp: ts.toISOString(), type: 'NAHAR_QAY' });
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
  const { data: all } = await sb.from('attendance').select('*').eq('empId', MGR_ID);
  const todayLogs = (all || []).filter(r => U.getLogicalDateStr(new Date(r.timestamp)) === todayStr);

  if (type === 'GELIS') {
    if (todayLogs.some(r => r.type === 'GELIS' || r.type === 'GƏLİŞ')) return { valid: false, reason: 'Giriş artıq qeydə alınıb!' };
    await sb.from('attendance').insert({ empId: MGR_ID, empName: mgrName, dept, timestamp: ts.toISOString(), type: 'GELIS', overtime: '', shiftType: '' });
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
    await sb.from('attendance').insert({ empId: MGR_ID, empName: mgrName, dept, timestamp: ts.toISOString(), type: 'CIXIS', overtime: dur, shiftType: '' });
    await U.sendTelegramMsg(`<b>Menecer Çıxdı</b>\n${U.fmtTime(ts)}\nİş müddəti: <b>${dur}</b>`, dept);
    return { valid: true, type: 'CIXIS', time: U.fmtTime(ts), duration: dur };
  }
  return { valid: false, reason: 'Yanlış əməliyyat.' };
};

API.getManagersLiveStatus = async () => {
  const todayStr = U.getLogicalDateStr(new Date());
  const DEPTS    = ['Elmlər','Sahil','Gənclik','Ağ Şəhər'];
  const { data: logs } = await sb.from('attendance').select('*').order('timestamp');
  const result = {};
  for (const dept of DEPTS) {
    const slug    = U.deptToSlug(dept);
    const mgrId   = 'MGR-' + dept.replace(/\s+/g, '');
    const deptLogs = (logs || []).filter(r => r.empId === mgrId && U.getLogicalDateStr(new Date(r.timestamp)) === todayStr);
    let gelisDate = null, cixisDate = null;
    for (const r of deptLogs) {
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

// ── MENECER İNFO ─────────────────────────────────────────────────

const MGR_SLUGS = ['elmler','sahil','genclik','agseher'];

API.getMgrInfo = () => ({
  globalMsg: U.getSetting('MGR_GLOBAL_MSG'),
  names: Object.fromEntries(MGR_SLUGS.map(s => [s, U.getSetting('MGR_NAME_' + s)])),
  msgs:  Object.fromEntries(MGR_SLUGS.map(s => [s, U.getSetting('MGR_MSG_'  + s)])),
});

API.saveMgrInfo = async (data) => {
  if (data.globalMsg !== undefined) await U.setSetting('MGR_GLOBAL_MSG', data.globalMsg || '');
  for (const slug of MGR_SLUGS) {
    if (data.names?.[slug] !== undefined) await U.setSetting('MGR_NAME_' + slug, data.names[slug] || '');
    if (data.msgs?.[slug]  !== undefined) await U.setSetting('MGR_MSG_'  + slug, data.msgs[slug]  || '');
  }
  return { success: true };
};

API.getMgrInfoForBranch = (branchKey) => {
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return null;
  const slug = U.deptToSlug(check.dept);
  return { dept: check.dept, mgrName: U.getSetting('MGR_NAME_' + slug),
           globalMsg: U.getSetting('MGR_GLOBAL_MSG'), branchMsg: U.getSetting('MGR_MSG_' + slug) };
};

// ── TELEGRAM ─────────────────────────────────────────────────────

API.getTelegramSettings = () => U.getTelegramSettings();

API.saveTelegramSettings = async (data) => {
  await Promise.all([
    U.setSetting('TG_TOKEN',        data.token       || ''),
    U.setSetting('TG_ADMIN_CHAT',   data.adminChat   || ''),
    U.setSetting('TG_ENABLED',      data.enabled ? 'true' : 'false'),
    U.setSetting('TG_CHAT_Elmler',  data.chatElmler  || ''),
    U.setSetting('TG_CHAT_Sahil',   data.chatSahil   || ''),
    U.setSetting('TG_CHAT_Genclik', data.chatGenclik || ''),
    U.setSetting('TG_CHAT_AgSeher', data.chatAgSeher || ''),
  ]);
  return { success: true };
};

API.testTelegram = async () => {
  const cfg = U.getTelegramSettings();
  if (!cfg.token)     return { success: false, reason: 'Token boşdur.' };
  if (!cfg.adminChat) return { success: false, reason: 'Chat ID boşdur.' };
  try {
    const r = await fetch(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.adminChat, text: '☕ <b>Coffeemoon</b>\n\n✅ Telegram bağlantısı uğurla quruldu!', parse_mode: 'HTML' }),
    });
    const d = await r.json();
    return d.ok ? { success: true } : { success: false, reason: d.description };
  } catch (e) { return { success: false, reason: e.toString() }; }
};

// ── WiFi IP ──────────────────────────────────────────────────────

API.getBranchIPs = () => ({
  elmler: U.getSetting('IP_elmler'), sahil: U.getSetting('IP_sahil'),
  genclik: U.getSetting('IP_genclik'), agseher: U.getSetting('IP_agseher'),
});

API.saveBranchIPs = async (data) => {
  await Promise.all([
    U.setSetting('IP_elmler',  data.elmler  || ''),
    U.setSetting('IP_sahil',   data.sahil   || ''),
    U.setSetting('IP_genclik', data.genclik || ''),
    U.setSetting('IP_agseher', data.agseher || ''),
  ]);
  return { success: true };
};

// ── ÇEKLİST ─────────────────────────────────────────────────────

API.getChecklistItems = async () => {
  const { data } = await sb.from('checklistItems').select('*').order('sortOrder');
  return (data || []).map(r => ({ ...r, active: !!r.active }));
};

API.saveChecklistItems = async (items) => {
  await sb.from('checklistItems').delete().neq('itemId', '');
  if (items.length) {
    await sb.from('checklistItems').insert(
      items.map((item, i) => ({ itemId: item.itemId, text: item.text, category: item.category, sortOrder: i + 1, active: !!item.active }))
    );
  }
  return { success: true };
};

API.getChecklistForBranch = async (branchKey) => {
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return { valid: false, reason: 'İcazəsiz giriş.' };
  const today = U.toYMD(new Date());
  const [{ data: items }, { data: logs }] = await Promise.all([
    sb.from('checklistItems').select('*').eq('active', true).order('sortOrder'),
    sb.from('checklistLogs').select('*').eq('date', today).eq('dept', check.dept),
  ]);
  const logMap = {};
  for (const r of logs || []) logMap[r.itemId] = r;
  return { valid: true, dept: check.dept, date: today, items: (items || []).map(item => {
    const log = logMap[item.itemId] || {};
    return { ...item, active: !!item.active, checked: !!log.checked, checkedAt: log.checkedAt || '', mgrNote: log.mgrNote || '', adminNote: log.adminNote || '' };
  }) };
};

API.submitChecklistItem = async (branchKey, itemId, checked, mgrNote) => {
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return { valid: false, reason: 'İcazəsiz giriş.' };
  const today = U.toYMD(new Date());
  const ts    = new Date();
  const { data: existing } = await sb.from('checklistLogs').select('logId').eq('date', today).eq('dept', check.dept).eq('itemId', String(itemId)).single();
  if (existing) {
    await sb.from('checklistLogs').update({ checked: !!checked, checkedAt: checked ? U.fmtTime(ts) : '', mgrNote: mgrNote || '' }).eq('logId', existing.logId);
  } else {
    const { data: itemRow } = await sb.from('checklistItems').select('text').eq('itemId', String(itemId)).single();
    await sb.from('checklistLogs').insert({ logId: 'CL-' + Date.now().toString(36).toUpperCase(), date: today, dept: check.dept, itemId, itemText: itemRow?.text || '', checked: !!checked, checkedAt: checked ? U.fmtTime(ts) : '', mgrNote: mgrNote || '', adminNote: '' });
  }
  return { valid: true, checkedAt: checked ? U.fmtTime(ts) : '' };
};

API.getChecklistReport = async (dateStr) => {
  const date  = dateStr || U.toYMD(new Date());
  const DEPTS = ['Ağ Şəhər','Gənclik','Elmlər','Sahil'];
  const [{ data: items }, { data: logs }] = await Promise.all([
    sb.from('checklistItems').select('*').eq('active', true).order('sortOrder'),
    sb.from('checklistLogs').select('*').eq('date', date),
  ]);
  const report = {};
  for (const dept of DEPTS) {
    report[dept] = {};
    for (const item of items || []) report[dept][item.itemId] = { checked: false, checkedAt: '', mgrNote: '', adminNote: '' };
  }
  for (const r of logs || []) {
    if (report[r.dept]?.[r.itemId] !== undefined) {
      report[r.dept][r.itemId] = { checked: !!r.checked, checkedAt: r.checkedAt || '', mgrNote: r.mgrNote || '', adminNote: r.adminNote || '' };
    }
  }
  return { date, items: (items || []).map(i => ({ ...i, active: !!i.active })), report };
};

API.saveAdminNote = async (dateStr, dept, itemId, adminNote) => {
  const date = dateStr || U.toYMD(new Date());
  const { data: existing } = await sb.from('checklistLogs').select('logId').eq('date', date).eq('dept', dept).eq('itemId', String(itemId)).single();
  if (existing) {
    await sb.from('checklistLogs').update({ adminNote: adminNote || '' }).eq('logId', existing.logId);
  } else {
    const { data: itemRow } = await sb.from('checklistItems').select('text').eq('itemId', String(itemId)).single();
    await sb.from('checklistLogs').insert({ logId: 'CL-' + Date.now().toString(36).toUpperCase(), date, dept, itemId, itemText: itemRow?.text || '', checked: false, checkedAt: '', mgrNote: '', adminNote: adminNote || '' });
  }
  return { success: true };
};

// ── MENECER TƏSDİQ ───────────────────────────────────────────────

API.getMgrAckStatus = async (branchKey) => {
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return null;
  const { data } = await sb.from('mgrAcks').select('*').eq('date', U.toYMD(new Date())).eq('dept', check.dept).single();
  if (!data) return { globalAcked: false, globalAckedAt: '', branchAcked: false, branchAckedAt: '' };
  return { globalAcked: !!data.globalAcked, globalAckedAt: data.globalAckedAt || '', branchAcked: !!data.branchAcked, branchAckedAt: data.branchAckedAt || '' };
};

API.ackMgrMessage = async (branchKey, msgType) => {
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return { success: false };
  const today = U.toYMD(new Date()), ts = U.fmtTime(new Date());
  const { data: existing } = await sb.from('mgrAcks').select('ackId').eq('date', today).eq('dept', check.dept).single();
  const upd = msgType === 'global' ? { globalAcked: true, globalAckedAt: ts } : { branchAcked: true, branchAckedAt: ts };
  if (existing) {
    await sb.from('mgrAcks').update(upd).eq('ackId', existing.ackId);
  } else {
    await sb.from('mgrAcks').insert({ ackId: 'ACK-' + Date.now().toString(36).toUpperCase(), date: today, dept: check.dept, ...upd });
  }
  return { success: true, time: ts };
};

API.getMgrAcksForAdmin = async (dateStr) => {
  const date  = dateStr || U.toYMD(new Date());
  const DEPTS = ['Ağ Şəhər','Gənclik','Elmlər','Sahil'];
  const { data } = await sb.from('mgrAcks').select('*').eq('date', date);
  const result = {};
  for (const d of DEPTS) result[d] = { globalAcked: false, globalAckedAt: '', branchAcked: false, branchAckedAt: '' };
  for (const r of data || []) {
    if (result[r.dept]) result[r.dept] = { globalAcked: !!r.globalAcked, globalAckedAt: r.globalAckedAt || '', branchAcked: !!r.branchAcked, branchAckedAt: r.branchAckedAt || '' };
  }
  return { date, acks: result };
};

// ── MƏHSULLAR ────────────────────────────────────────────────────

const WASTE_LIMITS = { 'Gənclik':2.5,'Ağ Şəhər':3.0,'Elmlər':3.5,'Sahil':4.0 };
function getWasteLimit(dept) { return WASTE_LIMITS[dept] ?? 3.0; }

API.getProducts = async () => {
  const { data } = await sb.from('products').select('*').eq('active', true).order('name');
  return (data || []).map(p => ({ productId: p.productId, name: p.name, unit: p.unit }));
};

API.addProduct = async (name, unit) => {
  if (!name?.trim()) return { success: false, reason: 'Ad boş ola bilməz.' };
  const id = 'PRD-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substring(2,4).toUpperCase();
  const { error } = await sb.from('products').insert({ productId: id, name: name.trim(), unit: unit || 'ədəd', active: true });
  return { success: !error, productId: id };
};

API.deleteProduct = async (productId) => {
  const { error } = await sb.from('products').update({ active: false }).eq('productId', productId);
  return error ? { success: false, reason: 'Tapılmadı.' } : { success: true };
};

API.getProductLogsForBranch = async (branchKey, monthStr) => {
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return { valid: false };
  const { data: products } = await sb.from('products').select('*').eq('active', true);
  const { data: logs } = await sb.from('productLogs').select('*').eq('dept', check.dept).like('dateStr', monthStr + '%');
  const totals = {};
  for (const r of logs || []) {
    if (!totals[r.productId]) totals[r.productId] = { incoming: 0, wasted: 0 };
    totals[r.productId].incoming += Number(r.incoming) || 0;
    totals[r.productId].wasted   += Number(r.wasted)   || 0;
  }
  let totalIn = 0, totalWasted = 0;
  const items = (products || []).map(p => {
    const t = totals[p.productId] || { incoming:0, wasted:0 };
    totalIn += t.incoming; totalWasted += t.wasted;
    return { productId: p.productId, name: p.name, unit: p.unit, totalIncoming: t.incoming, totalWasted: t.wasted };
  });
  const limit = getWasteLimit(check.dept);
  const pct   = totalIn > 0 ? Math.round(totalWasted / totalIn * 1000) / 10 : 0;
  return { valid: true, dept: check.dept, monthStr, items, limit, totalIn, totalWasted, pct, exceeded: totalIn > 0 && pct > limit };
};

API.saveProductLogs = async (branchKey, monthStr, logs) => {
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return { valid: false };
  const todayYMD = U.toYMD(new Date());
  const toInsert = (logs || []).filter(l => l.productId && (Number(l.incoming) || Number(l.wasted))).map(l => ({
    logId: 'PL-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substring(2,4).toUpperCase(),
    dateStr: todayYMD, dept: check.dept, productId: l.productId, productName: l.name || '',
    incoming: Number(l.incoming) || 0, wasted: Number(l.wasted) || 0,
  }));
  if (toInsert.length) await sb.from('productLogs').insert(toInsert);
  const { data: allLogs } = await sb.from('productLogs').select('*').eq('dept', check.dept).like('dateStr', monthStr + '%');
  let totalIn = 0, totalWasted = 0;
  for (const r of allLogs || []) { totalIn += Number(r.incoming)||0; totalWasted += Number(r.wasted)||0; }
  const limit = getWasteLimit(check.dept);
  const pct   = totalIn > 0 ? Math.round(totalWasted / totalIn * 1000) / 10 : 0;
  return { valid: true, pct, limit, exceeded: totalIn > 0 && pct > limit, totalIn, totalWasted };
};

API.getWasteStatsForAdmin = async (dateStr) => {
  const DEPTS  = ['Elmlər','Sahil','Gənclik','Ağ Şəhər'];
  const { data: logs } = await sb.from('productLogs').select('*').like('dateStr', dateStr + '%');
  const deptMap = {};
  for (const d of DEPTS) deptMap[d] = { dept: d, totalIn:0, totalWasted:0, products:[], limit: getWasteLimit(d) };
  for (const r of logs || []) {
    if (!deptMap[r.dept] || (!r.incoming && !r.wasted)) continue;
    deptMap[r.dept].totalIn     += Number(r.incoming)||0;
    deptMap[r.dept].totalWasted += Number(r.wasted)  ||0;
    deptMap[r.dept].products.push({ name: r.productName, incoming: Number(r.incoming)||0, wasted: Number(r.wasted)||0 });
  }
  return DEPTS.map(d => {
    const s = deptMap[d], pct = s.totalIn > 0 ? Math.round(s.totalWasted/s.totalIn*1000)/10 : 0;
    return { dept:s.dept, totalIn:s.totalIn, totalWasted:s.totalWasted, pct, limit:s.limit, exceeded:s.totalIn>0&&pct>s.limit, hasData:s.totalIn>0||s.totalWasted>0, products:s.products };
  });
};

// ── MENECER HƏFTƏLIK QRAFİK ───────────────────────────────────────

API.getMgrWeekSchedule = async (branchKey, weekStart) => {
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return null;
  const start = new Date(weekStart);
  const dates = Array.from({length:7}, (_, d) => U.toYMD(new Date(start.getTime()+d*86400000)));
  const { data } = await sb.from('mgrSchedule').select('*').eq('dept', check.dept).in('dateStr', dates);
  const map = {};
  for (const r of data || []) map[r.dateStr] = r.shiftType;
  return { dept: check.dept, schedule: dates.map(ds => ({ date: ds, shiftType: map[ds] || '' })) };
};

API.saveMgrWeekSchedule = async (branchKey, entries) => {
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return { success: false, reason: 'İcazəsiz.' };
  const dates = entries.map(e => e.dateStr).filter(Boolean);
  if (dates.length) await sb.from('mgrSchedule').delete().eq('dept', check.dept).in('dateStr', dates);
  const toInsert = entries.filter(e => e.dateStr && e.shiftType).map(e => ({
    schedId: 'MS-' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random()*1000).toString(36).toUpperCase(),
    dept: check.dept, dateStr: e.dateStr, shiftType: e.shiftType,
  }));
  if (toInsert.length) await sb.from('mgrSchedule').insert(toInsert);
  return { success: true };
};

API.getMgrScheduleForAdmin = async (weekStart) => {
  const DEPTS = ['Ağ Şəhər','Gənclik','Elmlər','Sahil'];
  const start = new Date(weekStart);
  const dates = Array.from({length:7}, (_, d) => U.toYMD(new Date(start.getTime()+d*86400000)));
  const { data } = await sb.from('mgrSchedule').select('*').in('dateStr', dates);
  const map = {};
  for (const dept of DEPTS) map[dept] = {};
  for (const r of data || []) { if (map[r.dept]) map[r.dept][r.dateStr] = r.shiftType; }
  const DAY_NAMES = ['B.e.','Ç.a.','Çər.','C.a.','Cüm.','Şən.','Baz.'];
  return {
    dates: dates.map(ds => { const dd=new Date(ds); return {date:ds,dayName:DAY_NAMES[dd.getDay()===0?6:dd.getDay()-1]}; }),
    managers: DEPTS.map(dept => ({ dept, mgrName: U.getSetting('MGR_NAME_'+U.deptToSlug(dept))||dept, schedule: dates.map(ds=>map[dept][ds]||'') })),
  };
};

// ── GEC GƏLİŞ İCAZƏSİ ────────────────────────────────────────────

API.requestLatePerm = async (secret, dateStr, requestedTime) => {
  if (!secret||!dateStr||!requestedTime) return { success:false, reason:'Məlumatlar natamamdır.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return { success:false, reason:'Tarix formatı yanlışdır.' };
  if (!/^\d{2}:\d{2}$/.test(requestedTime)) return { success:false, reason:'Vaxt formatı yanlışdır.' };
  const { data: emp } = await sb.from('employees').select('*').eq('secret', secret).single();
  if (!emp) return { success:false, reason:'İşçi tapılmadı.' };
  const { data: existing } = await sb.from('latePerms').select('status').eq('empId', String(emp.id)).eq('dateStr', dateStr).single();
  if (existing && (existing.status==='pending'||existing.status==='approved')) return { success:false, reason:'Bu tarix üçün artıq icazəniz mövcuddur.' };
  const permId = 'LP-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substring(2,5).toUpperCase();
  await sb.from('latePerms').insert({ permId, empId:emp.id, empName:emp.name, dept:emp.dept, dateStr, requestedTime, status:'pending' });
  return { success:true, permId };
};

API.getLatePermsForManager = async (branchKey) => {
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return [];
  const { data } = await sb.from('latePerms').select('*').eq('dept', check.dept).order('createdAt',{ascending:false}).limit(30);
  return (data||[]).sort((a,b)=>{
    if(a.status==='pending'&&b.status!=='pending')return -1;
    if(a.status!=='pending'&&b.status==='pending')return 1;
    return b.dateStr.localeCompare(a.dateStr);
  });
};

API.approveLatePerm = async (branchKey, permId, action) => {
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return { success:false, reason:'İcazəsiz.' };
  if (action!=='approved'&&action!=='rejected') return { success:false, reason:'Yanlış əməliyyat.' };
  const { error } = await sb.from('latePerms').update({ status:action, approvedAt:new Date().toISOString() }).eq('permId', permId).eq('dept', check.dept);
  return { success:!error };
};

API.getMyLatePerms = async (secret) => {
  if (!secret) return [];
  const { data:emp } = await sb.from('employees').select('id').eq('secret',secret).single();
  if (!emp) return [];
  const today = U.toYMD(new Date());
  const { data } = await sb.from('latePerms').select('permId,dateStr,requestedTime,status').eq('empId',String(emp.id)).gte('dateStr',today).order('dateStr').limit(5);
  return data || [];
};

// ── YENİLİKLƏR ───────────────────────────────────────────────────

API.getAnnouncements = async () => {
  const { data } = await sb.from('announcements').select('*').order('pinned',{ascending:false}).order('date',{ascending:false});
  return (data||[]).map(r=>({
    id:r.id, title:r.title, body:r.body, type:r.type||'info', pinned:!!r.pinned,
    date: r.date ? r.date.slice(0,10).split('-').reverse().join('.') : '',
  }));
};

API.saveAnnouncement = async (data) => {
  if (data.id) {
    const { error } = await sb.from('announcements').update({ title:data.title, body:data.body, type:data.type||'info', pinned:!!data.pinned }).eq('id',data.id);
    if (!error) return { ok:true };
  }
  const newId = 'YN-' + Date.now().toString(36).toUpperCase();
  await sb.from('announcements').insert({ id:newId, title:data.title, body:data.body, type:data.type||'info', pinned:!!data.pinned });
  return { ok:true, id:newId };
};

API.deleteAnnouncement = async (id) => {
  const { error } = await sb.from('announcements').delete().eq('id',id);
  return { ok:!error };
};

// ── MENECER DASHBOARD ─────────────────────────────────────────────

API.getManagerDashboard = async (branchKey, weekStart) => {
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return null;
  const [cedvel, mgrInfo, ackStatus, mgrSched, latePerms] = await Promise.all([
    API.getCedvel(check.dept, weekStart),
    Promise.resolve(API.getMgrInfoForBranch(branchKey)),
    API.getMgrAckStatus(branchKey),
    API.getMgrWeekSchedule(branchKey, weekStart),
    API.getLatePermsForManager(branchKey),
  ]);
  return { cedvel, mgrInfo, ackStatus, mgrSched, latePerms };
};

// ══════════════════════════════════════════════════════════════════
//  SERVER BAŞLAT
// ══════════════════════════════════════════════════════════════════

(async () => {
  try {
    // Settings-i yüklə (Supabase-dən)
    await U.loadSettings();

    // Filial açarlarını əvvəldən qur (varsa saxla)
    await U.getBranchScheduleKeys();

    console.log('✅  Supabase bağlantısı hazırdır');

    app.listen(PORT, async () => {
      console.log(`☕  Coffeemoon http://localhost:${PORT}`);
      console.log(`🔑  Admin: http://localhost:${PORT}/admin?key=${ADMIN_KEY}`);
      const keys = await U.getBranchScheduleKeys();
      for (const [dept, key] of Object.entries(keys)) {
        console.log(`🏪  ${dept}: http://localhost:${PORT}/manager?key=${key}`);
      }
    });
  } catch (e) {
    console.error('❌  Başlama xətası:', e.message);
    process.exit(1);
  }
})();