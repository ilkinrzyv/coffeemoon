'use strict';
// ══════════════════════════════════════════════════════════════════════════
//  KEÇİD VƏZİYYƏTİ YOXLAYICISI
// ══════════════════════════════════════════════════════════════════════════
//  Heç nə dəyişmir — yalnız baxır və "indi nə etmək lazımdır" deyir.
//  İstənilən vaxt, istənilən sayda işlədilə bilər.
//
//      node check-setup.js
// ══════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const mk = (url, key) => createClient(url, key, {
  auth: { persistSession: false }, realtime: { transport: ws },
});

const OK = '✅', NO = '❌', WARN = '⚠️ ', DOT = '  ·';
let nextStep = null;
const setNext = (s) => { if (!nextStep) nextStep = s; };

// Açarın tam səlahiyyətli olub-olmadığını yoxlayır.
// Supabase-in İKİ açar formatı var:
//   • köhnə (JWT):  eyJhbGci...  → içindəki `role` sahəsi 'service_role' olmalıdır
//   • yeni:         sb_secret_...  → onsuz da gizli (secret) açardır
// `anon` / `sb_publishable_` açarı ilə RLS keçilmir → köçürmə səssizcə boş qalardı.
function keyRole(key) {
  const k = String(key || '');
  if (k.startsWith('sb_secret_'))      return 'service_role';   // yeni format, tam səlahiyyət
  if (k.startsWith('sb_publishable_')) return 'anon';           // yeni format, məhdud
  try {
    const payload = JSON.parse(Buffer.from(k.split('.')[1], 'base64').toString());
    return payload.role || '?';
  } catch (_) { return '?'; }
}

// Sətir-sətir müqayisə olunan cədvəllər.
// `settings` QƏSDƏN yoxdur: köhnə açarların bir hissəsi (SCHED_KEY_*, IP_*,
// TG_CHAT_*, MGR_NAME_*, MGR_MSG_*, rol açarları) artıq `branches` və
// `auth_keys` sütunlarına köçüb, ona görə say təbii olaraq azalır — bu, xəta
// deyil. Onları burada müqayisə etsək yoxlayıcı boş yerə həyəcan verərdi.
const TABLES = ['employees', 'attendance', 'nahar', 'cedvel', 'izin', 'late_perms',
  'avans', 'fines', 'mgr_fines', 'checklist_logs', 'product_logs', 'trainer_exams',
  'push_subscriptions', 'xp_audit_log'];

async function countRows(client, table, tenantFilter) {
  let q = client.from(table).select('*', { count: 'exact', head: true });
  if (tenantFilter) q = q.eq('tenant_id', tenantFilter);
  const { count, error } = await q;
  if (error) return { err: error.message };
  return { count: count || 0 };
}

(async () => {
  console.log('\n════════════════════════════════════════════════════════════');
  console.log('  KEÇİD VƏZİYYƏTİ');
  console.log('════════════════════════════════════════════════════════════\n');

  // ── ADDIM 1: köhnə baza ────────────────────────────────────────────────
  console.log('1) KÖHNƏ (canlı) baza');
  const oldUrl = process.env.SUPABASE_URL, oldKey = process.env.SUPABASE_SERVICE_KEY;
  let oldClient = null, oldCounts = {};

  if (!oldUrl || !oldKey) {
    console.log(`  ${NO} .env-də SUPABASE_URL / SUPABASE_SERVICE_KEY yoxdur`);
    setNext('`.env`-də köhnə bazanın dəyərləri itib — ehtiyat nüsxədən bərpa et.');
  } else {
    oldClient = mk(oldUrl, oldKey);
    const { error } = await oldClient.from('employees').select('id').limit(1);
    if (error) {
      console.log(`  ${NO} qoşulmaq alınmadı: ${error.message}`);
      setNext('Köhnə bazaya qoşulmaq alınmır — SUPABASE_URL/KEY-i yoxla.');
    } else {
      console.log(`  ${OK} qoşuldu  (${oldUrl})`);
      for (const t of TABLES) {
        const r = await countRows(oldClient, t);
        if (!r.err) oldCounts[t] = r.count;
      }
      const top = Object.entries(oldCounts).filter(([, c]) => c > 0)
        .sort((a, b) => b[1] - a[1]).slice(0, 5);
      console.log(`${DOT} ${Object.keys(oldCounts).length} cədvəl oxundu, ən böyükləri:`);
      for (const [t, c] of top) console.log(`${DOT}   ${t.padEnd(20)} ${String(c).padStart(7)} sətir`);
    }
  }

  // ── ADDIM 2: yeni baza ─────────────────────────────────────────────────
  console.log('\n2) YENİ (çox-müştərili) baza');
  const newUrl = process.env.NEW_SUPABASE_URL, newKey = process.env.NEW_SUPABASE_SERVICE_KEY;

  if (!newUrl || !newKey) {
    console.log(`  ${NO} .env-də NEW_SUPABASE_URL / NEW_SUPABASE_SERVICE_KEY hələ boşdur`);
    setNext(
      'ADDIM 1 — Supabase-də yeni layihə yarat, sonra Settings → API-dən\n' +
      '   `Project URL` və `service_role` açarını .env-dəki boş sətirlərə yaz.'
    );
    return finish();
  }

  if (newUrl === oldUrl) {
    console.log(`  ${NO} YENİ və KÖHNƏ URL eynidir — yeni layihənin URL-ini yaz`);
    setNext('NEW_SUPABASE_URL köhnə ilə eynidir. Yeni layihənin URL-ini yaz.');
    return finish();
  }

  const role = keyRole(newKey);
  if (role !== 'service_role') {
    console.log(`  ${NO} açarın rolu: "${role}" — "service_role" olmalıdır`);
    setNext('Səhv açar köçürülüb. Supabase → Settings → API → `service_role` açarını götür (`anon` yox).');
    return finish();
  }
  console.log(`  ${OK} açar service_role-dur`);

  const nc = mk(newUrl, newKey);
  const { error: connErr } = await nc.from('tenants').select('tenant_id').limit(1);
  if (connErr) {
    if (/does not exist|schema cache|relation/i.test(connErr.message)) {
      console.log(`  ${NO} sxem hələ qurulmayıb (\`tenants\` cədvəli yoxdur)`);
      setNext(
        'ADDIM 2 — Supabase → SQL Editor → New query →\n' +
        '   `schema-v3-multitenant.sql` faylının HAMISINI yapışdır → Run.'
      );
    } else {
      console.log(`  ${NO} qoşulmaq alınmadı: ${connErr.message}`);
      setNext('Yeni bazaya qoşulmaq alınmır — NEW_SUPABASE_URL/KEY-i yoxla.');
    }
    return finish();
  }
  console.log(`  ${OK} qoşuldu  (${newUrl})`);
  console.log(`  ${OK} sxem qurulub`);

  // Storage bucket
  const { data: buckets } = await nc.storage.listBuckets();
  const hasBucket = (buckets || []).some(b => b.name === 'ops-photos');
  console.log(hasBucket
    ? `  ${OK} 'ops-photos' bucket-i var`
    : `  ${WARN} 'ops-photos' bucket-i yoxdur — ops panelində foto yükləmə işləməyəcək`);

  // ── ADDIM 3: köçürmə olubmu? ───────────────────────────────────────────
  console.log('\n3) Köçürmə');
  const tid = process.env.MIGRATE_TENANT_ID || 'cm';
  const { data: tenant } = await nc.from('tenants').select('*').eq('tenant_id', tid).maybeSingle();

  if (!tenant) {
    console.log(`  ${NO} '${tid}' müştərisi hələ yoxdur — köçürmə işlədilməyib`);
    setNext(
      'ADDIM 3 — quru işləmə (heç nə yazmır):\n' +
      '   node migrate-to-multitenant.js'
    );
    return finish();
  }
  console.log(`  ${OK} müştəri var: ${tenant.name}  [${tenant.tenant_id}]  status=${tenant.status}`);

  // Sətir müqayisəsi
  let mismatch = 0, checked = 0;
  const rows = [];
  for (const t of TABLES) {
    if (oldCounts[t] === undefined) continue;
    const r = await countRows(nc, t, tid);
    if (r.err) continue;
    checked++;
    const same = r.count === oldCounts[t];
    if (!same) mismatch++;
    if (oldCounts[t] > 0 || r.count > 0) rows.push([t, oldCounts[t], r.count, same]);
  }
  if (rows.length) {
    console.log(`${DOT} sətir müqayisəsi (köhnə → yeni):`);
    for (const [t, o, n, same] of rows) {
      console.log(`${DOT}   ${same ? '✓' : '✗'} ${t.padEnd(20)} ${String(o).padStart(7)} → ${String(n).padStart(7)}`);
    }
  }

  // Filiallar / açarlar
  const [{ count: brCount }, { data: keys }] = await Promise.all([
    nc.from('branches').select('branch_id', { count: 'exact', head: true }).eq('tenant_id', tid),
    nc.from('auth_keys').select('role,branch_id,key').eq('tenant_id', tid).eq('revoked', false),
  ]);
  console.log(`${DOT} ${brCount || 0} filial, ${(keys || []).length} açar`);

  // ── ADDIM 4: sequence-lər ──────────────────────────────────────────────
  console.log('\n4) Nömrələyicilər (sequence)');
  //  Yoxlama üsulu: cədvələ sınaq sətri yazıb dərhal silirik. Sequence irəli
  //  sürülməyibsə INSERT ilkin açar münaqişəsi verəcək — problem budur.
  let seqOk = true;
  const probe = { emp_id: '__SEQ_TEST__', emp_name: '__SEQ_TEST__', dept: '',
                  timestamp: new Date().toISOString(), type: 'TEST', tenant_id: tid };
  const { data: ins, error: insErr } = await nc.from('attendance').insert(probe).select('id').maybeSingle();
  if (insErr) {
    seqOk = false;
    console.log(`  ${NO} attendance-ə yazmaq alınmadı: ${insErr.message}`);
    if (/duplicate key|already exists/i.test(insErr.message)) {
      setNext(
        'ADDIM 4 — Supabase → SQL Editor →\n' +
        '   `post-migrate-sequences.sql` faylını yapışdır → Run.\n' +
        '   (Bunsuz yeni gəlişlər qeyd olunmayacaq!)'
      );
    }
  } else {
    console.log(`  ${OK} yeni qeyd yazıla bilir (sınaq id=${ins && ins.id})`);
    await nc.from('attendance').delete().eq('tenant_id', tid).eq('emp_id', '__SEQ_TEST__');
    console.log(`${DOT} sınaq sətri silindi`);
  }

  // ── ADDIM 5: Railway ───────────────────────────────────────────────────
  console.log('\n5) Növbəti');
  if (mismatch > 0) {
    console.log(`  ${WARN} ${mismatch} cədvəldə say uyğun gəlmir (yuxarıda ✗)`);
    setNext('Sətir sayları uyğun gəlmir — köçürməni yenidən işlət: node migrate-to-multitenant.js --apply');
  }
  if (seqOk && mismatch === 0) {
    console.log(`  ${OK} baza tam hazırdır`);
    const adminKey = (keys || []).find(k => k.role === 'admin');
    setNext(
      'ADDIM 5 — Railway → Variables:\n' +
      `   SUPABASE_URL         = ${newUrl}\n` +
      '   SUPABASE_SERVICE_KEY = (yeni service_role açarı)\n' +
      `   PLATFORM_KEY         = ${process.env.PLATFORM_KEY || '(.env-dəki dəyər)'}\n` +
      '   ADMIN_KEY            = SİL\n' +
      '   Sonra: mən kodu main-ə push edəcəyəm.' +
      (adminKey ? `\n\n   Admin linkin: /admin?key=${adminKey.key}` : '')
    );
  }

  finish();

  function finish() {
    console.log('\n════════════════════════════════════════════════════════════');
    if (nextStep) {
      console.log('  İNDİ NƏ ETMƏLİ:\n');
      console.log('   ' + nextStep.split('\n').join('\n   '));
    } else {
      console.log('  🎉  Hər şey qaydasındadır.');
    }
    console.log('════════════════════════════════════════════════════════════\n');
    process.exit(0);
  }
})().catch(e => {
  console.error('\n💥 Yoxlama zamanı xəta:', e.message, '\n');
  process.exit(1);
});
