'use strict';
// ══════════════════════════════════════════════════════════════════════════
//  TEST BOOTSTRAP — çox-müştərili qat üçün
// ══════════════════════════════════════════════════════════════════════════
//  Domen testləri (smen, maaş, PIN) bazaya qoşulmur, amma `utils.js` artıq
//  müştəri kontekstində işləyir: filiallar, vəzifələr və parametrlər
//  `tenant.js` keşindən gəlir. Bu fayl həmin keşi Coffeemoon-un qurulusu ilə
//  doldurur və testləri həmin kontekstdə işə salır.
//
//    const { withTenant, setLocal } = require('./test-helpers');
//    withTenant(() => { ...testlər... });
// ══════════════════════════════════════════════════════════════════════════

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://test.local';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test';

const T = require('./tenant');

const TID = 'cm';

// Coffeemoon-un real qurulusu — köhnə hardcode dəyərlərin eynisi, ona görə
// testlər dəyişiklikdən ƏVVƏLKİ davranışı yoxlamağa davam edir.
const BRANCHES = [
  { tenant_id: TID, branch_id: 'elmler',  name: 'Elmlər',   color: '#bfdbfe', waste_limit: 3.5, active: true, sort_order: 0, wifi_ips: '', tg_chat_id: '', mgr_name: '', mgr_msg: '' },
  { tenant_id: TID, branch_id: 'sahil',   name: 'Sahil',    color: '#fbcfe8', waste_limit: 4.0, active: true, sort_order: 1, wifi_ips: '', tg_chat_id: '', mgr_name: '', mgr_msg: '' },
  { tenant_id: TID, branch_id: 'genclik', name: 'Gənclik',  color: '#bbf7d0', waste_limit: 2.5, active: true, sort_order: 2, wifi_ips: '', tg_chat_id: '', mgr_name: '', mgr_msg: '' },
  { tenant_id: TID, branch_id: 'agseher', name: 'Ağ Şəhər', color: '#fef08a', waste_limit: 3.0, active: true, sort_order: 3, wifi_ips: '', tg_chat_id: '', mgr_name: '', mgr_msg: '' },
];
const POSITIONS = ['Team Leader', 'Barista', 'Cashier', 'Cleaner'];

// Köhnə A/B qrupları — indi konfiqurasiya, əvvəl kodda idi.
const SHIFT_A = {
  sehersm:     { startH:7,  startM:30, durH:9,  lateH:7,  lateM:15 },
  axsamsm:     { startH:16, startM:0,  durH:9,  lateH:16, lateM:0  },
  fullsm:      { startH:14, startM:0,  durH:11, lateH:14, lateM:0  },
  seherfullsm: { startH:7,  startM:30, durH:11, lateH:7,  lateM:15 },
  fbMorningH:7, fbMorningM:30, fbEveningH:16, fbEveningM:0,
};
const SHIFT_B = {
  sehersm:     { startH:7,  startM:30, durH:8,  lateH:7,  lateM:15 },
  axsamsm:     { startH:15, startM:0,  durH:8,  lateH:15, lateM:0  },
  fullsm:      { startH:13, startM:0,  durH:10, lateH:13, lateM:0  },
  seherfullsm: { startH:7,  startM:30, durH:10, lateH:7,  lateM:15 },
  fbMorningH:7, fbMorningM:30, fbEveningH:15, fbEveningM:0,
};
const isGroupA = (dept) => dept === 'Ağ Şəhər' || dept === 'Gənclik';

// Coffeemoon-un köhnə maaş defoltları (utils.DEFAULT_SALARY-dən çıxarıldı)
const SALARY = {
  rates: { 'Team Leader': 23.33, 'Barista': 20, 'Cashier': 20, 'Cleaner': 18.33 },
  taxi: 7,
  taxiDepts: ['Ağ Şəhər', 'Gənclik'],
  taxiShifts: ['axsamsm', 'fullsm', 'tamgun'],
  taxiMonthlyLimit: 13,
  restDayPaid: true,
  restDayMultiplier: 1,
  restDayMonthlyLimit: 12,
  fineStatuses: ['unpaid'],

  avansStatuses: ['approved', 'paid'],
};

function seed() {
  const shiftCfg = {};
  for (const b of BRANCHES) shiftCfg[b.name] = JSON.parse(JSON.stringify(isGroupA(b.name) ? SHIFT_A : SHIFT_B));

  T.__testSeed({
    tenants: [{ tenant_id: TID, name: 'Coffeemoon', status: 'active', plan: 'pro',
                brand: { displayName: 'Coffeemoon' }, locale: 'az', currency: 'AZN' }],
    authKeys: [
      { key: 'TEST-ADMIN',   tenant_id: TID, role: 'admin',   branch_id: null },
      { key: 'TEST-EXEC',    tenant_id: TID, role: 'exec',    branch_id: null },
      { key: 'TEST-TRAINER', tenant_id: TID, role: 'trainer', branch_id: null },
      { key: 'TEST-OPS',     tenant_id: TID, role: 'ops',     branch_id: null },
      { key: 'TEST-MGR-ELM', tenant_id: TID, role: 'manager', branch_id: 'elmler' },
    ],
    branches: BRANCHES,
    positions: POSITIONS.map((name, i) => ({ tenant_id: TID, name, sort_order: i, active: true })),
    settings: [
      { tenant_id: TID, key: 'SHIFT_CONFIG',  value: JSON.stringify(shiftCfg) },
      { tenant_id: TID, key: 'SALARY_CONFIG', value: JSON.stringify(SALARY) },
    ],
  });
}

// Parametri YALNIZ yaddaş keşinə yazır — DB-yə getmir.
// (`U.setSetting` indi Supabase-ə yazmağa çalışır; testdə bu lazım deyil.)
function setLocal(key, value) {
  T.settingsMap(TID).set(key, String(value));
}

// Test gövdəsini müştəri kontekstində işlədir.
function withTenant(fn) {
  seed();
  return T.run({ tenantId: TID, role: 'admin', branchId: null }, fn);
}

// Yuxarıdan-aşağı işləyən test skriptləri üçün: keşi doldurur və kontekstə
// sinxron girir, beləliklə faylın qalanı olduğu kimi qalır (yalnız bir sətir
// əlavə edilir). Sonra `U.*` funksiyaları həmişəki kimi çağırılır.
function enterTenant() {
  seed();
  T.__testEnter({ tenantId: TID, role: 'admin', branchId: null });
}

module.exports = { withTenant, enterTenant, setLocal, seed, TID, BRANCHES, POSITIONS, SALARY, SHIFT_A, SHIFT_B, isGroupA };
