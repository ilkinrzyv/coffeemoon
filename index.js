require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

app.get('/', (req, res) => {
  res.redirect('/admin.html');
});

const ADMIN_KEY = process.env.ADMIN_KEY || 'coffeemoon';
const TIME_STEP = 10000;

// ── PIN GENERASIYA ─────────────────────────────────────────
function generatePin(secret, timeWin) {
  let str = secret.toString() + timeWin.toString();
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  hash ^= (hash << 13); hash ^= (hash >>> 17); hash ^= (hash << 5);
  return (Math.abs(Math.imul(hash, 1664525) + 1013904223) % 10000)
    .toString().padStart(4, '0');
}

function currentTimeWindow() {
  return Math.floor(Date.now() / TIME_STEP);
}

// ── İŞÇİLƏR ────────────────────────────────────────────────
app.get('/api/employees', async (req, res) => {
  const { data, error } = await supabase.from('employees').select('*').eq('active', true);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/employees', async (req, res) => {
  const { name, dept } = req.body;
  if (!name || !dept) return res.status(400).json({ error: 'Ad və şöbə lazımdır' });
  const id = 'emp_' + Date.now();
  const secret = Math.random().toString(36).slice(2, 10).toUpperCase();
  const { data, error } = await supabase.from('employees').insert([{ id, name, dept, secret }]).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/employees/:id', async (req, res) => {
  const { error } = await supabase.from('employees').update({ active: false }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── PIN YOXLAMA (SCAN) ─────────────────────────────────────
app.post('/api/validate', async (req, res) => {
  const { pin, deviceId, branch } = req.body;
  const tw = currentTimeWindow();

  const { data: emps } = await supabase.from('employees').select('*').eq('active', true);
  const matched = emps?.find(e =>
    generatePin(e.secret, tw) === pin ||
    generatePin(e.secret, tw - 1) === pin
  );

  if (!matched) return res.json({ valid: false, reason: 'PIN yanlışdır' });

  // Cihaz yoxla / qeydə al
  const { data: device } = await supabase.from('scan_devices').select('*').eq('device_id', deviceId).single();
  if (!device) {
    await supabase.from('scan_devices').insert([{ device_id: deviceId, branch: branch || 'Naməlum', status: 'pending' }]);
  } else if (device.status === 'blocked') {
    return res.json({ valid: false, reason: 'Bu cihaz bloklanıb' });
  }

  // Bu gün artıq qeyd var?
  const today = new Date().toISOString().slice(0, 10);
  const { data: todayLogs } = await supabase.from('attendance')
    .select('*').eq('emp_id', matched.id).eq('date_str', today).order('logged_at');

  let type = 'GƏLİŞ';
  if (todayLogs?.length > 0) {
    const last = todayLogs[todayLogs.length - 1];
    if (last.type === 'GƏLİŞ') type = 'ÇIXIŞ';
    else return res.json({ valid: false, reason: 'Bu gün üçün artıq tam qeyd var' });
  }

  const id = 'att_' + Date.now();
  await supabase.from('attendance').insert([{
    id, emp_id: matched.id, emp_name: matched.name,
    dept: matched.dept, type, date_str: today
  }]);

  res.json({ valid: true, empName: matched.name, dept: matched.dept, type });
});

// ── DAVAMIYYƏT LOQ ─────────────────────────────────────────
app.get('/api/attendance', async (req, res) => {
  const { data, error } = await supabase.from('attendance').select('*').order('logged_at', { ascending: false }).limit(200);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── CİHAZLAR ───────────────────────────────────────────────
app.get('/api/devices', async (req, res) => {
  const { data } = await supabase.from('scan_devices').select('*').order('created_at', { ascending: false });
  res.json(data);
});

app.post('/api/devices/:id/status', async (req, res) => {
  const { status } = req.body;
  await supabase.from('scan_devices').update({ status }).eq('device_id', req.params.id);
  res.json({ ok: true });
});

// ── İŞÇİ KODU (MyCode) ────────────────────────────────────
app.get('/api/mycode', async (req, res) => {
  const { secret } = req.query;
  const { data } = await supabase.from('employees').select('*').eq('secret', secret).single();
  if (!data) return res.status(404).json({ error: 'Tapılmadı' });
  const tw = currentTimeWindow();
  const pin = generatePin(data.secret, tw);
  const remaining = TIME_STEP - (Date.now() % TIME_STEP);
  res.json({ name: data.name, dept: data.dept, pin, remaining: Math.ceil(remaining / 1000) });
});

// ── SERVER ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server: http://localhost:${PORT}`));