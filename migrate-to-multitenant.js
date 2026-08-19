'use strict';
// ══════════════════════════════════════════════════════════════════════════
//  KÖÇÜRMƏ: köhnə (tək-müştərili) Supabase → yeni (çox-müştərili) Supabase
// ══════════════════════════════════════════════════════════════════════════
//  Coffeemoon-un bütün datasını yeni layihəyə `tenant_id='cm'` etiketi ilə
//  köçürür. KÖHNƏ BAZAYA YAZMIR — yalnız oxuyur. İstənilən vaxt dayandırıla
//  və yenidən işlədilə bilər (upsert ilə təkrar sətir yaranmır).
//
//  HAZIRLIQ
//  ────────
//   1. Yeni Supabase layihəsi yarat.
//   2. Orada `schema-v3-multitenant.sql`-i işlət.
//   3. `.env`-ə köhnə və yeni bazanın açarlarını yaz:
//
//        SUPABASE_URL=...            # KÖHNƏ (mənbə)
//        SUPABASE_SERVICE_KEY=...
//        NEW_SUPABASE_URL=...        # YENİ (hədəf)
//        NEW_SUPABASE_SERVICE_KEY=...
//
//  İŞLƏTMƏ
//  ───────
//     node migrate-to-multitenant.js            # QURU İŞLƏMƏ — heç nə yazmır
//     node migrate-to-multitenant.js --apply    # həqiqətən köçürür
//
//  Sonda bütün giriş linklərini (admin/menecer/icraçı/...) çap edir.
//  ⚠️ İşçilərin `secret` dəyərləri OLDUĞU KİMİ köçürülür → telefonlarındakı
//     quraşdırılmış PWA-lar və köhnə linklər işləməyə davam edir.
// ══════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const APPLY     = process.argv.includes('--apply');
const TENANT_ID = process.env.MIGRATE_TENANT_ID || 'cm';
const TENANT_NM = process.env.MIGRATE_TENANT_NAME || 'Coffeemoon';

const OLD_URL = process.env.SUPABASE_URL;
const OLD_KEY = process.env.SUPABASE_SERVICE_KEY;
const NEW_URL = process.env.NEW_SUPABASE_URL;
const NEW_KEY = process.env.NEW_SUPABASE_SERVICE_KEY;

for (const [k, v] of Object.entries({ SUPABASE_URL: OLD_URL, SUPABASE_SERVICE_KEY: OLD_KEY,
                                      NEW_SUPABASE_URL: NEW_URL, NEW_SUPABASE_SERVICE_KEY: NEW_KEY })) {
  if (!v) { console.error(`❌  .env-də ${k} yoxdur.`); process.exit(1); }
}
if (OLD_URL === NEW_URL) {
  console.error('❌  Mənbə və hədəf eyni bazadır. Yeni layihənin URL-ini yaz.');
  process.exit(1);
}

const mk  = (url, key) => createClient(url, key, { auth: { persistSession: false }, realtime: { transport: ws } });
const src = mk(OLD_URL, OLD_KEY);
const dst = mk(NEW_URL, NEW_KEY);

// ── Coffeemoon-un mövcud qurulusu (köhnə koddan) ─────────────────────────
//  Bunlar KÖHNƏ sistemdə hardcode idi; burada bir dəfə yazılır və yeni
//  bazada artıq DATA olur. Yeni müştərilər bunları özləri təyin edəcək.
const CM_BRANCHES = [
  { branch_id: 'elmler',  name: 'Elmlər',   color: '#bfdbfe', waste_limit: 3.5, sort_order: 0 },
  { branch_id: 'sahil',   name: 'Sahil',    color: '#fbcfe8', waste_limit: 4.0, sort_order: 1 },
  { branch_id: 'genclik', name: 'Gənclik',  color: '#bbf7d0', waste_limit: 2.5, sort_order: 2 },
  { branch_id: 'agseher', name: 'Ağ Şəhər', color: '#fef08a', waste_limit: 3.0, sort_order: 3 },
];
const CM_POSITIONS = ['Team Leader', 'Barista', 'Cashier', 'Cleaner'];

// Köhnə A/B smen qrupları — "Ağ Şəhər" və "Gənclik" A qrupunda idi.
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
const CM_SHIFT_GROUP = (dept) => (dept === 'Ağ Şəhər' || dept === 'Gənclik') ? SHIFT_A : SHIFT_B;

// Köhnə maaş defoltları (utils.DEFAULT_SALARY-dən — indi konfiqurasiyaya köçür)
const CM_SALARY = {
  rates: { 'Team Leader': 23.33, 'Barista': 20, 'Cashier': 20, 'Cleaner': 18.33 },
  defaultRate: 0,
  taxi: 7,
  taxiDepts: ['Ağ Şəhər', 'Gənclik'],
  taxiShifts: ['axsamsm', 'fullsm', 'tamgun'],
  taxiMonthlyLimit: 13,
  restDayPaid: true,
  restDayMultiplier: 1,
  restDayMonthlyLimit: 12,
  fineStatuses: ['unpaid'],
  mgrFinesOnlyAcked: false,
  avansStatuses: ['approved', 'paid'],
};

// ── Avtomatik nömrələnən (BIGSERIAL) cədvəllər ───────────────────────────
//  Bunlarda `id` sütunu bazanın öz sayğacındandır.
//
//  ƏVVƏLKİ YANAŞMA VƏ NİYƏ DƏYİŞDİ:
//  Köhnə id-ləri olduğu kimi köçürürdük. Postgres isə açıq id ilə INSERT
//  edəndə sayğacı İRƏLİ SÜRMÜR — o, 1-də qalırdı. Nəticədə ilk yeni gəliş
//  qeydi (cm, 1) ilə toqquşub yazılmırdı. Bunu ayrıca SQL faylı ilə
//  düzəldirdik, amma bu, unudula bilən əlavə addım idi.
//
//  İNDİ: id-ləri köçürmürük — bazanın özü yeni nömrə verir, sayğac
//  təbii olaraq düzgün qalır və əlavə SQL lazım deyil.
//  Təhlükəsizdir, çünki bu üç cədvəlin `id`-sinə heç bir yerdən istinad
//  yoxdur (sorğular emp_id / endpoint / timestamp üzrə gedir).
//
//  Təkrar işlətməyə davamlılıq: id olmadan upsert təkrar sətir yaradardı,
//  ona görə bu cədvəllər əvvəlcə həmin müştəri üçün TƏMİZLƏNİR, sonra yazılır.
const SERIAL_TABLES = new Set(['attendance', 'push_subscriptions', 'xp_audit_log']);

// ── Köçürüləcək cədvəllər: [ad, münaqişə sütunları] ──────────────────────
//  Ardıcıllıq vacib deyil (xarici açar yalnız tenants-ədir), amma oxunaqlıdır.
const TABLES = [
  ['employees',               'tenant_id,id'],
  ['attendance',              'tenant_id,id'],
  ['nahar',                   'tenant_id,nahar_id'],
  ['scan_devices',            'tenant_id,device_id'],
  ['cedvel',                  'tenant_id,cedvel_id'],
  ['izin',                    'tenant_id,izin_id'],
  ['late_perms',              'tenant_id,perm_id'],
  ['mgr_schedule',            'tenant_id,sched_id'],
  ['checklist_items',         'tenant_id,item_id'],
  ['checklist_logs',          'tenant_id,log_id'],
  ['mgr_acks',                'tenant_id,ack_id'],
  ['products',                'tenant_id,product_id'],
  ['product_logs',            'tenant_id,log_id'],
  ['avans',                   'tenant_id,avans_id'],
  ['fines',                   'tenant_id,fine_id'],
  ['mgr_fines',               'tenant_id,fine_id'],
  ['salary_periods',          'tenant_id,period'],
  ['announcements',           'tenant_id,id'],
  ['profiles',                'tenant_id,emp_id'],
  ['reactions',               'tenant_id,from_emp_id,to_emp_id'],
  ['push_subscriptions',      'tenant_id,id'],
  ['xp_audit_log',            'tenant_id,id'],
  ['trainer_exams',           'tenant_id,exam_id'],
  ['trainer_logs',            'tenant_id,log_id'],
  ['trainer_checklist_items', 'tenant_id,item_id'],
  ['trainer_materials',       'tenant_id,material_id'],
  ['exam_questions',          'tenant_id,question_id'],
  ['ops_visits',              'tenant_id,visit_id'],
  ['ops_ratings',             'tenant_id,rating_id'],
  ['ops_emp_notes',           'tenant_id,note_id'],
  ['ops_issues',              'tenant_id,issue_id'],
];

// Köhnə `settings`-dən KÖÇÜRÜLMƏYƏN açarlar — bunlar artıq başqa yerdədir.
const DROPPED_SETTINGS = [
  /^SCHED_KEY_/,   // → auth_keys
  /^IP_/,          // → branches.wifi_ips
  /^TG_CHAT_/,     // → branches.tg_chat_id
  /^MGR_NAME_/,    // → branches.mgr_name
  /^MGR_MSG_/,     // → branches.mgr_msg
  /^TRAINER_KEY$/, /^EXEC_KEY$/, /^OPS_KEY$/,   // → auth_keys
];

const PAGE = 1000;

// Böyük cədvəlləri səhifə-səhifə oxuyur (Supabase bir sorğuda ~1000 sətir verir).
async function readAll(table) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await src.from(table).select('*').range(from, from + PAGE - 1);
    if (error) {
      if (/does not exist|schema cache/i.test(error.message)) return null;   // köhnə bazada yoxdur
      throw new Error(`${table} oxunmadı: ${error.message}`);
    }
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

async function writeChunks(table, rows, onConflict) {
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await dst.from(table).upsert(chunk, { onConflict });
    if (error) throw new Error(`${table} yazılmadı: ${error.message}`);
  }
}

function randomKey(prefix) {
  const r = () => Math.random().toString(36).slice(2, 10).toUpperCase();
  return `${prefix}${r()}${r()}`;
}

(async () => {
  console.log(`\n${APPLY ? '🚀  KÖÇÜRMƏ' : '🔍  QURU İŞLƏMƏ (heç nə yazılmır)'}`);
  console.log(`    Mənbə : ${OLD_URL}`);
  console.log(`    Hədəf : ${NEW_URL}`);
  console.log(`    Müştəri: ${TENANT_NM}  [${TENANT_ID}]\n`);

  // ── 0. Hədəf sxem hazırdırmı? ──
  const { error: schemaErr } = await dst.from('tenants').select('tenant_id').limit(1);
  if (schemaErr) {
    console.error('❌  Hədəf bazada `tenants` cədvəli tapılmadı.');
    console.error('    Əvvəlcə orada `schema-v3-multitenant.sql`-i işlət.');
    process.exit(1);
  }
  const { data: already } = await dst.from('tenants').select('tenant_id').eq('tenant_id', TENANT_ID).maybeSingle();
  if (already && !APPLY) console.log('ℹ️   Müştəri hədəfdə artıq var — təkrar işlətmə sətirləri yeniləyəcək.\n');

  // ── 1. Köhnə parametrləri oxu (filial IP/chat/idarəçi adları üçün lazımdır) ──
  const oldSettings = (await readAll('settings')) || [];
  const S = Object.fromEntries(oldSettings.map(r => [r.key, r.value]));

  // ── 2. Sətir saylarını göstər ──
  const counts = {};
  let total = 0;
  for (const [table] of TABLES) {
    const rows = await readAll(table);
    counts[table] = rows === null ? null : rows.length;
    if (rows) total += rows.length;
  }
  console.log('📊  Köçürüləcək sətirlər:');
  for (const [t, c] of Object.entries(counts)) {
    if (c === null) console.log(`     ${t.padEnd(24)} — köhnə bazada yoxdur, keçilir`);
    else if (c > 0)  console.log(`     ${t.padEnd(24)} ${String(c).padStart(7)}`);
  }
  console.log(`     ${'CƏMİ'.padEnd(24)} ${String(total).padStart(7)}\n`);

  const keptSettings = oldSettings.filter(r => !DROPPED_SETTINGS.some(rx => rx.test(r.key)));
  console.log(`⚙️   Parametrlər: ${keptSettings.length} köçürülür, ` +
              `${oldSettings.length - keptSettings.length} köhnəlib (filial/açar sütunlarına keçdi)\n`);

  if (!APPLY) {
    console.log('✋  Quru işləmə bitdi. Həqiqətən köçürmək üçün:\n');
    console.log('       node migrate-to-multitenant.js --apply\n');
    return;
  }

  // ── 3. Müştəri sətri ──
  const { error: tErr } = await dst.from('tenants').upsert({
    tenant_id: TENANT_ID,
    name: TENANT_NM,
    slug: TENANT_ID === 'cm' ? 'coffeemoon' : TENANT_ID,
    plan: 'pro',
    status: 'active',
    trial_ends_at: null,
    brand: { displayName: TENANT_NM, icon: 'fa-solid fa-mug-hot',
             themeColor: '#5b5ef4', bgColor: '#f0f2f8', footer: TENANT_NM },
    locale: 'az', currency: 'AZN', timezone: 'Asia/Baku',
  }, { onConflict: 'tenant_id' });
  if (tErr) throw new Error('tenants: ' + tErr.message);
  console.log('✅  Müştəri yaradıldı');

  // ── 4. Filiallar (köhnə parametrlərdən doldurulur) ──
  const branchRows = CM_BRANCHES.map(b => ({
    ...b,
    tenant_id:  TENANT_ID,
    wifi_ips:   S['IP_' + b.branch_id] || '',
    tg_chat_id: S['TG_CHAT_' + { elmler:'Elmler', sahil:'Sahil', genclik:'Genclik', agseher:'AgSeher' }[b.branch_id]] || '',
    mgr_name:   S['MGR_NAME_' + b.branch_id] || '',
    mgr_msg:    S['MGR_MSG_'  + b.branch_id] || '',
    active:     true,
  }));
  await writeChunks('branches', branchRows, 'tenant_id,branch_id');
  console.log(`✅  ${branchRows.length} filial (IP, Telegram chat, idarəçi adları köhnə parametrlərdən götürüldü)`);

  // ── 5. Vəzifələr ──
  await writeChunks('positions',
    CM_POSITIONS.map((name, i) => ({ tenant_id: TENANT_ID, name, sort_order: i, active: true })),
    'tenant_id,name');
  console.log(`✅  ${CM_POSITIONS.length} vəzifə`);

  // ── 6. Parametrlər ──
  //  SHIFT_CONFIG/SALARY_CONFIG köhnə bazada varsa OLDUĞU KİMİ qalır (admin
  //  onları dəyişmiş ola bilər). Yoxdursa köhnə hardcode dəyərləri yazılır ki,
  //  davranış birinci gün eyni olsun.
  const settingRows = keptSettings.map(r => ({ tenant_id: TENANT_ID, key: r.key, value: r.value }));
  if (!S.SHIFT_CONFIG) {
    const cfg = {};
    for (const b of CM_BRANCHES) cfg[b.name] = JSON.parse(JSON.stringify(CM_SHIFT_GROUP(b.name)));
    settingRows.push({ tenant_id: TENANT_ID, key: 'SHIFT_CONFIG', value: JSON.stringify(cfg) });
    console.log('    ↳ SHIFT_CONFIG köhnə A/B qruplarından quruldu');
  }
  if (!S.SALARY_CONFIG) {
    settingRows.push({ tenant_id: TENANT_ID, key: 'SALARY_CONFIG', value: JSON.stringify(CM_SALARY) });
    console.log('    ↳ SALARY_CONFIG köhnə ilkin dəyərlərdən quruldu');
  }
  settingRows.push({ tenant_id: TENANT_ID, key: 'SHIFT_DEFAULT', value: 'B' });
  await writeChunks('settings', settingRows, 'tenant_id,key');
  console.log(`✅  ${settingRows.length} parametr`);

  // ── 7. Data cədvəlləri ──
  for (const [table, onConflict] of TABLES) {
    const rows = await readAll(table);
    if (rows === null || !rows.length) continue;

    if (SERIAL_TABLES.has(table)) {
      // id-siz köçürülür → bazanın sayğacı düzgün qalır (yuxarıdakı izaha bax).
      // Təkrar işlətmə üçün əvvəlcə bu müştərinin sətirləri təmizlənir.
      const { error: delErr } = await dst.from(table).delete().eq('tenant_id', TENANT_ID);
      if (delErr) throw new Error(`${table} təmizlənmədi: ${delErr.message}`);
      const stripped = rows.map(({ id, ...rest }) => ({ ...rest, tenant_id: TENANT_ID }));
      for (let i = 0; i < stripped.length; i += 500) {
        const { error } = await dst.from(table).insert(stripped.slice(i, i + 500));
        if (error) throw new Error(`${table} yazılmadı: ${error.message}`);
      }
      console.log(`✅  ${table.padEnd(24)} ${String(rows.length).padStart(7)} sətir  (id yenidən verildi)`);
      continue;
    }

    await writeChunks(table, rows.map(r => ({ ...r, tenant_id: TENANT_ID })), onConflict);
    console.log(`✅  ${table.padEnd(24)} ${String(rows.length).padStart(7)} sətir`);
  }

  // ── 8. Açarlar ──
  //  Köhnə açarlar (varsa) OLDUĞU KİMİ saxlanılır → mövcud linklər sınmır.
  const keyRows = [];
  const addKey = (key, role, branchId, label) =>
    keyRows.push({ key, tenant_id: TENANT_ID, role, branch_id: branchId || null, label, revoked: false });

  addKey(process.env.ADMIN_KEY || randomKey('AK'), 'admin', null, 'Admin');
  addKey(S.TRAINER_KEY || randomKey('TK'), 'trainer', null, S.TRAINER_NAME || 'Treninq meneceri');
  addKey(S.EXEC_KEY    || randomKey('EK'), 'exec',    null, S.EXEC_NAME    || 'İcraçı');
  addKey(S.OPS_KEY     || randomKey('OK'), 'ops',     null, S.OPS_NAME     || 'Əməliyyat meneceri');
  for (const b of CM_BRANCHES) {
    addKey(S['SCHED_KEY_' + b.branch_id] || randomKey('SK'), 'manager', b.branch_id, b.name);
  }
  const { error: kErr } = await dst.from('auth_keys').upsert(keyRows, { onConflict: 'key' });
  if (kErr) throw new Error('auth_keys: ' + kErr.message);
  console.log(`✅  ${keyRows.length} açar (köhnələri saxlanıldı — mövcud linklər işləməyə davam edir)`);

  // ── 9. Yoxlama ──
  console.log('\n🔎  Yoxlama:');
  let mismatch = 0;
  for (const [table] of TABLES) {
    if (counts[table] === null || counts[table] === 0) continue;
    const { count } = await dst.from(table).select('*', { count: 'exact', head: true }).eq('tenant_id', TENANT_ID);
    const ok = (count || 0) === counts[table];
    if (!ok) mismatch++;
    console.log(`     ${ok ? '✓' : '✗'} ${table.padEnd(24)} köhnə ${counts[table]} → yeni ${count || 0}`);
  }

  // ── 10. Linklər ──
  const host = process.env.PUBLIC_URL || 'http://localhost:3000';
  console.log('\n🔗  Giriş linkləri:');
  for (const k of keyRows) {
    const p = { admin:'/admin', exec:'/icraci', trainer:'/trainer', ops:'/ops', manager:'/manager' }[k.role];
    console.log(`     ${(k.label || k.role).padEnd(22)} ${host}${p}?key=${k.key}`);
  }
  console.log(`     ${'Kiosk (scan)'.padEnd(22)} ${host}/scan?t=${TENANT_ID}`);
  console.log(`     ${'İmtahan'.padEnd(22)} ${host}/exam?t=${TENANT_ID}`);

  console.log(mismatch
    ? `\n⚠️  ${mismatch} cədvəldə say uyğun gəlmədi — yuxarıdakı ✗ sətirlərinə bax.`
    : '\n🎉  Köçürmə tamamlandı, bütün saylar uyğundur.');

  console.log('\n    Əlavə SQL addımı LAZIM DEYİL — nömrələyicilər avtomatik düzgün qalır.\n');
})().catch(e => {
  console.error('\n❌  Köçürmə dayandı:', e.message);
  process.exit(1);
});
