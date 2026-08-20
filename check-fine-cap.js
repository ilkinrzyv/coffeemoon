'use strict';
// ══════════════════════════════════════════════════════════════════════════
//  QANUNİ CƏRİMƏ TAVANI AUDİTİ — AR Əmək Məcəlləsi, maddə 175
// ══════════════════════════════════════════════════════════════════════════
//  ƏM 175: işçinin əmək haqqından tutulmaların ümumi məbləği əmək haqqının
//  20 faizindən çox ola bilməz (istisna hallar bu sistemə aid deyil).
//
//  Bu skript HƏR AY üçün hər işçinin brüt maaşını və həmin aya düşən
//  cərimələrin cəmini hesablayır, tavanı aşanları tapır.
//
//  İŞLƏTMƏ:
//    node check-fine-cap.js              → QURU İŞLƏMƏ (heç nə yazmır)
//    node check-fine-cap.js --apply      → aşan hissəni 'waived' edir
//    node check-fine-cap.js --months 6   → neçə ay geriyə baxılsın (defolt 12)
//
//  DÜZƏLİŞ ÜSULU: cərimə SİLİNMİR. Tavanı aşan sətirlər `status='waived'`
//  («bağışlanıb») olur → maaşdan tutulmur, amma qeyd və audit izi qalır.
//  Ən YENİ cərimədən başlayaraq bağışlanır (köhnələr qüvvədə qalsın).
//
//  ⚠️ BAĞLANMIŞ AYLAR: `salary_periods`-də snapshot var. Onlar ödənilib,
//  geriyə dəyişdirilmir — skript onları yalnız XƏBƏRDARLIQ kimi göstərir.
// ══════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const T   = require('./tenant');
const tdb = require('./tdb');
const U   = require('./utils');

const APPLY  = process.argv.includes('--apply');
const MONTHS = (() => {
  const i = process.argv.indexOf('--months');
  const n = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(n) && n > 0 && n <= 60 ? Math.round(n) : 12;
})();

const money = (n) => (Math.round(n * 100) / 100).toFixed(2);

function cariAy() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function aylar(n) {
  const out = [];
  const d = new Date();
  for (let i = 0; i < n; i++) {
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    d.setMonth(d.getMonth() - 1);
  }
  return out;
}

// Bir ayın brüt maaşını hesablayır — getSalaryReport ilə EYNİ qaydalar.
// Serverin funksiyasını çağıra bilmirik (o, API obyektinin içindədir), amma
// istifadə etdiyi utils funksiyaları eynidir, ona görə nəticə uyğun gəlir.
async function brutHesabla(period) {
  const db = tdb.db;
  const [y, m] = period.split('-').map(Number);
  const start = `${y}-${String(m).padStart(2, '0')}-01`;
  const end   = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;

  const cfg = U.getSalaryConfig();
  const [{ data: emps }, { data: logs }, { data: cedvel }] = await Promise.all([
    db().from('employees').select('id,name,dept,position,is_test,taxi_limit'),
    db().from('attendance').select('emp_id,timestamp,type,shift_type').gte('timestamp', start).lt('timestamp', end),
    db().from('cedvel').select('emp_id,date_str,shift_type').gte('date_str', start).lt('date_str', end),
  ]);

  // İşçi → hansı günlərdə GƏLİŞ var
  const gelis = {};
  for (const r of logs || []) {
    if (r.type !== 'GƏLİŞ') continue;
    const id = String(r.emp_id);
    (gelis[id] = gelis[id] || new Set()).add(U.getLogicalYMD(new Date(r.timestamp)));
  }
  const cedvelMap = {};
  for (const c of cedvel || []) cedvelMap[String(c.emp_id) + '|' + c.date_str] = c.shift_type || '';

  const brut = {};
  for (const e of emps || []) {
    if (e.is_test) continue;
    const id = String(e.id);
    let maas = 0, taksi = 0, taksiGun = 0;
    const limit = U.taxiLimitFor(e.taxi_limit, cfg);
    for (const ds of [...(gelis[id] || [])].sort()) {
      const st = cedvelMap[id + '|' + ds] || '';
      if (!st || st === 'istirahetsm') continue;
      const g = U.computeDayPay(e.position, e.dept, st, cfg);
      maas += g.pay;
      if (g.taxi > 0 && taksiGun < limit) { taksi += g.taxi; taksiGun++; }
    }
    brut[id] = { ad: e.name, dept: e.dept, brut: U.round2(maas + taksi) };
  }
  return brut;
}

async function tenantAudit(tenantId, ad) {
  const db   = tdb.db;
  const disc = U.getDisciplineConfig();
  const pct  = disc.finePercentCap;

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`🏢  ${ad}  [${tenantId}]   —  qanuni tavan: ${pct}%`);
  console.log('═'.repeat(70));

  if (!pct) { console.log('   Tavan 0 — məhdudiyyət yoxdur, yoxlanacaq bir şey yoxdur.'); return { asan: 0, duzelen: 0 }; }

  const { data: bagli } = await db().from('salary_periods').select('period');
  const bagliSet = new Set((bagli || []).map(r => r.period));

  let asanCem = 0, duzelenCem = 0;

  for (const period of aylar(MONTHS)) {
    const [y, m] = period.split('-').map(Number);
    const start = `${y}-${String(m).padStart(2, '0')}-01`;
    const end   = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;

    // İKİ MƏNBƏ: sistem (gecikmə) cəriməsi + menecer cəriməsi.
    // Maaş hesabatı hər ikisini `cerime` sütununda toplayır, ona görə tavan da
    // ikisinin CƏMİNƏ tətbiq olunur. (İlk yazdığım variant menecer cərimələrini
    // atlayırdı — real datada məhz onlar var idi.)
    const salCfg = U.getSalaryConfig();
    const [{ data: sysF }, { data: mgrF }] = await Promise.all([
      db().from('fines')
        .select('fine_id,emp_id,emp_name,date_str,amount,status,kind,acked')
        .gte('date_str', start).lt('date_str', end),
      db().from('mgr_fines')
        .select('fine_id,emp_id,emp_name,amount,status,created_at')
        .gte('created_at', start).lt('created_at', end),
    ]);

    // Hesabatdakı süzgəclərin EYNİSİ — yoxsa audit uydurma rəqəm verər
    const tutulan = [];
    for (const f of sysF || []) {
      if (!salCfg.fineStatuses.includes(f.status || 'unpaid')) continue;
      if (salCfg.finesOnlyAcked && !f.acked) continue;      // imzasız tutulmur
      if (U.isTohmet(f.kind || 'fine')) continue;           // tənbehdə pul yoxdur
      if (!(Number(f.amount) > 0)) continue;
      tutulan.push({ ...f, menbe: 'Sistem' });
    }
    for (const f of mgrF || []) {
      if (salCfg.finesOnlyAcked && f.status !== 'acknowledged') continue;
      if (!(Number(f.amount) > 0)) continue;
      tutulan.push({ ...f, date_str: U.toYMD(new Date(f.created_at)), menbe: 'Menecer' });
    }
    if (!tutulan.length) continue;

    const brut = await brutHesabla(period);

    const byEmp = {};
    for (const f of tutulan) {
      const id = String(f.emp_id);
      (byEmp[id] = byEmp[id] || []).push(f);
    }

    for (const [id, list] of Object.entries(byEmp)) {
      const b   = brut[id];
      const cem = U.round2(list.reduce((s, f) => s + (Number(f.amount) || 0), 0));
      if (!b || !(b.brut > 0)) {
        console.log(`   ⚠️  ${period}  ${list[0].emp_name || id} — brüt 0/naməlum, ${money(cem)} ₼ cərimə var (əl ilə yoxla)`);
        continue;
      }
      const cap = U.applyFineCap(b.brut, cem, disc);
      if (!cap.kesilen) continue;

      asanCem++;
      const bagliAy = bagliSet.has(period);
      console.log(`\n   ❗ ${period}  ${b.ad} (${b.dept})${bagliAy ? '   [AY BAĞLIDIR]' : ''}`);
      console.log(`      Brüt: ${money(b.brut)} ₼   ·   Qanuni tavan (${pct}%): ${money(cap.limit)} ₼`);
      console.log(`      Cərimə: ${money(cem)} ₼   →   TAVANI ${money(cap.kesilen)} ₼ AŞIR`);

      // Ən yeni cərimədən başlayaraq bağışla — köhnələr qüvvədə qalsın
      const sirali = list.slice().sort((a, b2) => String(b2.date_str).localeCompare(String(a.date_str)));
      let qalan = cap.kesilen, secilen = [];
      for (const f of sirali) {
        if (qalan <= 0.001) break;
        // Bu sətirdən nə qədəri artıqdır — menecer cəriməsində məbləğ buna görə azaldılır
        f.kesilecek = U.round2(Math.min(qalan, Number(f.amount) || 0));
        secilen.push(f);
        qalan = U.round2(qalan - f.kesilecek);
      }
      for (const f of secilen) {
        console.log(`      → ${f.date_str}  ${money(Number(f.amount) || 0)} ₼  [${f.menbe}]  ${f.fine_id}  ${APPLY ? (f.menbe === 'Sistem' ? 'BAĞIŞLANIR' : 'SİLİNİR') : '(quru işləmə)'}`);
      }

      if (APPLY) {
        if (bagliAy) {
          console.log('      ⏭️  AY BAĞLIDIR — snapshot dəyişdirilmir, toxunulmadı.');
          continue;
        }
        // BİTMƏMİŞ AY: brüt hələ artır → tavan da artır. İndi düzəltsək
        // ay sonunda qanuni olacaq cəriməni nahaq azaltmış olarıq.
        if (period === cariAy()) {
          console.log('      ⏭️  AY HƏLƏ BİTMƏYİB — brüt artacaq, düzəliş ay sonuna saxlanılır.');
          console.log('         (Maaş hesabatı onsuz da tavandan artıq tutmur — riski yoxdur.)');
          continue;
        }
        for (const f of secilen) {
          // Sistem cəriməsində 'waived' statusu var → qeyd qalır, tutulmur.
          // Menecer cəriməsində belə status YOXDUR (yalnız pending/acknowledged),
          // ona görə orada məbləği tavana uyğun AZALDIRIQ — sətir yenə qalır.
          let error;
          if (f.menbe === 'Sistem') {
            ({ error } = await db().from('fines').update({ status: 'waived' }).eq('fine_id', f.fine_id));
          } else {
            const yeni = U.round2(Math.max(0, (Number(f.amount) || 0) - f.kesilecek));
            ({ error } = await db().from('mgr_fines').update({
              amount: yeni,
              reason: (f.reason || '') + ' [ƏM 175 — qanuni tavana görə ' + money(f.kesilecek) + ' ₼ azaldıldı]',
            }).eq('fine_id', f.fine_id));
          }
          if (error) console.log('      ❌ Xəta:', error.message);
          else duzelenCem++;
        }
      }
    }
  }

  if (!asanCem) console.log('   ✅ Tavanı aşan yoxdur.');
  return { asan: asanCem, duzelen: duzelenCem };
}

// Maaş konfiqurasiyasına görə bu status tutulurmu?
function cfgTutulur(f) {
  const cfg = U.getSalaryConfig();
  return cfg.fineStatuses.includes(f.status || 'unpaid');
}

(async () => {
  console.log('\n╔══════════════════════════════════════════════════════════════════╗');
  console.log('║  QANUNİ CƏRİMƏ TAVANI AUDİTİ  —  AR Əmək Məcəlləsi, maddə 175   ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log(APPLY
    ? '\n⚠️  --apply VERİLİB: tavanı aşan cərimələr «bağışlanıb» ediləcək.'
    : '\n🔍 QURU İŞLƏMƏ — heç nə yazılmır. Tətbiq üçün: node check-fine-cap.js --apply');
  console.log(`   Baxılan dövr: son ${MONTHS} ay\n`);

  await T.loadAll();
  const tenants = await T.allTenants();
  let toplamAsan = 0, toplamDuzelen = 0;

  for (const t of tenants) {
    const r = await T.run({ tenantId: t.tenant_id, role: 'system', branchId: null },
      () => tenantAudit(t.tenant_id, t.name));
    toplamAsan += r.asan; toplamDuzelen += r.duzelen;
  }

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`NƏTİCƏ: ${toplamAsan} hal tavanı aşır.`);
  if (APPLY) console.log(`        ${toplamDuzelen} cərimə «bağışlanıb» edildi.`);
  else if (toplamAsan) console.log('        Düzəltmək üçün: node check-fine-cap.js --apply');
  console.log('═'.repeat(70) + '\n');
  process.exit(0);
})().catch(e => {
  console.error('\n❌ Xəta:', e.message);
  console.error(e.stack);
  process.exit(1);
});
