'use strict';
// ══════════════════════════════════════════════════════════════════════════
//  YENİ MÜŞTƏRİ QEYDƏ AL (CLI)
// ══════════════════════════════════════════════════════════════════════════
//  Self-serve qeydiyyat səhifəsi Faza 2-dədir. Ona qədər yeni restoran/kofeşop
//  bununla açılır — bir əmrlə hazır sistem (filiallar, vəzifələr, çeklist,
//  smen konfiqurasiyası, bütün panel açarları).
//
//  İŞLƏTMƏ
//  ───────
//    node seed-tenant.js --name "Pizza Land" \
//                        --branches "Nizami, 28 May" \
//                        --positions "Menecer, Ofisiant, Aşpaz" \
//                        --plan trial --trial-days 30
//
//  Parametrlər:
//    --name      (məcburi)  müştərinin adı
//    --id        qısa id (yazılmasa addan qurulur): pizza-land
//    --branches  vergüllə ayrılmış filial adları (defolt: "Əsas filial")
//    --positions vergüllə ayrılmış vəzifələr
//    --plan      trial | basic | pro   (defolt trial)
//    --trial-days       (defolt 30)
//    --max-employees    0 = limitsiz
//    --max-branches     0 = limitsiz
// ══════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const T        = require('./tenant');
const platform = require('./platform');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const list = (s) => String(s || '').split(',').map(x => x.trim()).filter(Boolean);

(async () => {
  const name = arg('name');
  if (!name) {
    console.error('❌  --name tələb olunur.\n');
    console.error('    Nümunə: node seed-tenant.js --name "Pizza Land" --branches "Nizami, 28 May"');
    process.exit(1);
  }

  await T.loadAll();

  const r = await platform.createTenant({
    tenantId:  arg('id'),
    name,
    branches:  list(arg('branches')),
    positions: list(arg('positions')),
    plan:      arg('plan', 'trial'),
    trialDays: Number(arg('trial-days', 30)),
    maxEmployees: Number(arg('max-employees', 0)),
    maxBranches:  Number(arg('max-branches', 0)),
  });

  const host = process.env.PUBLIC_URL || 'http://localhost:3000';
  console.log(`\n🎉  "${name}" yaradıldı   [${r.tenantId}]\n`);
  console.log('🔗  Giriş linkləri — bunları müştəriyə ver:\n');
  console.log(`    Admin       ${host}/admin?key=${r.keys.admin}`);
  console.log(`    İcraçı      ${host}/icraci?key=${r.keys.exec}`);
  console.log(`    Treninq     ${host}/trainer?key=${r.keys.trainer}`);
  console.log(`    Əməliyyat   ${host}/ops?key=${r.keys.ops}`);
  for (const [dept, key] of Object.entries(r.keys.branches)) {
    console.log(`    ${dept.padEnd(11)} ${host}/manager?key=${key}`);
  }
  console.log(`\n    Kiosk       ${host}/scan?t=${r.tenantId}`);
  console.log(`    İmtahan     ${host}/exam?t=${r.tenantId}\n`);
  console.log('⚠️   Növbəti addım: admin panelində maaş dərəcələrini və filial WiFi IP-lərini doldur.\n');
  process.exit(0);
})().catch(e => {
  console.error('\n❌  Alınmadı:', e.message, '\n');
  process.exit(1);
});
