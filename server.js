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

app.get('/mycode-manifest', (req, res) => {
  const { secret = '', name = 'İşçi' } = req.query;
  const startUrl = `/mycode?secret=${encodeURIComponent(secret)}&name=${encodeURIComponent(name)}`;
  res.setHeader('Content-Type', 'application/manifest+json');
  res.json({
    name: `Coffeemoon · ${name}`,
    short_name: name,
    description: 'Coffeemoon işçi qeydiyyat kartı',
    start_url: startUrl,
    display: 'standalone',
    background_color: '#f0f2f8',
    theme_color: '#5b5ef4',
    orientation: 'portrait',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  });
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

app.get('/manager-manifest', (req, res) => {
  const { key = '' } = req.query;
  const check = U.validateBranchScheduleKey(key);
  const dept = check.valid ? check.dept : 'Menecer';
  const startUrl = `/manager?key=${encodeURIComponent(key)}`;
  res.setHeader('Content-Type', 'application/manifest+json');
  res.json({
    name: `Coffeemoon · ${dept}`,
    short_name: dept,
    description: 'Coffeemoon menecer paneli',
    start_url: startUrl,
    display: 'standalone',
    background_color: '#f0f2f8',
    theme_color: '#5b5ef4',
    orientation: 'portrait',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  });
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

app.get('/trainer', (req, res) => {
  const { key = '' } = req.query;
  const trainerKey = U.getSetting('TRAINER_KEY');
  if (!trainerKey || trainerKey !== key)
    return res.send('<h2 style="color:red;font-family:sans-serif;padding:2rem">İcazəsiz giriş.</h2>');
  const trainerName = U.getSetting('TRAINER_NAME') || 'Treninq Meneceri';
  res.send(replaceVars(readTemplate('trainer.html'), {
    trainerKey:  key,
    trainerName: trainerName,
    scriptUrl:   `${req.protocol}://${req.get('host')}`,
  }));
});

app.get('/exam', (req, res) => res.send(readTemplate('exam.html')));

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

// ── XP MÜHƏRRİKİ ─────────────────────────────────────────────────
function getXPMultiplier(streak) {
  if (streak >= 60) return 2.0;
  if (streak >= 30) return 1.75;
  if (streak >= 14) return 1.5;
  if (streak >= 7)  return 1.25;
  return 1.0;
}

async function awardXP(empId, baseAmount, streak) {
  const gained = Math.round(baseAmount * getXPMultiplier(streak || 0));
  const { data: emp } = await sb.from('employees').select('xp').eq('id', empId).single();
  const current = emp?.xp || 0;
  await sb.from('employees').update({ xp: current + gained }).eq('id', empId);
  return gained;
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
  const result = emps.map(emp => ({
    id:      emp.id,
    name:    emp.name,
    dept:    emp.dept,
    secret:  emp.secret,
    message: emp.message || '',
    streak:  emp.is_test ? 999 : (emp.streak || 0),
  }));
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

  if (!emp.device_id) {
    await sb.from('employees').update({ device_id: deviceId }).eq('secret', secret);
    return { success: true, message: emp.message || '' };
  }

  if (emp.device_id !== deviceId) {
    return {
      success: false,
      reason: 'Bu kart başqa cihazda qeydiyyatlıdır. Dəyişdirmək üçün adminə müraciət edin.',
      deviceLocked: true,
    };
  }

  return { success: true, message: emp.message || '' };
};

API.resetDevice = async (id) => {
  const { error } = await sb.from('employees').update({ device_id: '' }).eq('id', id);
  return { success: !error };
};

// ── SCAN CİHAZLAR ────────────────────────────────────────────────

API.checkScanDevice = async (deviceId) => {
  if (!deviceId) return { allowed: false, pending: false, reason: 'Cihaz ID tapılmadı.' };
  const { data: dev } = await sb.from('scan_devices').select('*').eq('device_id', deviceId).single();
  if (dev) {
    if (dev.status === 'active')  return { allowed: true, branch: dev.branch, label: dev.label };
    if (dev.status === 'pending') return { allowed: false, pending: true, reason: 'Cihazınız admin tərəfindən hələ təsdiqlənməyib.' };
    if (dev.status === 'blocked') return { allowed: false, pending: false, reason: 'Bu cihaz admin tərəfindən bloklanıb.' };
  }
  await sb.from('scan_devices').upsert({ device_id: deviceId, status: 'pending' }, { onConflict: 'device_id' });
  await U.sendTelegramMsg(`☕ <b>Coffeemoon</b>\n\n📱 <b>Yeni Scan Cihazı qeydə alındı</b>\n\n🔑 <code>${deviceId}</code>`, null);
  return { allowed: false, pending: true, reason: 'Cihazınız qeydə alındı. Admin təsdiqini gözləyin.' };
};

API.getScanDevices = async () => {
  const { data } = await sb.from('scan_devices').select('*').order('created_at', { ascending: false });
  return (data || []).map(d => ({
    id: d.device_id, deviceId: d.device_id, branch: d.branch || '', status: d.status || 'pending',
    createdAt: d.created_at || '', label: d.label || '',
  }));
};

API.approveScanDevice = async (deviceId, branch, label) => {
  const { error } = await sb.from('scan_devices')
    .upsert({ device_id: deviceId, branch, status: 'active', label: label || branch }, { onConflict: 'device_id' });
  return { success: !error };
};

API.blockScanDevice = async (deviceId) => {
  const { error } = await sb.from('scan_devices').update({ status: 'blocked' }).eq('device_id', deviceId);
  return { success: !error };
};

API.removeScanDevice = async (deviceId) => {
  const { error } = await sb.from('scan_devices').delete().eq('device_id', deviceId);
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
  const { data: rows } = await sb.from('cedvel').select('*').eq('dept', dept).in('date_str', dates);
  const map = {};
  for (const r of rows || []) {
    if (!map[r.emp_id]) map[r.emp_id] = {};
    map[r.emp_id][r.date_str] = r.shift_type;
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
    await sb.from('cedvel').delete().in('emp_id', empIds).in('date_str', dates);
  }
  const toInsert = entries
    .filter(e => e.empId && e.dateStr && e.shiftType)
    .map(e => ({
      cedvel_id:  'C' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random()*1000).toString(36).toUpperCase(),
      emp_id:     e.empId, emp_name: e.empName, dept: e.dept,
      date_str:   e.dateStr, shift_type: e.shiftType,
    }));
  if (toInsert.length) await sb.from('cedvel').insert(toInsert);
  return { success: true };
};

API.getDeptList = () => U.DEPTS;
API.getBranchScheduleKeys = async () => U.getBranchScheduleKeys();
API.validateBranchScheduleKey = (key) => U.validateBranchScheduleKey(key);

API.getCedvelForTrainer = async (trainerKey, weekStart) => {
  const key = U.getSetting('TRAINER_KEY');
  if (!key || key !== trainerKey) return null;
  const all = await Promise.all(U.DEPTS.map(d => API.getCedvel(d, weekStart)));
  return all.flat();
};

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
  const { data } = await sb.from('izin').select('*').order('created_at', { ascending: false });
  return (data || []).map(r => ({
    id: r.izin_id, empId: r.emp_id, empName: r.emp_name, dept: r.dept,
    startDate: r.start_date, endDate: r.end_date,
    type: r.type || '', note: r.note || '', status: r.status || '',
    createdAt: r.created_at || '', izinId: r.izin_id,
  }));
};

API.addIzin = async (data) => {
  const id = 'I' + Date.now().toString(36).toUpperCase().slice(-6);
  const { error } = await sb.from('izin').insert({
    izin_id: id, emp_id: data.empId, emp_name: data.empName, dept: data.dept,
    start_date: data.startDate, end_date: data.endDate,
    type: data.type || 'İzin', note: data.note || '', status: 'pending',
  });
  return { success: !error };
};

API.updateIzinStatus = async (izinId, status) => {
  const { error } = await sb.from('izin').update({ status }).eq('izin_id', izinId);
  return { success: !error };
};

API.removeIzin = async (izinId) => {
  const { error } = await sb.from('izin').delete().eq('izin_id', izinId);
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
    const myLogs    = (logs || []).filter(r => r.emp_id === emp.id);
    const gelisLogs = myLogs.filter(r => r.type === 'GƏLİŞ');
    const cixisLogs = myLogs.filter(r => r.type === 'CIXIS');
    let lateCount = 0, onTime = 0, totalHours = 0;
    for (const r of gelisLogs) {
      const d = new Date(r.timestamp);
      const si = r.shift_type ? U.getShiftInfo(emp.dept, r.shift_type) : null;
      const late = si
        ? (d.getHours() * 60 + d.getMinutes()) > (si.lateH * 60 + si.lateM)
        : U.isLate(emp.dept, d);
      if (late) lateCount++; else onTime++;
    }
    for (const r of cixisLogs) {
      const si  = r.shift_type ? U.getShiftInfo(emp.dept, r.shift_type) : null;
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
    const myLogs = (logs || []).filter(r => r.emp_id === emp.id);
    let late = 0;
    for (const r of myLogs) {
      const d  = new Date(r.timestamp);
      const si = r.shift_type ? U.getShiftInfo(emp.dept, r.shift_type) : null;
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

API.validateAndLog = async (enteredPin, clientIp, forceMode) => {
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

  const ts       = new Date();
  const todayStr = U.getLogicalDateStr(ts);
  const todayYMD = U.getLogicalYMD(ts);

  const todayShift = await U.getEmployeeShift(matched.id, todayYMD);
  if (todayShift === 'istirahetsm') return { valid: false, reason: 'Bu gün sizin istirahət gününüzdür!' };
  if (await U.hasApprovedLeave(matched.id, todayYMD)) return { valid: false, reason: 'Bu gün üçün təsdiq edilmiş izniniz var.' };

  const { data: allLogs } = await sb.from('attendance').select('*').eq('emp_id', String(matched.id));
  const todayLogs = (allLogs || []).filter(r => U.getLogicalDateStr(new Date(r.timestamp)) === todayStr);
  const shiftInfo = todayShift ? U.getShiftInfo(matched.dept, todayShift) : null;

  if (todayLogs.length === 0) {
    // Əvvəlki smendə bağlanmamış giriş yoxla (forceMode keçilmədikdə)
    if (!forceMode) {
      const byDay = {};
      for (const r of allLogs || []) {
        const ds = U.getLogicalDateStr(new Date(r.timestamp));
        if (ds === todayStr) continue;
        if (!byDay[ds]) byDay[ds] = { gelis: false, cixis: false };
        if (r.type === 'GƏLİŞ') byDay[ds].gelis = true;
        if (r.type === 'CIXIS') byDay[ds].cixis = true;
      }
      const unclosedCount = Object.values(byDay).filter(d => d.gelis && !d.cixis).length;
      if (unclosedCount >= 2) {
        return { valid: false, warningType: 'UNCLOSED_PENALTY', empName: matched.name, penaltyNum: unclosedCount };
      }
      if (unclosedCount === 1) {
        return { valid: false, warningType: 'UNCLOSED_WARNING', empName: matched.name };
      }
    }

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
    const lateStr = late ? 'Gecikib' : 'Vaxtında';
    let lateWarning = late ? '' : ` — ${lateStr}`;
    await sb.from('attendance').insert({
      emp_id: matched.id, emp_name: matched.name, dept: matched.dept,
      timestamp: ts.toISOString(), type: 'GƏLİŞ', overtime: '', shift_type: todayShift || '',
    });
    if (!matched.is_test) {
      const newStreak = await U.calcStreak(matched.id, matched.dept);
      await sb.from('employees').update({ streak: newStreak }).eq('id', matched.id);
      if (!late) {
        await awardXP(matched.id, 20, newStreak);
        // Milestone bonusları (Variant 1)
        const MS_BONUSES = { 7:50, 14:100, 30:250, 60:500, 100:1000 };
        if (MS_BONUSES[newStreak]) {
          const claimed = matched.milestones_claimed || [];
          if (!claimed.includes(newStreak)) {
            await awardXP(matched.id, MS_BONUSES[newStreak], 0);
            await sb.from('employees')
              .update({ milestones_claimed: [...claimed, newStreak] })
              .eq('id', matched.id);
          }
        }
      } else {
        // Gecikmə cəzası — streak qalxanı
        const lateThreshold = shiftInfo
          ? (shiftInfo.lateH * 60 + shiftInfo.lateM)
          : (ts.getHours() < 13 ? 7 * 60 + 15 : (matched.dept === 'Gənclik' || matched.dept === 'Ağ Şəhər') ? 16 * 60 : 15 * 60);
        const lateMins = nowMins - lateThreshold;
        let penalty = lateMins >= 45 ? 50 : lateMins >= 21 ? 30 : 15;
        if (matched.streak >= 60) penalty = Math.round(penalty * 0.25);
        else if (matched.streak >= 30) penalty = Math.round(penalty * 0.5);
        const { data: empXP } = await sb.from('employees').select('xp').eq('id', matched.id).single();
        const current = empXP?.xp || 0;
        await sb.from('employees').update({ xp: Math.max(0, current - penalty) }).eq('id', matched.id);

        // Aylıq cərimə sistemi
        const monthStart = new Date(ts.getFullYear(), ts.getMonth(), 1).toISOString();
        const { data: monthLogs } = await sb.from('attendance')
          .select('timestamp,shift_type').eq('emp_id', String(matched.id))
          .eq('type', 'GƏLİŞ').gte('timestamp', monthStart);
        let prevLateCount = 0;
        for (const log of monthLogs || []) {
          const d = new Date(log.timestamp);
          if (U.getLogicalDateStr(d) === todayStr) continue; // bugünkü qeydi sayma
          const logSi = log.shift_type ? U.getShiftInfo(matched.dept, log.shift_type) : null;
          const tot = d.getHours() * 60 + d.getMinutes();
          const lim = logSi ? (logSi.lateH * 60 + logSi.lateM)
            : (d.getHours() < 13 ? 7 * 60 + 15 : (matched.dept === 'Gənclik' || matched.dept === 'Ağ Şəhər') ? 16 * 60 : 15 * 60);
          if (tot > lim) prevLateCount++;
        }
        const thisLateNum = prevLateCount + 1;
        lateWarning = prevLateCount === 0
          ? `\n⚠️ Bu ay <b>1-ci gecikmə</b> — ${lateMins} dəq. Xəbərdarlıq.`
          : prevLateCount === 1
            ? `\n🔴 Bu ay <b>2-ci gecikmə</b> — ${lateMins} dəq. Ciddi xəbərdarlıq!`
            : `\n❌ Bu ay <b>${thisLateNum}-ci gecikmə</b> — ${lateMins} dəq.\n💸 <b>30 AZN cərimə</b> qeyd edildi.`;
      }
    }
    await U.sendTelegramMsg(`<b>${matched.name}</b> smendə.\n${U.fmtTime(ts)}${lateWarning}`, matched.dept);
    return { valid: true, empName: matched.name, dept: matched.dept, type: 'GƏLİŞ', overtime: '' };

  } else if (todayLogs.length === 1) {
    // Nahar açıq qalmışsa xəbərdar et (forceMode keçilmədikdə)
    if (!forceMode) {
      const { data: naharLogs } = await sb.from('nahar').select('*').eq('emp_id', String(matched.id));
      const naharGet = (naharLogs || []).filter(r => U.getLogicalDateStr(new Date(r.timestamp)) === todayStr && r.type === 'NAHAR_GET');
      const naharQay = (naharLogs || []).filter(r => U.getLogicalDateStr(new Date(r.timestamp)) === todayStr && r.type === 'NAHAR_QAY');
      if (naharGet.length > 0 && naharQay.length === 0) {
        return { valid: false, warningType: 'UNCLOSED_LUNCH', empName: matched.name };
      }
    }

    const reqH = shiftInfo ? shiftInfo.durH
      : ((matched.dept === 'Ağ Şəhər' || matched.dept === 'Gənclik') ? 9 : 8);
    const diffMs = ts.getTime() - new Date(todayLogs[0].timestamp).getTime() - reqH * 3600000;
    const absMs  = Math.abs(diffMs);
    const dh = Math.floor(absMs / 3600000), dm = Math.floor((absMs % 3600000) / 60000);
    const overtimeStr = (dh === 0 && dm === 0) ? 'Tam vaxtında'
      : `${diffMs >= 0 ? '+' : '-'}${dh} saat ${dm} dəq`;
    await sb.from('attendance').insert({
      emp_id: matched.id, emp_name: matched.name, dept: matched.dept,
      timestamp: ts.toISOString(), type: 'CIXIS', overtime: overtimeStr, shift_type: todayShift || '',
    });
    await U.sendTelegramMsg(`<b>${matched.name}</b> smendən çıxdı.\n${U.fmtTime(ts)} — ${overtimeStr}`, matched.dept);
    return { valid: true, empName: matched.name, dept: matched.dept, type: 'CIXIS', overtime: overtimeStr };
  }
  return { valid: false, reason: 'Bu gün üçün artıq qeyd var' };
};

API.getOnlineEmployees = async () => {
  const todayStr = U.getLogicalDateStr(new Date());
  const { data: logs } = await sb.from('attendance').select('*').order('timestamp');
  const empMap = {};
  for (const row of logs || []) {
    if (!row.emp_id || String(row.emp_id).startsWith('MGR-')) continue;
    const rd = new Date(row.timestamp);
    if (U.getLogicalDateStr(rd) !== todayStr) continue;
    if (!empMap[row.emp_id]) empMap[row.emp_id] = { name: row.emp_name, dept: row.dept, gelis: null, cixis: false };
    if (row.type === 'GƏLİŞ') empMap[row.emp_id].gelis = rd;
    if (row.type === 'CIXIS') empMap[row.emp_id].cixis = true;
  }
  return Object.values(empMap)
    .filter(e => e.gelis && !e.cixis)
    .map(e => ({ name: e.name, dept: e.dept, checkInTime: U.fmtTime(e.gelis), checkInMs: e.gelis.getTime() }))
    .sort((a, b) => a.checkInMs - b.checkInMs);
};

API.registerEmployeeSession = (secret) => {
  if (!secret) return { ok: false };
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
    streak:          emp.is_test ? 999 : (emp.streak || 0),
    xp:              emp.is_test ? 999999 : (emp.xp || 0),
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
  const { data: attLogs } = await sb.from('attendance').select('*').eq('emp_id', String(matched.id));
  const hasTodayGelis = (attLogs || []).some(r => U.getLogicalDateStr(new Date(r.timestamp)) === todayStr && r.type === 'GƏLİŞ');
  const hasTodayCixis = (attLogs || []).some(r => U.getLogicalDateStr(new Date(r.timestamp)) === todayStr && r.type === 'CIXIS');
  if (!hasTodayGelis) return { valid: false, reason: 'Əvvəlcə giriş qeydə alınmalıdır!' };
  if (hasTodayCixis)  return { valid: false, reason: 'Artıq smen çıxışı qeydə alınıb!' };

  const { data: naharLogs } = await sb.from('nahar').select('*').eq('emp_id', String(matched.id));
  const naharGet = (naharLogs || []).filter(r => U.getLogicalDateStr(new Date(r.timestamp)) === todayStr && r.type === 'NAHAR_GET');
  const naharQay = (naharLogs || []).filter(r => U.getLogicalDateStr(new Date(r.timestamp)) === todayStr && r.type === 'NAHAR_QAY');

  if (lunchType === 'NAHAR_GET') {
    if (naharGet.length > 0) return { valid: false, reason: 'Artıq nahara çıxmısınız!' };
    await sb.from('nahar').insert({ nahar_id: 'NH-' + Date.now().toString(36).toUpperCase(), emp_id: matched.id, emp_name: matched.name, dept: matched.dept, timestamp: ts.toISOString(), type: 'NAHAR_GET' });
    await U.sendTelegramMsg(`<b>${matched.name}</b> naharda.\n${U.fmtTime(ts)}`, matched.dept);
    return { valid: true, empName: matched.name, dept: matched.dept, type: 'NAHAR_GET' };
  }
  if (naharGet.length === 0) return { valid: false, reason: 'Əvvəlcə nahara çıxış qeydə alınmalıdır!' };
  if (naharQay.length > 0)   return { valid: false, reason: 'Nahardan qayıdışınız artıq qeydə alınıb!' };
  const diffMin = Math.round((ts.getTime() - new Date(naharGet[0].timestamp).getTime()) / 60000);
  await sb.from('nahar').insert({ nahar_id: 'NH-' + Date.now().toString(36).toUpperCase(), emp_id: matched.id, emp_name: matched.name, dept: matched.dept, timestamp: ts.toISOString(), type: 'NAHAR_QAY' });
  await U.sendTelegramMsg(`<b>${matched.name}</b> nahar bitdi.\n${U.fmtTime(ts)} — ${diffMin} dəq`, matched.dept);
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
  const { data: all } = await sb.from('attendance').select('*').eq('emp_id', MGR_ID);
  const todayLogs = (all || []).filter(r => U.getLogicalDateStr(new Date(r.timestamp)) === todayStr);

  if (type === 'GELIS') {
    if (todayLogs.some(r => r.type === 'GELIS' || r.type === 'GƏLİŞ')) return { valid: false, reason: 'Giriş artıq qeydə alınıb!' };
    await sb.from('attendance').insert({ emp_id: MGR_ID, emp_name: mgrName, dept, timestamp: ts.toISOString(), type: 'GELIS', overtime: '', shift_type: '' });
    await U.sendTelegramMsg(`<b>Manager</b> işdə.\n${U.fmtTime(ts)}`, dept);
    return { valid: true, type: 'GELIS', time: U.fmtTime(ts) };
  }
  if (type === 'CIXIS') {
    const gelisRow = todayLogs.find(r => r.type === 'GELIS' || r.type === 'GƏLİŞ');
    if (!gelisRow) return { valid: false, reason: 'Əvvəlcə giriş qeydə alınmalıdır!' };
    if (todayLogs.some(r => r.type === 'CIXIS')) return { valid: false, reason: 'Çıxış artıq qeydə alınıb!' };
    const diffMs = ts.getTime() - new Date(gelisRow.timestamp).getTime();
    const dh = Math.floor(diffMs / 3600000), dm = Math.floor((diffMs % 3600000) / 60000);
    const dur = `${dh} saat ${dm} dəq`;
    await sb.from('attendance').insert({ emp_id: MGR_ID, emp_name: mgrName, dept, timestamp: ts.toISOString(), type: 'CIXIS', overtime: dur, shift_type: '' });
    await U.sendTelegramMsg(`<b>Manager</b> smendən çıxdı.\n${U.fmtTime(ts)} — ${dur}`, dept);
    return { valid: true, type: 'CIXIS', time: U.fmtTime(ts), duration: dur };
  }
  return { valid: false, reason: 'Yanlış əməliyyat.' };
};

API.getManagersLiveStatus = async () => {
  const todayStr = U.getLogicalDateStr(new Date());
  const { data: logs } = await sb.from('attendance').select('*').order('timestamp');
  const result = {};
  for (const dept of U.DEPTS) {
    const slug    = U.deptToSlug(dept);
    const mgrId   = 'MGR-' + dept.replace(/\s+/g, '');
    const deptLogs = (logs || []).filter(r => r.emp_id === mgrId && U.getLogicalDateStr(new Date(r.timestamp)) === todayStr);
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

const MGR_SLUGS = U.SLUGS;

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
  const { data } = await sb.from('checklist_items').select('*').order('sort_order');
  return (data || []).map(r => ({ ...r, itemId: r.item_id, active: !!r.active }));
};

API.saveChecklistItems = async (items) => {
  // Əvvəlcə hamısını sil
  const { error: delErr } = await sb.from('checklist_items').delete().neq('item_id', 'x');
  if (delErr) return { success: false, reason: 'Silmə xətası: ' + delErr.message };

  if (!items || !items.length) return { success: true };

  const incoming = items.map((item, i) => ({
    item_id:    String(item.itemId || item.item_id || ('CI-' + Date.now().toString(36).toUpperCase() + i)),
    text:       String(item.text || '').trim(),
    category:   String(item.category || 'Digər'),
    sort_order: i + 1,
    active:     item.active !== false,
  })).filter(r => r.text);

  if (!incoming.length) return { success: true };

  const { error: insErr } = await sb.from('checklist_items').insert(incoming);
  if (insErr) return { success: false, reason: 'Əlavə xətası: ' + insErr.message };

  return { success: true };
};

API.getChecklistForBranch = async (branchKey) => {
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return { valid: false, reason: 'İcazəsiz giriş.' };
  const today = U.toYMD(new Date());
  const [{ data: items }, { data: logs }] = await Promise.all([
    sb.from('checklist_items').select('*').eq('active', true).order('sort_order'),
    sb.from('checklist_logs').select('*').eq('date', today).eq('dept', check.dept),
  ]);
  const logMap = {};
  for (const r of logs || []) logMap[r.item_id] = r;
  return { valid: true, dept: check.dept, date: today, items: (items || []).map(item => {
    const log = logMap[item.item_id] || {};
    return {
      ...item,
      itemId:    item.item_id,
      active:    !!item.active,
      checked:   !!log.checked,
      checkedAt: log.checked_at || '',
      checked_at:log.checked_at || '',
      mgrNote:   log.mgr_note  || '',
      mgr_note:  log.mgr_note  || '',
      adminNote: log.admin_note|| '',
      admin_note:log.admin_note|| '',
    };
  }) };
};

API.submitChecklistItem = async (branchKey, itemId, checked, mgrNote) => {
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return { valid: false, reason: 'İcazəsiz giriş.' };
  const today = U.toYMD(new Date());
  const ts    = new Date();
  const { data: existing } = await sb.from('checklist_logs').select('log_id').eq('date', today).eq('dept', check.dept).eq('item_id', String(itemId)).single();
  if (existing) {
    await sb.from('checklist_logs').update({ checked: !!checked, checked_at: checked ? U.fmtTime(ts) : '', mgr_note: mgrNote || '' }).eq('log_id', existing.log_id);
  } else {
    const { data: itemRow } = await sb.from('checklist_items').select('text').eq('item_id', String(itemId)).single();
    await sb.from('checklist_logs').insert({ log_id: 'CL-' + Date.now().toString(36).toUpperCase(), date: today, dept: check.dept, item_id: itemId, item_text: itemRow?.text || '', checked: !!checked, checked_at: checked ? U.fmtTime(ts) : '', mgr_note: mgrNote || '', admin_note: '' });
  }
  return { valid: true, checkedAt: checked ? U.fmtTime(ts) : '', checked_at: checked ? U.fmtTime(ts) : '' };
};

API.getChecklistReport = async (dateStr) => {
  const date  = dateStr || U.toYMD(new Date());
  
  const [{ data: items }, { data: logs }] = await Promise.all([
    sb.from('checklist_items').select('*').eq('active', true).order('sort_order'),
    sb.from('checklist_logs').select('*').eq('date', date),
  ]);
  const report = {};
  for (const dept of U.DEPTS) {
    report[dept] = {};
    for (const item of items || []) report[dept][item.item_id] = { checked: false, checked_at: '', mgr_note: '', admin_note: '' };
  }
  for (const r of logs || []) {
    if (report[r.dept]?.[r.item_id] !== undefined) {
      report[r.dept][r.item_id] = {
        checked:    !!r.checked,
        checkedAt:  r.checked_at  || '', checked_at:  r.checked_at  || '',
        mgrNote:    r.mgr_note    || '', mgr_note:    r.mgr_note    || '',
        adminNote:  r.admin_note  || '', admin_note:  r.admin_note  || '',
      };
    }
  }
  return { date, items: (items || []).map(i => ({ ...i, itemId: i.item_id, active: !!i.active })), report };
};

API.saveAdminNote = async (dateStr, dept, itemId, adminNote) => {
  const date = dateStr || U.toYMD(new Date());
  const { data: existing } = await sb.from('checklist_logs').select('log_id').eq('date', date).eq('dept', dept).eq('item_id', String(itemId)).single();
  if (existing) {
    await sb.from('checklist_logs').update({ admin_note: adminNote || '' }).eq('log_id', existing.log_id);
  } else {
    const { data: itemRow } = await sb.from('checklist_items').select('text').eq('item_id', String(itemId)).single();
    await sb.from('checklist_logs').insert({ log_id: 'CL-' + Date.now().toString(36).toUpperCase(), date, dept, item_id: itemId, item_text: itemRow?.text || '', checked: false, checked_at: '', mgr_note: '', admin_note: adminNote || '' });
  }
  return { success: true };
};

// ── MENECER TƏSDİQ ───────────────────────────────────────────────

API.getMgrAckStatus = async (branchKey) => {
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return null;
  const { data } = await sb.from('mgr_acks').select('*').eq('date', U.toYMD(new Date())).eq('dept', check.dept).single();
  if (!data) return { globalAcked: false, globalAckedAt: '', branchAcked: false, branchAckedAt: '' };
  return { globalAcked: !!data.global_acked, globalAckedAt: data.global_acked_at || '', branchAcked: !!data.branch_acked, branchAckedAt: data.branch_acked_at || '' };
};

API.ackMgrMessage = async (branchKey, msgType) => {
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return { success: false };
  const today = U.toYMD(new Date()), ts = U.fmtTime(new Date());
  const { data: existing } = await sb.from('mgr_acks').select('ack_id').eq('date', today).eq('dept', check.dept).single();
  const upd = msgType === 'global' ? { global_acked: true, global_acked_at: ts } : { branch_acked: true, branch_acked_at: ts };
  if (existing) {
    await sb.from('mgr_acks').update(upd).eq('ack_id', existing.ack_id);
  } else {
    await sb.from('mgr_acks').insert({ ack_id: 'ACK-' + Date.now().toString(36).toUpperCase(), date: today, dept: check.dept, ...upd });
  }
  return { success: true, time: ts };
};

API.getMgrAcksForAdmin = async (dateStr) => {
  const date  = dateStr || U.toYMD(new Date());
  
  const { data } = await sb.from('mgr_acks').select('*').eq('date', date);
  const result = {};
  for (const d of U.DEPTS) result[d] = { globalAcked: false, globalAckedAt: '', branchAcked: false, branchAckedAt: '' };
  for (const r of data || []) {
    if (result[r.dept]) result[r.dept] = { globalAcked: !!r.global_acked, globalAckedAt: r.global_acked_at || '', branchAcked: !!r.branch_acked, branchAckedAt: r.branch_acked_at || '' };
  }
  return { date, acks: result };
};

// ── MƏHSULLAR ────────────────────────────────────────────────────

const WASTE_LIMITS = { 'Gənclik':2.5,'Ağ Şəhər':3.0,'Elmlər':3.5,'Sahil':4.0 };
function getWasteLimit(dept) { return WASTE_LIMITS[dept] ?? 3.0; }

API.getProducts = async () => {
  const { data } = await sb.from('products').select('*').eq('active', true).order('name');
  return (data || []).map(p => ({ productId: p.product_id, product_id: p.product_id, name: p.name, unit: p.unit }));
};

API.addProduct = async (name, unit) => {
  if (!name?.trim()) return { success: false, reason: 'Ad boş ola bilməz.' };
  const id = 'PRD-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substring(2,4).toUpperCase();
  const { error } = await sb.from('products').insert({ product_id: id, name: name.trim(), unit: unit || 'ədəd', active: true });
  return { success: !error, productId: id, product_id: id };
};

API.deleteProduct = async (productId) => {
  const { error } = await sb.from('products').update({ active: false }).eq('product_id', productId);
  return error ? { success: false, reason: 'Tapılmadı.' } : { success: true };
};

API.getProductLogsForBranch = async (branchKey, monthStr) => {
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return { valid: false };
  const { data: products } = await sb.from('products').select('*').eq('active', true);
  const { data: logs } = await sb.from('product_logs').select('*').eq('dept', check.dept).like('date_str', monthStr + '%');
  const totals = {};
  for (const r of logs || []) {
    if (!totals[r.product_id]) totals[r.product_id] = { incoming: 0, wasted: 0 };
    totals[r.product_id].incoming += Number(r.incoming) || 0;
    totals[r.product_id].wasted   += Number(r.wasted)   || 0;
  }
  let totalIn = 0, totalWasted = 0;
  const items = (products || []).map(p => {
    const t = totals[p.product_id] || { incoming:0, wasted:0 };
    totalIn += t.incoming; totalWasted += t.wasted;
    return { productId: p.product_id, product_id: p.product_id, name: p.name, unit: p.unit, totalIncoming: t.incoming, totalWasted: t.wasted };
  });
  const limit = getWasteLimit(check.dept);
  const pct   = totalIn > 0 ? Math.round(totalWasted / totalIn * 1000) / 10 : 0;
  return { valid: true, dept: check.dept, monthStr, items, limit, totalIn, totalWasted, pct, exceeded: totalIn > 0 && pct > limit };
};

API.saveProductLogs = async (branchKey, monthStr, logs) => {
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return { valid: false };
  const todayYMD = U.toYMD(new Date());
  const toInsert = (logs || []).filter(l => (l.product_id||l.productId) && (Number(l.incoming) || Number(l.wasted))).map(l => ({
    log_id: 'PL-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substring(2,4).toUpperCase(),
    date_str: todayYMD, dept: check.dept, product_id: l.product_id||l.productId, product_name: l.name||l.productName||'',
    incoming: Number(l.incoming) || 0, wasted: Number(l.wasted) || 0,
  }));
  if (toInsert.length) await sb.from('product_logs').insert(toInsert);
  const { data: allLogs } = await sb.from('product_logs').select('*').eq('dept', check.dept).like('date_str', monthStr + '%');
  let totalIn = 0, totalWasted = 0;
  for (const r of allLogs || []) { totalIn += Number(r.incoming)||0; totalWasted += Number(r.wasted)||0; }
  const limit = getWasteLimit(check.dept);
  const pct   = totalIn > 0 ? Math.round(totalWasted / totalIn * 1000) / 10 : 0;
  return { valid: true, pct, limit, exceeded: totalIn > 0 && pct > limit, totalIn, totalWasted };
};

API.getWasteStatsForAdmin = async (dateStr) => {
  
  const { data: logs } = await sb.from('product_logs').select('*').like('date_str', dateStr + '%');
  const deptMap = {};
  for (const d of U.DEPTS) deptMap[d] = { dept: d, totalIn:0, totalWasted:0, products:[], limit: getWasteLimit(d) };
  for (const r of logs || []) {
    if (!deptMap[r.dept] || (!r.incoming && !r.wasted)) continue;
    deptMap[r.dept].totalIn     += Number(r.incoming)||0;
    deptMap[r.dept].totalWasted += Number(r.wasted)  ||0;
    deptMap[r.dept].products.push({ name: r.product_name, incoming: Number(r.incoming)||0, wasted: Number(r.wasted)||0 });
  }
  return U.DEPTS.map(d => {
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
  const { data } = await sb.from('mgr_schedule').select('*').eq('dept', check.dept).in('date_str', dates);
  const map = {};
  for (const r of data || []) map[r.date_str] = r.shift_type;
  return { dept: check.dept, schedule: dates.map(ds => ({ date: ds, shiftType: map[ds] || '' })) };
};

API.saveMgrWeekSchedule = async (branchKey, entries) => {
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return { success: false, reason: 'İcazəsiz.' };
  const dates = entries.map(e => e.dateStr).filter(Boolean);
  if (dates.length) await sb.from('mgr_schedule').delete().eq('dept', check.dept).in('date_str', dates);
  const toInsert = entries.filter(e => e.dateStr && e.shiftType).map(e => ({
    sched_id: 'MS-' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random()*1000).toString(36).toUpperCase(),
    dept: check.dept, date_str: e.dateStr, shift_type: e.shiftType,
  }));
  if (toInsert.length) await sb.from('mgr_schedule').insert(toInsert);
  return { success: true };
};

API.getMgrScheduleForAdmin = async (weekStart) => {
  
  const start = new Date(weekStart);
  const dates = Array.from({length:7}, (_, d) => U.toYMD(new Date(start.getTime()+d*86400000)));
  const { data } = await sb.from('mgr_schedule').select('*').in('date_str', dates);
  const map = {};
  for (const dept of U.DEPTS) map[dept] = {};
  for (const r of data || []) { if (map[r.dept]) map[r.dept][r.date_str] = r.shift_type; }
  const DAY_NAMES = ['B.e.','Ç.a.','Çər.','C.a.','Cüm.','Şən.','Baz.'];
  return {
    dates: dates.map(ds => { const dd=new Date(ds); return {date:ds,dayName:DAY_NAMES[dd.getDay()===0?6:dd.getDay()-1]}; }),
    managers: U.DEPTS.map(dept => ({ dept, mgrName: U.getSetting('MGR_NAME_'+U.deptToSlug(dept))||dept, schedule: dates.map(ds=>map[dept][ds]||'') })),
  };
};

// ── GEC GƏLİŞ İCAZƏSİ ────────────────────────────────────────────

API.requestLatePerm = async (secret, dateStr, requestedTime) => {
  if (!secret||!dateStr||!requestedTime) return { success:false, reason:'Məlumatlar natamamdır.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return { success:false, reason:'Tarix formatı yanlışdır.' };
  if (!/^\d{2}:\d{2}$/.test(requestedTime)) return { success:false, reason:'Vaxt formatı yanlışdır.' };
  const { data: emp } = await sb.from('employees').select('*').eq('secret', secret).single();
  if (!emp) return { success:false, reason:'İşçi tapılmadı.' };
  const { data: existing } = await sb.from('late_perms').select('status').eq('emp_id', String(emp.id)).eq('date_str', dateStr).single();
  if (existing && (existing.status==='pending'||existing.status==='approved')) return { success:false, reason:'Bu tarix üçün artıq icazəniz mövcuddur.' };
  const permId = 'LP-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substring(2,5).toUpperCase();
  await sb.from('late_perms').insert({ perm_id: permId, emp_id:emp.id, emp_name:emp.name, dept:emp.dept, date_str:dateStr, requested_time:requestedTime, status:'pending' });
  return { success:true, permId };
};

API.getLatePermsForManager = async (branchKey) => {
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return [];

  // İki ayrı sorğu: dept adına görə VƏ filialın işçi ID-lərinə görə
  // (dept string-ində xüsusi hərflər olduğu üçün .or() işlətmirik)
  const { data: empRows } = await sb.from('employees').select('id').eq('dept', check.dept);
  const empIds = (empRows || []).map(e => String(e.id));

  const [{ data: byDept }, { data: byEmpId }] = await Promise.all([
    sb.from('late_perms').select('*').eq('dept', check.dept)
      .order('created_at', { ascending: false }).limit(50),
    empIds.length
      ? sb.from('late_perms').select('*').in('emp_id', empIds)
          .order('created_at', { ascending: false }).limit(50)
      : Promise.resolve({ data: [] }),
  ]);

  // Birləşdir, təkrarları sil (perm_id-ə görə)
  const seen = new Set();
  const merged = [...(byDept || []), ...(byEmpId || [])].filter(r => {
    if (seen.has(r.perm_id)) return false;
    seen.add(r.perm_id);
    return true;
  });

  return merged.map(r => ({
    permId:        r.perm_id,
    empId:         r.emp_id,
    empName:       r.emp_name,
    dept:          r.dept,
    dateStr:       r.date_str,
    requestedTime: r.requested_time,
    status:        r.status,
    createdAt:     r.created_at,
  })).sort((a, b) => {
    if (a.status === 'pending' && b.status !== 'pending') return -1;
    if (a.status !== 'pending' && b.status === 'pending') return  1;
    return (b.createdAt || '').localeCompare(a.createdAt || '');
  });
};

API.approveLatePerm = async (branchKey, permId, action) => {
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return { success: false, reason: 'İcazəsiz.' };
  if (action !== 'approved' && action !== 'rejected') return { success: false, reason: 'Yanlış əməliyyat.' };
  // dept şərti olmadan yalnız perm_id-ə görə yenilə
  const { error, count } = await sb.from('late_perms')
    .update({ status: action, approved_at: new Date().toISOString() })
    .eq('perm_id', permId);
  return { success: !error, updated: count };
};

API.getMyLatePerms = async (secret) => {
  if (!secret) return [];
  const { data:emp } = await sb.from('employees').select('id').eq('secret',secret).single();
  if (!emp) return [];
  const today = U.toYMD(new Date());
  const { data } = await sb.from('late_perms').select('perm_id,date_str,requested_time,status').eq('emp_id',String(emp.id)).gte('date_str',today).order('date_str').limit(5);
  return (data || []).map(r => ({
    permId:        r.perm_id,
    dateStr:       r.date_str,
    requestedTime: r.requested_time,
    status:        r.status,
  }));
};

// ── AVANS ────────────────────────────────────────────────────────

API.requestAvans = async (secret, amount, note) => {
  if (!secret) return { success: false, reason: 'İcazəsiz giriş.' };
  const amt = parseFloat(amount);
  if (!amt || amt <= 0 || amt > 1000) return { success: false, reason: 'Məbləğ 1–1000 AZN aralığında olmalıdır.' };

  const { data: emp } = await sb.from('employees').select('id,name,dept').eq('secret', secret).single();
  if (!emp) return { success: false, reason: 'İşçi tapılmadı.' };

  // Eyni gün artıq tələb göndərilib?
  const today = U.toYMD(new Date());
  const { data: existing } = await sb.from('avans')
    .select('status').eq('emp_id', String(emp.id)).eq('date_str', today).single();
  if (existing && (existing.status === 'pending' || existing.status === 'approved')) {
    return { success: false, reason: 'Bu gün üçün artıq avans tələbiniz mövcuddur.' };
  }

  const id = 'AV-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substring(2, 5).toUpperCase();
  const { error } = await sb.from('avans').insert({
    avans_id:   id,
    emp_id:     String(emp.id),
    emp_name:   emp.name,
    dept:       emp.dept,
    amount:     amt,
    note:       (note || '').slice(0, 120),
    status:     'pending',
    date_str:   today,
  });
  if (error) { sbErr('requestAvans', error); return { success: false, reason: 'Xəta baş verdi.' }; }

  await U.sendTelegramMsg(
    `💵 <b>Avans Tələbi</b>\n\n👤 <b>${emp.name}</b> (${emp.dept})\n💰 Məbləğ: <b>${amt} AZN</b>` +
    (note ? `\n📝 Qeyd: ${note}` : ''),
    emp.dept
  );
  return { success: true };
};

API.getMyAvansList = async (secret) => {
  if (!secret) return [];
  const { data: emp } = await sb.from('employees').select('id').eq('secret', secret).single();
  if (!emp) return [];
  const { data } = await sb.from('avans')
    .select('avans_id,amount,note,status,date_str,created_at')
    .eq('emp_id', String(emp.id))
    .order('created_at', { ascending: false })
    .limit(10);
  return (data || []).map(r => ({
    avansId:   r.avans_id,
    amount:    r.amount,
    note:      r.note      || '',
    status:    r.status,
    dateStr:   r.date_str,
    createdAt: r.created_at || '',
  }));
};

// Admin üçün: bütün avans tələblərini al
API.getAvansList = async () => {
  const { data } = await sb.from('avans')
    .select('*').order('created_at', { ascending: false }).limit(100);
  return (data || []).map(r => ({
    avansId:   r.avans_id,
    empId:     r.emp_id,
    empName:   r.emp_name,
    dept:      r.dept,
    amount:    r.amount,
    note:      r.note      || '',
    status:    r.status,
    dateStr:   r.date_str,
    createdAt: r.created_at || '',
  }));
};

// Admin üçün: avans statusunu dəyişdir
API.updateAvansStatus = async (avansId, status) => {
  if (!['approved', 'rejected', 'paid'].includes(status))
    return { success: false, reason: 'Yanlış status.' };
  // Yalnız avans_id-ə görə yenilə — dept şərti yoxdur
  const { error } = await sb.from('avans').update({ status }).eq('avans_id', avansId);
  return { success: !error };
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

// ── PROFİL ────────────────────────────────────────────────────────

API.getMyProfile = async (secret) => {
  if (!secret) return null;
  const { data: emp } = await sb.from('employees').select('id,name,dept,is_test,streak,xp').eq('secret', secret).single();
  if (!emp) return null;
  const isTest = emp.is_test === true;
  const { data: p } = await sb.from('profiles').select('*').eq('emp_id', emp.id).single();
  return {
    empId: emp.id, empName: emp.name, dept: emp.dept,
    testMode:    isTest,
    streak:      isTest ? 999 : (emp.streak || 0),
    xp:          isTest ? 999999 : (emp.xp || 0),
    avatarType:  p?.avatar_type  || 'preset',
    avatarValue: p?.avatar_value || 'mug-hot',
    accentColor: p?.accent_color || '#5b5ef4',
    bio:         p?.bio          || '',
    photoData:   p?.photo_data   || '',
    bannerStyle: p?.banner_style || 'none',
    cardTheme:   p?.card_theme   || 'glass',
    glowEffect:  p?.glow_effect  || 'none',
    frameStyle:  p?.frame_style  || 'none',
  };
};

API.saveProfile = async (secret, data) => {
  if (!secret) return { success: false };
  const { data: emp } = await sb.from('employees').select('id').eq('secret', secret).single();
  if (!emp) return { success: false };
  const { error } = await sb.from('profiles').upsert({
    emp_id:       emp.id,
    avatar_type:  data.avatarType  || 'preset',
    avatar_value: data.avatarValue || 'mug-hot',
    accent_color: data.accentColor || '#5b5ef4',
    bio:          (data.bio || '').slice(0, 80),
    photo_data:   data.photoData   || '',
    banner_style: data.bannerStyle || 'none',
    card_theme:   data.cardTheme   || 'glass',
    glow_effect:  data.glowEffect  || 'none',
    frame_style:  data.frameStyle  || 'none',
    updated_at:   new Date().toISOString(),
  }, { onConflict: 'emp_id' });
  sbErr('saveProfile', error);
  return { success: !error };
};

API.getTeamProfiles = async (secret) => {
  if (!secret) return [];
  const { data: caller } = await sb.from('employees').select('id').eq('secret', secret).single();
  if (!caller) return [];
  const { data: emps } = await sb.from('employees').select('id,name,dept,is_test,streak,xp').order('name');
  const { data: profiles } = await sb.from('profiles').select('*');
  const pm = {};
  for (const p of profiles || []) pm[p.emp_id] = p;
  const result = (emps || []).map(e => ({
    empId:       e.id,
    empName:     e.name,
    dept:        e.dept,
    streak:      e.is_test ? 999 : (e.streak || 0),
    xp:          e.is_test ? 999999 : (e.xp || 0),
    avatarType:  pm[e.id]?.avatar_type  || 'preset',
    avatarValue: pm[e.id]?.avatar_value || 'mug-hot',
    accentColor: pm[e.id]?.accent_color || '#5b5ef4',
    bio:         pm[e.id]?.bio          || '',
    photoData:   pm[e.id]?.photo_data   || '',
    bannerStyle: pm[e.id]?.banner_style || 'none',
    cardTheme:   pm[e.id]?.card_theme   || 'glass',
    glowEffect:  pm[e.id]?.glow_effect  || 'none',
    frameStyle:  pm[e.id]?.frame_style  || 'none',
  }));
  return result;
};

// ── STREAK BACKFILL ───────────────────────────────────────────────

API.recalcAllStreaks = async () => {
  const { data: emps } = await sb.from('employees').select('id,dept,is_test');
  let updated = 0;
  for (const emp of emps || []) {
    if (emp.is_test) continue;
    const streak = await U.calcStreak(emp.id, emp.dept);
    await sb.from('employees').update({ streak }).eq('id', emp.id);
    updated++;
  }
  return { success: true, updated };
};

// ── REAKSİYALAR ──────────────────────────────────────────────────

API.getReactions = async (secret) => {
  const { data: caller } = await sb.from('employees').select('id').eq('secret', secret).single();
  if (!caller) return {};
  const { data: rows } = await sb.from('reactions').select('*');
  const result = {};
  for (const r of rows || []) {
    if (!result[r.to_emp_id]) result[r.to_emp_id] = { like:0, love:0, fire:0, angry:0, mine:null };
    result[r.to_emp_id][r.type] = (result[r.to_emp_id][r.type] || 0) + 1;
    if (r.from_emp_id === caller.id) result[r.to_emp_id].mine = r.type;
  }
  return result;
};

API.toggleReaction = async (secret, toEmpId, type) => {
  const VALID = ['like'];
  if (!VALID.includes(type)) return { ok: false };
  const { data: caller } = await sb.from('employees').select('id').eq('secret', secret).single();
  if (!caller || caller.id === toEmpId) return { ok: false };
  const { data: existing } = await sb.from('reactions')
    .select('*').eq('from_emp_id', caller.id).eq('to_emp_id', toEmpId).single();
  if (existing) {
    if (existing.type === type) {
      await sb.from('reactions').delete().eq('from_emp_id', caller.id).eq('to_emp_id', toEmpId);
    } else {
      await sb.from('reactions').update({ type }).eq('from_emp_id', caller.id).eq('to_emp_id', toEmpId);
    }
  } else {
    await sb.from('reactions').insert({ from_emp_id: caller.id, to_emp_id: toEmpId, type });
  }
  return { ok: true };
};

API.getPublicProfile = async (secret, targetEmpId) => {
  if (!secret || !targetEmpId) return null;
  const { data: caller } = await sb.from('employees').select('id').eq('secret', secret).single();
  if (!caller) return null;
  const { data: emp } = await sb.from('employees').select('id,name,dept,is_test,streak,xp').eq('id', targetEmpId).single();
  if (!emp) return null;
  const targetIsTest = emp.is_test === true;
  const { data: p } = await sb.from('profiles').select('*').eq('emp_id', emp.id).single();
  const streak = targetIsTest ? 999 : (emp.streak || 0);
  const now = new Date();
  const report = await API.getMonthlyReport(now.getFullYear(), now.getMonth() + 1);
  const myR = report.find(r => r.empId === emp.id) || { totalDays: 0, onTime: 0, late: 0, pct: 0 };
  return {
    empId: emp.id, empName: emp.name, dept: emp.dept, streak,
    xp:          targetIsTest ? 999999 : (emp.xp || 0),
    avatarType:  p?.avatar_type  || 'preset',
    avatarValue: p?.avatar_value || 'mug-hot',
    accentColor: p?.accent_color || '#5b5ef4',
    bio:         p?.bio          || '',
    photoData:   p?.photo_data   || '',
    bannerStyle: p?.banner_style || 'none',
    cardTheme:   p?.card_theme   || 'glass',
    glowEffect:  p?.glow_effect  || 'none',
    frameStyle:  p?.frame_style  || 'none',
    stats: { days: myR.totalDays, onTime: myR.onTime, late: myR.late, pct: myR.pct },
  };
};

// ── TƏCİLİ BİLDİRİŞ ─────────────────────────────────────────────

API.sendEmergency = async (secret, message) => {
  if (!secret || !message?.trim()) return { success: false, reason: 'Məlumatlar natamamdır.' };
  const { data: emp } = await sb.from('employees').select('id,name,dept').eq('secret', secret).single();
  if (!emp) return { success: false, reason: 'İşçi tapılmadı.' };
  const text = `🚨 <b>TƏCİLİ BİLDİRİŞ</b>\n\n👤 <b>${emp.name}</b> (${emp.dept})\n\n💬 ${message.trim()}`;
  await U.sendTelegramMsg(text, emp.dept);
  return { success: true };
};

API.deleteAnnouncement = async (id) => {
  const { error } = await sb.from('announcements').delete().eq('id',id);
  return { ok:!error };
};

// ── MENECER DASHBOARD ─────────────────────────────────────────────

API.getAvansForManager = async (branchKey) => {
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return [];

  const { data: empRows } = await sb.from('employees').select('id').eq('dept', check.dept);
  const empIds = (empRows || []).map(e => String(e.id));

  const [{ data: byDept }, { data: byEmpId }] = await Promise.all([
    sb.from('avans').select('*').eq('dept', check.dept)
      .order('created_at', { ascending: false }).limit(50),
    empIds.length
      ? sb.from('avans').select('*').in('emp_id', empIds)
          .order('created_at', { ascending: false }).limit(50)
      : Promise.resolve({ data: [] }),
  ]);

  const seen = new Set();
  const merged = [...(byDept || []), ...(byEmpId || [])].filter(r => {
    if (seen.has(r.avans_id)) return false;
    seen.add(r.avans_id);
    return true;
  });

  return merged.map(r => ({
    avansId:   r.avans_id,
    empName:   r.emp_name,
    dept:      r.dept,
    amount:    r.amount,
    note:      r.note      || '',
    status:    r.status,
    dateStr:   r.date_str,
    createdAt: r.created_at || '',
  })).sort((a, b) => {
    if (a.status === 'pending' && b.status !== 'pending') return -1;
    if (a.status !== 'pending' && b.status === 'pending') return  1;
    return b.createdAt.localeCompare(a.createdAt);
  });
};

API.getManagerDashboard = async (branchKey, weekStart) => {
  const check = U.validateBranchScheduleKey(branchKey);
  if (!check.valid) return null;
  const safe = (p) => p.catch(() => null);
  const [cedvel, mgrInfo, ackStatus, mgrSched, latePerms, avansList] = await Promise.all([
    safe(API.getCedvel(check.dept, weekStart)),
    Promise.resolve(API.getMgrInfoForBranch(branchKey)),
    safe(API.getMgrAckStatus(branchKey)),
    safe(API.getMgrWeekSchedule(branchKey, weekStart)),
    safe(API.getLatePermsForManager(branchKey)),
    safe(API.getAvansForManager(branchKey)),
  ]);
  return {
    cedvel:    cedvel    || [],
    mgrInfo:   mgrInfo   || null,
    ackStatus: ackStatus || null,
    mgrSched:  mgrSched  || null,
    latePerms: latePerms || [],
    avansList: avansList || [],
  };
};

// ══════════════════════════════════════════════════════════════════
//  TREYNİNQ MANECERİ API
// ══════════════════════════════════════════════════════════════════

API.getTrainerKey = async () => {
  let key = U.getSetting('TRAINER_KEY');
  if (!key) {
    key = 'TR' + Math.random().toString(36).substring(2, 12).toUpperCase();
    await U.setSetting('TRAINER_KEY', key);
  }
  const name = U.getSetting('TRAINER_NAME') || '';
  return { key, name };
};

API.setTrainerName = async (name) => {
  await U.setSetting('TRAINER_NAME', String(name || '').trim());
  return { success: true };
};

API.regenerateTrainerKey = async () => {
  const key = 'TR' + Math.random().toString(36).substring(2, 12).toUpperCase();
  await U.setSetting('TRAINER_KEY', key);
  return { key };
};

API.getAllTrainerItems = async () => {
  const { data } = await sb.from('trainer_checklist_items').select('*').order('sort_order');
  return (data || []).map(r => ({ id: r.item_id, text: r.text, category: r.category || '', active: r.active !== false }));
};

API.getActiveTrainerItems = async () => {
  const { data } = await sb.from('trainer_checklist_items').select('*').eq('active', true).order('sort_order');
  return (data || []).map(r => ({ id: r.item_id, text: r.text, category: r.category || '' }));
};

API.saveTrainerItems = async (items) => {
  await sb.from('trainer_checklist_items').delete().neq('item_id', 'x');
  if (items && items.length) {
    const rows = items.map((item, i) => ({
      item_id:    item.id || ('TCI-' + Date.now().toString(36).toUpperCase() + i),
      text:       String(item.text || '').trim(),
      category:   item.category || '',
      active:     item.active !== false,
      sort_order: i,
    }));
    await sb.from('trainer_checklist_items').insert(rows);
  }
  return { success: true };
};

API.getEmployeesByDept = async (dept) => {
  const { data } = await sb.from('employees').select('id,name,dept').order('name');
  return (data || []).filter(r => r.dept === dept).map(r => ({ id: r.id, name: r.name }));
};

API.submitTrainerLog = async (trainerKey, trainerName, dept, empId, empName, items, note) => {
  if (!U.getSetting('TRAINER_KEY') || U.getSetting('TRAINER_KEY') !== trainerKey)
    return { success: false, reason: 'İcazəsiz əməliyyat.' };
  const ts    = new Date();
  const logId = 'TL-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substring(2, 4).toUpperCase();
  await sb.from('trainer_logs').insert({
    log_id:       logId,
    trainer_name: String(trainerName || 'Naməlum').trim(),
    dept,
    emp_id:       String(empId),
    emp_name:     String(empName || ''),
    date_str:     U.getLogicalYMD(ts),
    items:        items || [],
    general_note: note || '',
    created_at:   ts.toISOString(),
  });
  return { success: true };
};

API.getTodayTrainerLogs = async (trainerKey) => {
  if (!U.getSetting('TRAINER_KEY') || U.getSetting('TRAINER_KEY') !== trainerKey)
    return { logs: [] };
  const date = U.getLogicalYMD(new Date());
  const { data } = await sb.from('trainer_logs').select('*').eq('date_str', date).order('created_at', { ascending: false });
  return { logs: data || [] };
};

API.getTrainerLogs = async (dateStr) => {
  const date = dateStr || U.getLogicalYMD(new Date());
  const { data } = await sb.from('trainer_logs').select('*').eq('date_str', date).order('created_at', { ascending: false });
  return { date, logs: data || [] };
};

// ── İMTAHAN ──────────────────────────────────────────────────────

API.submitExam = async (trainerKey, trainerName, dept, empId, empName, score, maxScore, answers, note) => {
  if (!U.getSetting('TRAINER_KEY') || U.getSetting('TRAINER_KEY') !== trainerKey)
    return { success: false, reason: 'İcazəsiz əməliyyat.' };
  const ts     = new Date();
  const examId = 'EX-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substring(2, 4).toUpperCase();
  const { error } = await sb.from('trainer_exams').insert({
    exam_id:      examId,
    trainer_name: String(trainerName || 'Naməlum').trim(),
    dept,
    emp_id:       String(empId),
    emp_name:     String(empName   || ''),
    score:        Number(score)    || 0,
    max_score:    Number(maxScore) || 100,
    answers:      answers          || [],
    note:         note             || '',
    date_str:     U.getLogicalYMD(ts),
    created_at:   ts.toISOString(),
  });
  sbErr('submitExam', error);
  return { success: !error, reason: error?.message };
};

API.giveManualXP = async (trainerKey, empId, amount) => {
  if (!U.getSetting('TRAINER_KEY') || U.getSetting('TRAINER_KEY') !== trainerKey)
    return { success: false, reason: 'İcazəsiz.' };
  const amt = parseInt(amount);
  if (!empId || isNaN(amt) || amt < 1 || amt > 500)
    return { success: false, reason: 'Məbləğ 1–500 arasında olmalıdır.' };
  const { data: emp } = await sb.from('employees').select('name,dept,is_test').eq('id', String(empId)).single();
  if (!emp || emp.is_test) return { success: false, reason: 'İşçi tapılmadı.' };
  await awardXP(empId, amt, 0);
  const trainerName = U.getSetting('TRAINER_NAME') || 'Trainer';
  await sb.from('xp_audit_log').insert({
    trainer_name: trainerName, emp_id: String(empId), emp_name: emp.name,
    dept: emp.dept, amount: amt, type: 'manual', stars: null,
    created_at: new Date().toISOString(),
  });
  return { success: true, xp: amt };
};

API.rateEmployee = async (trainerKey, empId, stars) => {
  if (!U.getSetting('TRAINER_KEY') || U.getSetting('TRAINER_KEY') !== trainerKey)
    return { success: false, reason: 'İcazəsiz.' };
  const XP_MAP = { 3: 15, 4: 30, 5: 50 };
  const xp = XP_MAP[parseInt(stars)];
  if (!empId || !xp) return { success: false, reason: 'Yanlış məlumat.' };
  const { data: emp } = await sb.from('employees').select('name,dept,is_test').eq('id', String(empId)).single();
  if (!emp || emp.is_test) return { success: false, reason: 'İşçi tapılmadı.' };
  await awardXP(empId, xp, 0);
  const trainerName = U.getSetting('TRAINER_NAME') || 'Trainer';
  await sb.from('xp_audit_log').insert({
    trainer_name: trainerName, emp_id: String(empId), emp_name: emp.name,
    dept: emp.dept, amount: xp, type: 'rating', stars: parseInt(stars),
    created_at: new Date().toISOString(),
  });
  return { success: true, xp };
};

API.getXPAuditLog = async () => {
  const { data } = await sb.from('xp_audit_log')
    .select('*').order('created_at', { ascending: false }).limit(200);
  return { rows: data || [] };
};

API.gradeOpenAnswer = async (trainerKey, examId, questionId, passed) => {
  if (!U.getSetting('TRAINER_KEY') || U.getSetting('TRAINER_KEY') !== trainerKey)
    return { success: false, reason: 'İcazəsiz.' };
  if (!examId || !questionId || typeof passed !== 'boolean')
    return { success: false, reason: 'Məlumatlar natamamdır.' };

  const { data: rows, error: fetchErr } = await sb.from('trainer_exams').select('*').eq('exam_id', examId).limit(1);
  if (fetchErr || !rows?.length) return { success: false, reason: 'İmtahan tapılmadı.' };

  const exam = rows[0];
  const answers = (exam.answers || []).map(a =>
    a.questionId === questionId && a.type === 'open' ? { ...a, passed } : a
  );
  const score = answers.filter(a => a.passed === true).length;

  const { error } = await sb.from('trainer_exams').update({ answers, score }).eq('exam_id', examId);
  sbErr('gradeOpenAnswer', error);
  if (!error && passed) {
    const { data: empRow } = await sb.from('employees').select('streak,is_test').eq('id', String(exam.emp_id)).single();
    if (empRow && !empRow.is_test) await awardXP(exam.emp_id, 15, empRow.streak || 0);
  }
  return { success: !error, score, answers };
};

API.getTodayExams = async (trainerKey) => {
  if (!U.getSetting('TRAINER_KEY') || U.getSetting('TRAINER_KEY') !== trainerKey)
    return { exams: [] };
  const date = U.getLogicalYMD(new Date());
  const { data } = await sb.from('trainer_exams').select('*').eq('date_str', date).order('created_at', { ascending: false });
  return { exams: data || [] };
};

API.getExamLogs = async (dateStr) => {
  const date = dateStr || U.getLogicalYMD(new Date());
  const { data } = await sb.from('trainer_exams').select('*').eq('date_str', date).order('created_at', { ascending: false });
  return { date, exams: data || [] };
};

// ── TƏLİM MATERİALLARI (Trainer öz materialları) ─────────────────

API.getTrainerMaterials = async () => {
  const { data } = await sb.from('trainer_materials').select('*').eq('active', true).order('sort_order');
  return (data || []).map(m => ({
    materialId: m.material_id,
    title:      m.title,
    body:       m.body     || '',
    category:   m.category || '',
  }));
};

API.saveTrainerMaterial = async (trainerKey, material) => {
  if (!U.getSetting('TRAINER_KEY') || U.getSetting('TRAINER_KEY') !== trainerKey)
    return { success: false, reason: 'İcazəsiz.' };
  if (!material?.title?.trim()) return { success: false, reason: 'Başlıq boş ola bilməz.' };
  const { data: last } = await sb.from('trainer_materials')
    .select('sort_order').eq('active', true).order('sort_order', { ascending: false }).limit(1);
  const sortOrder = (last?.length ? last[0].sort_order : 0) + 1;
  const id = 'TM-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substring(2, 4).toUpperCase();
  const { error } = await sb.from('trainer_materials').insert({
    material_id: id,
    title:       material.title.trim(),
    body:        (material.body     || '').trim(),
    category:    (material.category || '').trim(),
    active:      true,
    sort_order:  sortOrder,
  });
  sbErr('saveTrainerMaterial', error);
  return { success: !error, materialId: id };
};

API.deleteTrainerMaterial = async (trainerKey, materialId) => {
  if (!U.getSetting('TRAINER_KEY') || U.getSetting('TRAINER_KEY') !== trainerKey)
    return { success: false };
  const { error } = await sb.from('trainer_materials').update({ active: false }).eq('material_id', materialId);
  return { success: !error };
};

// ── İMTAHAN SUALLARI (Trainer öz sualları) ───────────────────────

API.getExamQuestions = async () => {
  const { data } = await sb.from('exam_questions').select('*').eq('active', true).order('sort_order');
  return (data || []).map(q => ({
    questionId: q.question_id,
    text:       q.text,
    type:       q.type,
    options:    q.options  || [],
    correct:    q.correct  || '',
    category:   q.category || '',
    role:       q.role     || 'umumi',
  }));
};

API.saveExamQuestion = async (trainerKey, question) => {
  if (!U.getSetting('TRAINER_KEY') || U.getSetting('TRAINER_KEY') !== trainerKey)
    return { success: false, reason: 'İcazəsiz.' };
  if (!question?.text?.trim()) return { success: false, reason: 'Sual mətni boş ola bilməz.' };
  if (question.type === 'test') {
    const opts = (question.options || []).filter(o => o.text?.trim());
    if (opts.length < 2) return { success: false, reason: 'Test üçün ən azı 2 variant lazımdır.' };
    if (!question.correct) return { success: false, reason: 'Düzgün cavabı seçin.' };
  }
  const { data: last } = await sb.from('exam_questions')
    .select('sort_order').eq('active', true).order('sort_order', { ascending: false }).limit(1);
  const sortOrder = (last?.length ? last[0].sort_order : 0) + 1;
  const id = 'EQ-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substring(2, 4).toUpperCase();
  const { error } = await sb.from('exam_questions').insert({
    question_id: id,
    text:        question.text.trim(),
    type:        question.type || 'open',
    options:     question.options || [],
    correct:     question.correct || '',
    category:    (question.category || '').trim(),
    role:        ['kassir','barista','umumi'].includes(question.role) ? question.role : 'umumi',
    active:      true,
    sort_order:  sortOrder,
  });
  sbErr('saveExamQuestion', error);
  return { success: !error, questionId: id };
};

API.deleteExamQuestion = async (trainerKey, questionId) => {
  if (!U.getSetting('TRAINER_KEY') || U.getSetting('TRAINER_KEY') !== trainerKey)
    return { success: false };
  const { error } = await sb.from('exam_questions').update({ active: false }).eq('question_id', questionId);
  return { success: !error };
};

// ── İŞÇİ ÖZÜ İMTAHAN ────────────────────────────────────────────

API.getExamStatus = async () => ({
  active: U.getSetting('EXAM_ACTIVE') === 'true',
});

API.setExamStatus = async (trainerKey, active) => {
  if (!U.getSetting('TRAINER_KEY') || U.getSetting('TRAINER_KEY') !== trainerKey)
    return { success: false };
  await U.setSetting('EXAM_ACTIVE', active ? 'true' : 'false');
  return { success: true, active };
};

// Düzgün cavablar göndərilmir — test + açıq suallar birlikdə qaytarılır
API.getExamQuestionsPublic = async (role) => {
  if (!['kassir','barista'].includes(role)) return [];
  const { data } = await sb.from('exam_questions')
    .select('question_id,text,type,options,category,role')
    .eq('active', true).order('sort_order');
  return (data || [])
    .filter(q => q.role === role || q.role === 'umumi')
    .map(q => ({
      questionId: q.question_id,
      text:       q.text,
      type:       q.type,
      options:    q.type === 'test' ? (q.options || []) : [],
      category:   q.category || '',
      role:       q.role     || 'umumi',
    }));
};

// Server-side qiymətləndirmə: test → avtomatik, açıq → saxlanır (null)
API.submitEmployeeExam = async (empId, empName, dept, role, answers) => {
  if (!empId || !empName || !dept || !role || !answers?.length)
    return { success: false, reason: 'Məlumatlar natamamdır.' };

  const testIds = answers.filter(a => a.type === 'test').map(a => a.questionId).filter(Boolean);
  const cMap = {};
  if (testIds.length) {
    const { data: qs } = await sb.from('exam_questions')
      .select('question_id,correct').in('question_id', testIds);
    for (const q of qs || []) cMap[q.question_id] = q.correct;
  }

  let score = 0, testTotal = 0;
  const graded = answers.map(a => {
    if (a.type === 'test') {
      testTotal++;
      const correct = cMap[a.questionId] || '';
      const passed  = !!correct && a.given === correct;
      if (passed) score++;
      return { questionId:a.questionId, text:a.text, category:a.category,
               options:a.options||[], correct, given:a.given||null, passed, type:'test' };
    } else {
      // Açıq sual — mətni saxla, qiymət trainer tərəfindən
      return { questionId:a.questionId, text:a.text, category:a.category,
               options:[], correct:'', given:null, givenText:a.givenText||'', passed:null, type:'open' };
    }
  });

  const ts     = new Date();
  const examId = 'EX-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substring(2,4).toUpperCase();
  const { error } = await sb.from('trainer_exams').insert({
    exam_id:      examId,
    trainer_name: 'Özü',
    dept,
    emp_id:       String(empId),
    emp_name:     String(empName),
    score,
    max_score:    graded.length,
    answers:      graded,
    note:         '',
    date_str:     U.getLogicalYMD(ts),
    created_at:   ts.toISOString(),
  });
  sbErr('submitEmployeeExam', error);
  if (!error && testTotal > 0) {
    const pct = Math.round(score / testTotal * 100);
    const xpBase = pct >= 90 ? 100 : pct >= 80 ? 75 : pct >= 60 ? 50 : 0;
    if (xpBase > 0) {
      const { data: empRow } = await sb.from('employees').select('streak,is_test').eq('id', String(empId)).single();
      if (empRow && !empRow.is_test) await awardXP(empId, xpBase, empRow.streak || 0);
    }
  }
  return { success: !error, score, maxScore: testTotal, answers: graded };
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
      const trKey = await API.getTrainerKey();
      console.log(`🎓  Treynər: http://localhost:${PORT}/trainer?key=${trKey.key}`);
    });
  } catch (e) {
    console.error('❌  Başlama xətası:', e.message);
    process.exit(1);
  }
})();