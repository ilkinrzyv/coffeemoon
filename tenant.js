'use strict';
// ══════════════════════════════════════════════════════════════════════════
//  TENANT (MÜŞTƏRİ) KONTEKSTİ VƏ REGİSTRLƏRİ
// ══════════════════════════════════════════════════════════════════════════
//  Bu fayl bir suala cavab verir: "bu sorğu HANSI müştəriyə aiddir?"
//  və cavabı bütün çağırış zəncirinə görünən edir.
//
//  NİYƏ AsyncLocalStorage?
//  ──────────────────────
//  `getSetting()`, `getShiftConfig()`, `getLateLimit()` SİNXRON funksiyalardır
//  və isti döngülərdə (recalcAllXP, calcStreak) çağırılır. Onlara `tenantId`
//  parametri əlavə etsək 100+ imza dəyişməli olardı — hər biri yeni səhv riski.
//  ALS ilə kontekst "fonda" daşınır: imzalar toxunulmaz qalır, amma hər sorğu
//  öz müştərisinin datasını görür.
//
//  KEŞ
//  ───
//  tenants / settings / branches / positions / auth_keys server qalxanda bir
//  dəfə yüklənir və dəyişiklik olanda write-through yenilənir. Beləliklə
//  sinxron `getSetting()` DB-yə getmir.
// ══════════════════════════════════════════════════════════════════════════

const { AsyncLocalStorage } = require('async_hooks');
const sb = require('./db');            // XAM klient — scope EDİLMƏYİB, yalnız bu fayl işlədir

const als = new AsyncLocalStorage();

// ── Keşlər ───────────────────────────────────────────────────────────────
const _tenants   = new Map();   // tenant_id → tenant sətri
const _settings  = new Map();   // tenant_id → Map(key → value)
const _branches  = new Map();   // tenant_id → [branch sətri] (sort_order üzrə)
const _positions = new Map();   // tenant_id → [vəzifə adı]
const _authKeys  = new Map();   // açar → { tenantId, role, branchId }
// Tərs indeks: 'tid|rol|filial' → açar. `roleKey()` isti yollarda (hər trainer/ops
// çağırışında) işlədilir — indekssiz bütün müştərilərin açarlarını gəzmək lazım
// gələrdi və müştəri sayı artdıqca yavaşlayardı.
const _keyIndex  = new Map();

const _kx = (tid, roleName, bid) => `${tid}|${roleName}|${bid || ''}`;

function _setKey(key, rec) {
  _authKeys.set(key, rec);
  _keyIndex.set(_kx(rec.tenantId, rec.role, rec.branchId), key);
}
function _delKey(key) {
  const rec = _authKeys.get(key);
  if (!rec) return;
  _authKeys.delete(key);
  const ix = _kx(rec.tenantId, rec.role, rec.branchId);
  if (_keyIndex.get(ix) === key) _keyIndex.delete(ix);
}
const _empSecret = new Map();   // işçi secret → tenantId
const _devices   = new Map();   // device_id   → tenantId

// Tanınmayan açarlar üçün mənfi keş: hər səhv açar DB-yə sorğu atmasın deyə.
// Kiçik saxlanılır ki, təsadüfi/zərərli axın yaddaşı doldurmasın.
const _misses    = new Map();   // açar → vaxt damgası
const MISS_TTL   = 60_000;
const MISS_MAX   = 500;

// Platforma sahibinin açarı (səndə). Env-dədir — heç bir müştəriyə aid deyil.
const PLATFORM_KEY = process.env.PLATFORM_KEY || '';

// ══════════════════════════════════════════════════════════════════════════
//  KONTEKST
// ══════════════════════════════════════════════════════════════════════════

// Verilmiş müştəri kontekstində funksiyanı işlədir.
// ctx = { tenantId, role, branchId, empId }
function run(ctx, fn) {
  return als.run(ctx, fn);
}

function store() {
  return als.getStore() || null;
}

// Cari müştərinin id-si. Kontekst yoxdursa XƏTA atır — bu qəsdəndir:
// scope edilməmiş sorğu bütün müştərilərin datasını qarışdırardı (fail-closed).
function tenantId() {
  const s = als.getStore();
  if (!s || !s.tenantId) {
    throw new Error(
      'Tenant konteksti yoxdur. DB sorğusu yalnız tenant.run(...) içində atıla bilər. ' +
      'Fon işi yazırsansa forEachTenant() işlət.'
    );
  }
  return s.tenantId;
}

function tenantIdOrNull() {
  const s = als.getStore();
  return (s && s.tenantId) || null;
}

function role()     { const s = als.getStore(); return (s && s.role)     || null; }
function branchId() { const s = als.getStore(); return (s && s.branchId) || null; }

// Sorğunun GƏLDİYİ IP — serverin özünün gördüyü (`req.ip`), müştərinin
// bildirdiyi DEYİL. Dispatcher onu kontekstə qoyur, `checkWifiIp` buradan oxuyur.
//
// NİYƏ kontekstdə: WiFi yoxlaması `validateAndLog` → `checkWifiIp` zəncirinin
// dərinliyindədir; `req`-i ora ötürmək üçün onlarla imza dəyişməli olardı.
// Bu, tenantId ilə tam eyni səbəbdir (yuxarıdakı izaha bax).
//
// Sorğu kontekstindən kənarda (fon işi, test, CLI skript) boş qaytarır —
// `checkWifiIp` boş IP-ni QƏBUL ETMİR, yəni fail-closed davranır.
function clientIp()  { const s = als.getStore(); return (s && s.clientIp)  || ''; }

// ══════════════════════════════════════════════════════════════════════════
//  YÜKLƏMƏ
// ══════════════════════════════════════════════════════════════════════════

async function loadAll() {
  const [tRes, kRes, sRes, bRes, pRes] = await Promise.all([
    sb.from('tenants').select('*'),
    sb.from('auth_keys').select('*').eq('revoked', false),
    sb.from('settings').select('*'),
    sb.from('branches').select('*').order('sort_order'),
    sb.from('positions').select('*').order('sort_order'),
  ]);

  _tenants.clear(); _authKeys.clear(); _keyIndex.clear();
  _settings.clear(); _branches.clear(); _positions.clear();

  for (const t of tRes.data || []) _tenants.set(t.tenant_id, t);

  for (const k of kRes.data || []) {
    _setKey(k.key, { tenantId: k.tenant_id, role: k.role, branchId: k.branch_id || null });
  }

  for (const s of sRes.data || []) {
    if (!_settings.has(s.tenant_id)) _settings.set(s.tenant_id, new Map());
    _settings.get(s.tenant_id).set(s.key, s.value);
  }

  for (const b of bRes.data || []) {
    if (!_branches.has(b.tenant_id)) _branches.set(b.tenant_id, []);
    _branches.get(b.tenant_id).push(b);
  }

  for (const p of pRes.data || []) {
    if (!p.active) continue;
    if (!_positions.has(p.tenant_id)) _positions.set(p.tenant_id, []);
    _positions.get(p.tenant_id).push(p.name);
  }

  console.log(`[Tenant] ${_tenants.size} müştəri, ${_authKeys.size} açar, ` +
              `${bRes.data?.length || 0} filial yükləndi.`);
}

// Bir müştərinin keşini DB-dən təzələyir (filial/açar/parametr dəyişəndən sonra).
async function reload(tid) {
  const [tRes, kRes, sRes, bRes, pRes] = await Promise.all([
    sb.from('tenants').select('*').eq('tenant_id', tid).maybeSingle(),
    sb.from('auth_keys').select('*').eq('tenant_id', tid).eq('revoked', false),
    sb.from('settings').select('*').eq('tenant_id', tid),
    sb.from('branches').select('*').eq('tenant_id', tid).order('sort_order'),
    sb.from('positions').select('*').eq('tenant_id', tid).order('sort_order'),
  ]);

  if (tRes.data) _tenants.set(tid, tRes.data); else _tenants.delete(tid);

  // Bu müştəriyə aid köhnə açarları at, sonra yenilərini yaz (ləğv olunanlar düşsün)
  for (const [k, v] of [..._authKeys]) if (v.tenantId === tid) _delKey(k);
  for (const k of kRes.data || []) {
    _setKey(k.key, { tenantId: tid, role: k.role, branchId: k.branch_id || null });
  }

  const sm = new Map();
  for (const s of sRes.data || []) sm.set(s.key, s.value);
  _settings.set(tid, sm);

  _branches.set(tid, bRes.data || []);
  _positions.set(tid, (pRes.data || []).filter(p => p.active).map(p => p.name));

  // İşçi/cihaz keşləri sətir-sətir dolur; bu müştərininkiləri atırıq ki,
  // silinmiş işçinin açarı keşdə qalmasın.
  for (const [k, v] of _empSecret) if (v === tid) _empSecret.delete(k);
  for (const [k, v] of _devices)   if (v === tid) _devices.delete(k);
}

// ══════════════════════════════════════════════════════════════════════════
//  MÜŞTƏRİ MƏLUMATI
// ══════════════════════════════════════════════════════════════════════════

function getTenant(tid) {
  return _tenants.get(tid || tenantIdOrNull()) || null;
}

function currentTenant() {
  return _tenants.get(tenantIdOrNull()) || null;
}

function allTenants() {
  return [..._tenants.values()];
}

// Sorğu qəbul edilməlidir? (dayandırılmış/müddəti bitmiş müştəri bloklanır)
function tenantUsable(tid) {
  const t = _tenants.get(tid);
  if (!t) return { ok: false, reason: 'Belə hesab yoxdur.' };
  if (t.status === 'suspended') return { ok: false, reason: 'Hesab müvəqqəti dayandırılıb. Zəhmət olmasa bizimlə əlaqə saxlayın.' };
  if (t.status === 'expired')   return { ok: false, reason: 'Abunəlik müddəti bitib.' };
  if (t.trial_ends_at && t.plan === 'trial') {
    const today = new Date().toISOString().slice(0, 10);
    if (today > t.trial_ends_at) return { ok: false, reason: 'Sınaq müddəti bitib.' };
  }
  return { ok: true };
}

// Brend dəyərləri — şablonlara və manifestlərə gedir.
function brand(tid) {
  const t = _tenants.get(tid || tenantIdOrNull());
  const b = (t && t.brand) || {};
  return {
    name:       b.displayName || (t && t.name) || 'Workforce',
    icon:       b.icon        || 'fa-solid fa-store',
    themeColor: b.themeColor  || '#5b5ef4',
    bgColor:    b.bgColor     || '#f0f2f8',
    footer:     b.footer      || ((t && t.name) || ''),
    terms:      b.terms       || {},
  };
}

// ══════════════════════════════════════════════════════════════════════════
//  PARAMETRLƏR (settings) — müştəri başına
// ══════════════════════════════════════════════════════════════════════════

function settingsMap(tid) {
  const id = tid || tenantId();
  if (!_settings.has(id)) _settings.set(id, new Map());
  return _settings.get(id);
}

function getSetting(key) {
  return settingsMap().get(key) || '';
}

async function setSetting(key, value) {
  const tid = tenantId();
  settingsMap(tid).set(key, String(value));
  await sb.from('settings').upsert(
    { tenant_id: tid, key, value: String(value) },
    { onConflict: 'tenant_id,key' }
  );
}

// ══════════════════════════════════════════════════════════════════════════
//  FİLİALLAR — əvvəl utils.js-də DEPT_SLUG hardcode idi
// ══════════════════════════════════════════════════════════════════════════

function branches(tid) {
  const id = tid || tenantIdOrNull();
  if (!id) return [];
  return (_branches.get(id) || []).filter(b => b.active !== false);
}

function branchNames(tid)  { return branches(tid).map(b => b.name); }
function branchSlugs(tid)  { return branches(tid).map(b => b.branch_id); }

function branchByName(name, tid) {
  return branches(tid).find(b => b.name === name) || null;
}
function branchBySlug(slug, tid) {
  return branches(tid).find(b => b.branch_id === slug) || null;
}

function positions(tid) {
  const id = tid || tenantIdOrNull();
  if (!id) return [];
  return _positions.get(id) || [];
}

// ══════════════════════════════════════════════════════════════════════════
//  AÇAR → MÜŞTƏRİ HƏLLİ
// ══════════════════════════════════════════════════════════════════════════
//  Üç mənbə var və hamısı QLOBAL unikaldır:
//    1. auth_keys      — panel açarları (keşdən, sinxron)
//    2. employees.secret — işçi açarı   (keş + DB ehtiyatı)
//    3. scan_devices.device_id — kiosk  (keş + DB ehtiyatı)
// ══════════════════════════════════════════════════════════════════════════

function noteMiss(key) {
  if (_misses.size >= MISS_MAX) _misses.clear();
  _misses.set(key, Date.now());
}
function isFreshMiss(key) {
  const t = _misses.get(key);
  if (!t) return false;
  if (Date.now() - t > MISS_TTL) { _misses.delete(key); return false; }
  return true;
}

// Sinxron hissə — yalnız panel açarları. Heç nə tapmasa null.
function resolveKeySync(key) {
  if (!key) return null;
  if (PLATFORM_KEY && key === PLATFORM_KEY) {
    return { tenantId: null, role: 'platform', branchId: null };
  }
  return _authKeys.get(key) || null;
}

// Tam həll — işçi secret-i və kiosk cihazı da daxil (DB-yə düşə bilər).
async function resolveKey(key) {
  if (!key) return null;

  const sync = resolveKeySync(key);
  if (sync) return sync;

  const cachedEmp = _empSecret.get(key);
  if (cachedEmp) return { tenantId: cachedEmp, role: 'employee', branchId: null };

  const cachedDev = _devices.get(key);
  if (cachedDev) return { tenantId: cachedDev, role: 'device', branchId: null };

  if (isFreshMiss(key)) return null;

  // Panel açarı, amma keşdə yoxdur?
  // Bu, iki real halda baş verir:
  //   1. Müştəri BAŞQA prosesdə yaradılıb (`seed-tenant.js` CLI ilə) — işləyən
  //      serverin keşi ondan xəbərsizdir;
  //   2. Bir neçə replika işləyir və açarı başqa replika verib.
  // Keşə güvənib null qaytarsaq, yeni müştəri server yenidən başlayana qədər
  // sisteminə girə bilməzdi. Ona görə keş boşa düşəndə bazadan soruşuruq.
  const { data: ak } = await sb.from('auth_keys')
    .select('key,tenant_id,role,branch_id')
    .eq('key', key).eq('revoked', false).maybeSingle();
  if (ak) {
    // Müştərinin registrləri (filiallar, parametrlər) də keşdə olmaya bilər
    if (!_tenants.has(ak.tenant_id)) await reload(ak.tenant_id);
    _setKey(ak.key, { tenantId: ak.tenant_id, role: ak.role, branchId: ak.branch_id || null });
    return { tenantId: ak.tenant_id, role: ak.role, branchId: ak.branch_id || null };
  }

  // İşçi açarı? (secret qlobal unikaldır)
  const { data: emp } = await sb.from('employees')
    .select('tenant_id,id').eq('secret', key).maybeSingle();
  if (emp) {
    _empSecret.set(key, emp.tenant_id);
    return { tenantId: emp.tenant_id, role: 'employee', branchId: null, empId: emp.id };
  }

  // Kiosk cihazı? (device_id qlobal unikaldır)
  const { data: dev } = await sb.from('scan_devices')
    .select('tenant_id,device_id').eq('device_id', key).maybeSingle();
  if (dev) {
    _devices.set(key, dev.tenant_id);
    return { tenantId: dev.tenant_id, role: 'device', branchId: null };
  }

  noteMiss(key);
  return null;
}

// Yeni işçi/cihaz yaradılanda keşi dərhal doldurur (ilk sorğu DB-yə düşməsin).
function cacheEmployeeSecret(secret, tid) { if (secret) _empSecret.set(secret, tid); }
function forgetEmployeeSecret(secret)     { if (secret) _empSecret.delete(secret); }
function cacheDevice(deviceId, tid)       { if (deviceId) _devices.set(deviceId, tid); }

// ══════════════════════════════════════════════════════════════════════════
//  AÇAR İDARƏÇİLİYİ
// ══════════════════════════════════════════════════════════════════════════
//  `auth_keys` platforma cədvəlidir (tenant_id ilə scope EDİLMİR), ona görə
//  burada xam klient işlədilir. Keşin dəqiqliyi bu funksiyaların üzərindədir.

// ── TƏSADÜFİ AÇARLAR ─────────────────────────────────────────────────────
//  ⚠️ BURADA `Math.random()` İŞLƏDİLMİR — və işlədilməməlidir.
//
//  ƏVVƏL belə idi: `Math.random().toString(36).slice(2, 10).toUpperCase()`.
//  V8-in `Math.random()`-u kriptoqrafik deyil: xorshift128+ generatorudur və
//  onun daxili vəziyyəti bir neçə ardıcıl çıxışdan geri hesablana bilir.
//
//  Çox-müştərili sistemdə bu konkret hücuma çevrilirdi: zərərli bir müştəri
//  admini `regenerateAdminKey`/`regenerateTrainerKey`-i ardıcıl çağırıb nümunə
//  toplayır, generatorun vəziyyətini bərpa edir və eyni proses daxilində
//  BAŞQA müştərilər üçün verilən açarları qabaqcadan hesablaya bilirdi —
//  yəni tdb.js-in qurduğu bütün izolyasiyanı yandan keçirdi.
//
//  İndi mənbə `crypto.randomBytes`-dir (əməliyyat sisteminin CSPRNG-i).
//  MÖVCUD açarlar işləməyə davam edir — dəyişən yalnız YENİ açarlardır.
const crypto = require('crypto');

//  32 simvol = simvol başına DƏQİQ 5 bit. `I` və `O` qəsdən yoxdur:
//  açarlar bəzən əl ilə köçürülür, `1/I` və `0/O` qarışığı problem yaradır.
const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

//  `bytes[i] & 31` — bayrın aşağı 5 biti. 32 variantın hamısı BƏRABƏR
//  ehtimallıdır. (`% 31` kimi bir şey yazsaydıq bəzi simvollar daha tez-tez
//  düşərdi — modulo sürüşməsi entropiyanı azaldır.)
//  Uzunluq yoxlaması QƏSDƏN sərtdir: səhv/pozulmuş dəyər TƏHLÜKƏSİZ ilkin
//  dəyərə (16) düşür, qısa açara YOX. Əvvəlki variantda `Math.max(1, …)` vardı
//  və mənfi dəyər 1 simvollu açar verirdi — testi yazanda üzə çıxdı.
const TOKEN_MIN = 8, TOKEN_MAX = 128, TOKEN_DEFAULT = 16;

function randomToken(len = TOKEN_DEFAULT) {
  const raw = Math.round(Number(len));
  const n = (Number.isFinite(raw) && raw >= TOKEN_MIN) ? Math.min(TOKEN_MAX, raw) : TOKEN_DEFAULT;
  const bytes = crypto.randomBytes(n);
  let out = '';
  for (let i = 0; i < n; i++) out += KEY_ALPHABET[bytes[i] & 31];
  return out;
}

//  Panel açarı: 2 simvol prefiks + 16 simvol = 80 bit entropiya.
//  (Müqayisə üçün: UUIDv4 122 bitdir; təxmin etmək praktiki olaraq mümkün deyil.)
function randomKey(prefix, len = 16) {
  return `${prefix || ''}${randomToken(len)}`;
}

// Keşdən açarı tapır (rol + filial üzrə). DB-yə getmir, tərs indeksdən oxuyur.
function findKey(tid, roleName, bid) {
  return _keyIndex.get(_kx(tid, roleName, bid)) || null;
}

// Mövcud açarı qaytarır, yoxdursa yaradır.
async function ensureKey(tid, roleName, bid, label) {
  const existing = findKey(tid, roleName, bid);
  if (existing) return existing;
  return issueKey(tid, roleName, bid, label);
}

// Yeni açar verir. Həmin rol/filial üçün köhnə açar varsa ləğv olunur
// (bir aktiv açar qaydası bazada da unikal indekslə qorunur).
async function issueKey(tid, roleName, bid, label) {
  const prefix = { admin: 'AK', manager: 'SK', exec: 'EK', trainer: 'TK', ops: 'OK' }[roleName] || 'XK';
  const key = randomKey(prefix);

  await revokeKeys(tid, roleName, bid);
  const { error } = await sb.from('auth_keys').insert({
    key, tenant_id: tid, role: roleName, branch_id: bid || null, label: label || '',
  });
  if (error) throw new Error(`Açar yaradıla bilmədi (${roleName}): ${error.message}`);

  _setKey(key, { tenantId: tid, role: roleName, branchId: bid || null });
  return key;
}

// Rol (və filial) üzrə aktiv açarları ləğv edir.
async function revokeKeys(tid, roleName, bid) {
  let q = sb.from('auth_keys').update({ revoked: true })
    .eq('tenant_id', tid).eq('role', roleName).eq('revoked', false);
  if (roleName === 'manager' && bid) q = q.eq('branch_id', bid);
  await q;

  for (const [k, v] of [..._authKeys]) {
    if (v.tenantId === tid && v.role === roleName &&
        (roleName !== 'manager' || !bid || v.branchId === bid)) _delKey(k);
  }
}

// Bir müştərinin bütün filial (menecer) açarları: { filialAdı: açar }
async function branchKeys(tid) {
  const id = tid || tenantId();
  const out = {};
  for (const b of branches(id)) {
    out[b.name] = await ensureKey(id, 'manager', b.branch_id, b.name);
  }
  return out;
}

// Açar hansı filiala aiddir? (menecer panelinin girişi)
function branchByKey(key) {
  const rec = _authKeys.get(key);
  if (!rec || rec.role !== 'manager') return { valid: false };
  const b = branchBySlug(rec.branchId, rec.tenantId);
  if (!b) return { valid: false };
  return { valid: true, dept: b.name, branchId: rec.branchId, tenantId: rec.tenantId };
}

// ── Host üzrə həll (Faza 3 — subdomain/öz domen) ─────────────────────────
// Sxem hazırdır (tenants.slug, tenants.custom_domain); açar əsaslı yol
// işlədiyi üçün hazırda yalnız köməkçi rol oynayır.
function resolveHost(host) {
  if (!host) return null;
  const h = String(host).toLowerCase().split(':')[0];
  for (const t of _tenants.values()) {
    if (t.custom_domain && t.custom_domain.toLowerCase() === h) return t.tenant_id;
  }
  const sub = h.split('.')[0];
  if (!sub || sub === 'www' || sub === 'localhost') return null;
  for (const t of _tenants.values()) {
    if (t.slug && t.slug.toLowerCase() === sub) return t.tenant_id;
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════════════
//  FON İŞLƏRİ
// ══════════════════════════════════════════════════════════════════════════
//  Gecəlik smen bağlama kimi işlər bir müştəriyə aid deyil — hamısını
//  bir-bir öz kontekstində gəzir. Birində xəta olsa qalanları dayanmır.
async function forEachTenant(fn, opts = {}) {
  const list = allTenants().filter(t => opts.includeInactive ? true : t.status === 'active');
  for (const t of list) {
    try {
      await run({ tenantId: t.tenant_id, role: 'system', branchId: null }, () => fn(t));
    } catch (e) {
      console.error(`[Tenant:${t.tenant_id}] fon işi xətası:`, e.message);
    }
  }
}

// ── Yalnız test üçün ──────────────────────────────────────────────────────
// Keşləri bazaya getmədən doldurur (test-multitenant.js). Produksiya kodunda
// çağırılmır; `loadAll()`-un DB-dən oxuduğu strukturun eynisini gözləyir.
function __testSeed({ tenants = [], authKeys = [], branches = [], positions = [], settings = [] }) {
  _tenants.clear(); _authKeys.clear(); _keyIndex.clear();
  _settings.clear(); _branches.clear(); _positions.clear();

  for (const t of tenants) _tenants.set(t.tenant_id, t);
  for (const k of authKeys) _setKey(k.key, { tenantId: k.tenant_id, role: k.role, branchId: k.branch_id || null });
  for (const b of branches) {
    if (!_branches.has(b.tenant_id)) _branches.set(b.tenant_id, []);
    _branches.get(b.tenant_id).push(b);
  }
  for (const p of positions) {
    if (!p.active) continue;
    if (!_positions.has(p.tenant_id)) _positions.set(p.tenant_id, []);
    _positions.get(p.tenant_id).push(p.name);
  }
  for (const s of settings) {
    if (!_settings.has(s.tenant_id)) _settings.set(s.tenant_id, new Map());
    _settings.get(s.tenant_id).set(s.key, s.value);
  }
}

// Kontekstə SİNXRON girir (yalnız test skriptləri üçün). Sorğu qatında
// həmişə `run()` işlədilir — `enterWith` bütün sonrakı icraya təsir edir və
// serverdə sorğular arasında sızardı.
function __testEnter(ctx) {
  als.enterWith(ctx);
}

module.exports = {
  run, store, tenantId, tenantIdOrNull, role, branchId, clientIp,
  __testSeed, __testEnter,
  loadAll, reload,
  getTenant, currentTenant, allTenants, tenantUsable, brand,
  getSetting, setSetting, settingsMap,
  branches, branchNames, branchSlugs, branchByName, branchBySlug, positions,
  resolveKey, resolveKeySync, resolveHost,
  cacheEmployeeSecret, forgetEmployeeSecret, cacheDevice,
  findKey, ensureKey, issueKey, revokeKeys, branchKeys, branchByKey, randomKey, randomToken,
  forEachTenant,
  PLATFORM_KEY,
};
