'use strict';
// ══════════════════════════════════════════════════════════════════════════
//  AVTO-SCOPE EDƏN DB QATI
// ══════════════════════════════════════════════════════════════════════════
//  Problem: server.js-də 265 ədəd `sb.from(...)` çağırışı var. Hər birinə əl ilə
//  `.eq('tenant_id', …)` yazsaq, BİR unudulan yer bir müştərinin datasını
//  başqasına göstərər. İnsan yaddaşına güvənilə bilməz.
//
//  Həll: `sb.` yerinə `db().` yazılır və bu sarğı tenant filtrini ÖZÜ əlavə edir:
//
//     db().from('employees').select('*')
//        → sb.from('employees').select('*').eq('tenant_id', <cari müştəri>)
//
//     db().from('attendance').insert({ emp_id: … })
//        → sb.from('attendance').insert({ emp_id: …, tenant_id: <cari müştəri> })
//
//  Kontekst yoxdursa `tenant.tenantId()` XƏTA atır → scope edilməmiş sorğu
//  bazaya ümumiyyətlə çatmır (fail-closed).
//
//  ⚠️  QAYDA: server kodunda birbaşa `sb`/`require('./db')` İŞLƏTMƏ.
//      Yeganə istisnalar `tenant.js` (registrləri yükləyir) və
//      `platform.js` (tenants/auth_keys idarə edir) — onlar `raw`-dan istifadə edir.
// ══════════════════════════════════════════════════════════════════════════

const sb     = require('./db');
const tenant = require('./tenant');

// Bu iki cədvəl bütün platformaya aiddir — tenant_id sütunları yoxdur/scope edilmir.
const GLOBAL_TABLES = new Set(['tenants', 'auth_keys']);

// Sətrə (və ya sətir massivinə) tenant_id yazır.
// Çağıranın verdiyi tenant_id QƏSDƏN üstələnir: heç kim başqa müştəriyə yaza bilməz.
function stamp(rows, tid) {
  if (Array.isArray(rows)) return rows.map(r => ({ ...r, tenant_id: tid }));
  return { ...rows, tenant_id: tid };
}

// UPDATE payload-undan tenant_id-ni çıxarır — sətri başqa müştəriyə köçürmək olmaz.
function stripTenant(row) {
  if (!row || typeof row !== 'object') return row;
  if (!('tenant_id' in row)) return row;
  const { tenant_id, ...rest } = row;
  return rest;
}

// upsert-in münaqişə hədəfinə tenant_id əlavə edir.
// Səbəb: ilkin açarlar artıq (tenant_id, …) şəklindədir; `onConflict:'device_id'`
// qalsa Postgres uyğun unikal indeks tapmayıb xəta verər.
function scopeConflict(opts) {
  if (!opts || !opts.onConflict) return opts;
  const cols = String(opts.onConflict).split(',').map(s => s.trim()).filter(Boolean);
  if (cols[0] === 'tenant_id') return opts;
  return { ...opts, onConflict: ['tenant_id', ...cols].join(',') };
}

function scopedFrom(table, tid) {
  if (GLOBAL_TABLES.has(table)) {
    throw new Error(
      `'${table}' platforma cədvəlidir — db() ilə açıla bilməz. ` +
      `Onu idarə etmək üçün platform.js / tdb.raw işlət.`
    );
  }

  return {
    // SELECT → tenant filtri dərhal əlavə olunur; qalan zəncir (eq/in/order/single…)
    // Supabase-in öz builder-i üzərində davam edir.
    select: (...args) => sb.from(table).select(...args).eq('tenant_id', tid),

    insert: (rows, opts) => sb.from(table).insert(stamp(rows, tid), opts),

    upsert: (rows, opts) => sb.from(table).upsert(stamp(rows, tid), scopeConflict(opts)),

    update: (row, opts) => sb.from(table).update(stripTenant(row), opts).eq('tenant_id', tid),

    delete: (opts) => sb.from(table).delete(opts).eq('tenant_id', tid),
  };
}

// Əsas giriş: cari sorğunun müştərisi ALS kontekstindən götürülür.
function db() {
  const tid = tenant.tenantId();          // kontekst yoxdursa burada xəta atılır
  return { from: (table) => scopedFrom(table, tid) };
}

// Müştəri açıq şəkildə verilir — köçürmə skripti və platforma əməliyyatları üçün.
function dbFor(tid) {
  if (!tid) throw new Error('dbFor(): tenantId tələb olunur.');
  return { from: (table) => scopedFrom(table, tid) };
}

module.exports = { db, dbFor, raw: sb, GLOBAL_TABLES };
