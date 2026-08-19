'use strict';
// ══════════════════════════════════════════════════════════════════════════
//  PLATFORMA QATI — müştəri yaratmaq və idarə etmək
// ══════════════════════════════════════════════════════════════════════════
//  Bu, sistemin "sahibi" qatıdır: yeni restoran/kofeşop qeydə alır, abunəlik
//  vəziyyətini idarə edir. Müştəri datasına toxunmur.
//
//  `tenants` və `auth_keys` platforma cədvəlləridir → burada XAM klient
//  işlədilir (tdb.js onları qəsdən bloklayır). Müştərinin öz cədvəllərinə
//  yazarkən isə `dbFor(tid)` işlədilir ki, tenant_id avtomatik düşsün.
// ══════════════════════════════════════════════════════════════════════════

const { raw: sb, dbFor } = require('./tdb');
const T = require('./tenant');

// Yeni müştəri üçün ilkin çeklist. Boş sistemə düşməsin deyə — hamısı
// sonradan admin panelindən dəyişilir/silinir.
const STARTER_CHECKLIST = [
  ['Açılış hazırlığı (masa, avadanlıq)',        'Açılış',   1],
  ['Kassa balansının yoxlanması',                'Açılış',   2],
  ['Temperatur jurnalının doldurulması',         'Gigiyena', 3],
  ['Soyuducu / vitrin yoxlaması',                'Gigiyena', 4],
  ['Stok sayımı və çatışmazlıq qeydi',           'Stok',     5],
  ['Personalın geyim / görünüş yoxlaması',       'Personal', 6],
  ['Müştəri şikayətlərinin nəzərdən keçirilməsi','Xidmət',   7],
  ['Günün hesabatının hazırlanması',             'Bağlanış', 8],
  ['Bağlanış yoxlaması (qapı, işıq, avadanlıq)', 'Bağlanış', 9],
];

const DEFAULT_POSITIONS = ['Menecer', 'Kassir', 'Ofisiant', 'Təmizlikçi'];

function slugifyId(s) {
  return String(s || '').trim().toLowerCase()
    .replace(/[əıöüçşğ]/g, ch => ({ 'ə':'e','ı':'i','ö':'o','ü':'u','ç':'c','ş':'s','ğ':'g' }[ch] || ch))
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

// ── Yeni müştəri qeydə al ────────────────────────────────────────────────
//  opts = { tenantId, name, slug, plan, trialDays, branches:[ad|{name,...}],
//           positions:[ad], brand:{}, locale, currency, timezone,
//           maxEmployees, maxBranches, seedChecklist }
//  Qaytarır: { tenantId, keys:{ admin, exec, trainer, ops, branches:{ad:açar} } }
async function createTenant(opts = {}) {
  const name = String(opts.name || '').trim();
  if (!name) throw new Error('Müştəri adı tələb olunur.');

  const tid  = slugifyId(opts.tenantId || name) || ('t' + Date.now().toString(36));
  const slug = slugifyId(opts.slug || tid);

  if (T.getTenant(tid)) throw new Error(`'${tid}' id-li müştəri artıq var.`);

  const trialDays = Number.isFinite(opts.trialDays) ? opts.trialDays : 30;
  const trialEnds = new Date(Date.now() + trialDays * 86400000).toISOString().slice(0, 10);

  const { error: tErr } = await sb.from('tenants').insert({
    tenant_id: tid,
    name,
    slug,
    plan:   opts.plan   || 'trial',
    status: opts.status || 'active',
    trial_ends_at: (opts.plan && opts.plan !== 'trial') ? null : trialEnds,
    max_employees: Number(opts.maxEmployees) || 0,
    max_branches:  Number(opts.maxBranches)  || 0,
    brand: opts.brand || { displayName: name },
    locale:   opts.locale   || 'az',
    currency: opts.currency || 'AZN',
    timezone: opts.timezone || 'Asia/Baku',
  });
  if (tErr) throw new Error('Müştəri yaradıla bilmədi: ' + tErr.message);

  // Keşə düşsün ki, aşağıdakı addımlar onu görsün
  await T.reload(tid);

  const d = dbFor(tid);

  // ── Filiallar ──
  const branchInput = (opts.branches && opts.branches.length) ? opts.branches : ['Əsas filial'];
  const branchRows = branchInput.map((b, i) => {
    const bn = typeof b === 'string' ? b : b.name;
    return {
      branch_id: slugifyId(bn).replace(/-/g, '') || ('f' + i),
      name: bn,
      color: (typeof b === 'object' && b.color) || '#bfdbfe',
      wifi_ips: (typeof b === 'object' && b.wifiIps) || '',
      tg_chat_id: (typeof b === 'object' && b.tgChatId) || '',
      waste_limit: (typeof b === 'object' && Number.isFinite(b.wasteLimit)) ? b.wasteLimit : 3.0,
      sort_order: i,
    };
  });
  const { error: bErr } = await d.from('branches').insert(branchRows);
  if (bErr) throw new Error('Filiallar yaradıla bilmədi: ' + bErr.message);

  // ── Vəzifələr ──
  const posList = (opts.positions && opts.positions.length) ? opts.positions : DEFAULT_POSITIONS;
  const { error: pErr } = await d.from('positions')
    .insert(posList.map((nm, i) => ({ name: nm, sort_order: i, active: true })));
  if (pErr) throw new Error('Vəzifələr yaradıla bilmədi: ' + pErr.message);

  // ── İlkin çeklist ──
  if (opts.seedChecklist !== false) {
    await d.from('checklist_items').insert(
      STARTER_CHECKLIST.map(([text, category, order]) => ({
        item_id: 'CI-' + String(order).padStart(3, '0'), text, category, sort_order: order, active: true,
      }))
    );
  }

  // ── İlkin parametrlər ──
  //  SHIFT_CONFIG hər filial üçün defolt şablonla doldurulur ki, gecikmə/streak
  //  məntiqi birinci gündən işləsin. SALARY_CONFIG-də dərəcələr sıfırdır —
  //  admin panelindən doldurulur (yanlış rəqəmlə maaş hesablanmasın).
  await T.reload(tid);
  const U = require('./utils');
  await T.run({ tenantId: tid, role: 'system', branchId: null }, async () => {
    const tpl = U.defaultShiftTemplate();
    const cfg = {};
    for (const b of branchRows) cfg[b.name] = JSON.parse(JSON.stringify(tpl));
    await U.setSetting('SHIFT_CONFIG', JSON.stringify(cfg));

    const sal = JSON.parse(JSON.stringify(U.DEFAULT_SALARY));
    for (const p of posList) sal.rates[p] = 0;
    await U.setSetting('SALARY_CONFIG', JSON.stringify(sal));
  });

  // ── Açarlar ──
  const keys = {
    admin:   await T.issueKey(tid, 'admin',   null, 'Admin'),
    exec:    await T.issueKey(tid, 'exec',    null, 'İcraçı'),
    trainer: await T.issueKey(tid, 'trainer', null, 'Treninq meneceri'),
    ops:     await T.issueKey(tid, 'ops',     null, 'Əməliyyat meneceri'),
    branches: {},
  };
  for (const b of branchRows) {
    keys.branches[b.name] = await T.issueKey(tid, 'manager', b.branch_id, b.name);
  }

  await T.reload(tid);
  return { tenantId: tid, slug, keys };
}

// ── Siyahı (platforma paneli üçün) ──────────────────────────────────────
async function listTenants() {
  const { data } = await sb.from('tenants').select('*').order('created_at');
  const out = [];
  for (const t of data || []) {
    const [{ count: emps }, { count: brs }] = await Promise.all([
      dbFor(t.tenant_id).from('employees').select('id', { count: 'exact', head: true }),
      dbFor(t.tenant_id).from('branches').select('branch_id', { count: 'exact', head: true }),
    ]);
    out.push({
      tenantId: t.tenant_id, name: t.name, slug: t.slug || '',
      plan: t.plan, status: t.status, trialEndsAt: t.trial_ends_at || '',
      employees: emps || 0, branches: brs || 0,
      maxEmployees: t.max_employees || 0, maxBranches: t.max_branches || 0,
      createdAt: t.created_at, notes: t.notes || '',
    });
  }
  return out;
}

async function updateTenant(tid, patch = {}) {
  const p = {};
  if (patch.name         !== undefined) p.name          = String(patch.name).trim();
  if (patch.plan         !== undefined) p.plan          = String(patch.plan);
  if (patch.status       !== undefined) p.status        = String(patch.status);
  if (patch.trialEndsAt  !== undefined) p.trial_ends_at = patch.trialEndsAt || null;
  if (patch.maxEmployees !== undefined) p.max_employees = Number(patch.maxEmployees) || 0;
  if (patch.maxBranches  !== undefined) p.max_branches  = Number(patch.maxBranches)  || 0;
  if (patch.notes        !== undefined) p.notes         = String(patch.notes || '');
  if (patch.slug         !== undefined) p.slug          = slugifyId(patch.slug) || null;
  if (!Object.keys(p).length) return { success: true };

  const { error } = await sb.from('tenants').update(p).eq('tenant_id', tid);
  if (error) return { success: false, reason: error.message };
  await T.reload(tid);
  return { success: true };
}

// Müştərini TAM silir. `tenants` sətrini silmək bütün cədvəllərdə
// ON DELETE CASCADE ilə həmin müştərinin BÜTÜN datasını aparır — geri dönüşü yoxdur.
async function deleteTenant(tid, confirmName) {
  const t = T.getTenant(tid);
  if (!t) return { success: false, reason: 'Müştəri tapılmadı.' };
  if (confirmName !== t.name) {
    return { success: false, reason: 'Təsdiq üçün müştərinin adını dəqiq yazın.' };
  }
  const { error } = await sb.from('tenants').delete().eq('tenant_id', tid);
  if (error) return { success: false, reason: error.message };
  await T.loadAll();
  return { success: true };
}

// Bir müştərinin bütün giriş linkləri (dəstək üçün)
async function tenantKeys(tid) {
  const t = T.getTenant(tid);
  if (!t) return null;
  return T.run({ tenantId: tid, role: 'system', branchId: null }, async () => {
    const { data } = await sb.from('auth_keys').select('*')
      .eq('tenant_id', tid).eq('revoked', false);
    const branchName = (bid) => {
      const b = T.branchBySlug(bid, tid);
      return b ? b.name : bid;
    };
    return {
      tenantId: tid, name: t.name,
      keys: (data || []).map(k => ({
        role: k.role, key: k.key,
        branch: k.branch_id ? branchName(k.branch_id) : '',
        path: { admin: '/admin', exec: '/icraci', trainer: '/trainer',
                ops: '/ops', manager: '/manager' }[k.role] || '/',
      })),
    };
  });
}

module.exports = {
  createTenant, listTenants, updateTenant, deleteTenant, tenantKeys,
  slugifyId, STARTER_CHECKLIST, DEFAULT_POSITIONS,
};
