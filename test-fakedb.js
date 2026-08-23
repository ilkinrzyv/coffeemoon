'use strict';
// ══════════════════════════════════════════════════════════════════════════
//  YADDAŞDA SUPABASE ƏVƏZİ  —  davranış testləri üçün
// ══════════════════════════════════════════════════════════════════════════
//  NİYƏ LAZIM OLDU
//  ───────────────
//  Bu vaxta qədər `server.js`-dəki qaydaları yalnız MƏNBƏ MƏTNİ ilə yoxlaya
//  bilirdik (test-multitenant.js §12), çünki fayl require ediləndə dərhal
//  `app.listen` edirdi. Mətn yoxlaması geriyə sürüşməni tutur, amma
//  «bu funksiya SƏHV cavab verirmi?» sualına cavab vermir.
//
//  İndi `server.js` yalnız birbaşa işə salınanda dinləyir (`require.main`),
//  yəni funksiyaları həqiqətən çağırmaq olar. Onların altındakı bazanı bu
//  fayl əvəz edir: sətirlər sadəcə massivdir, filtrlər yaddaşda tətbiq olunur.
//
//  ⚠️ QƏSDƏN REALDIR: `.single()` burada da BİR sətirdən fərqli nəticədə
//  `data: null` + xəta qaytarır. Məhz bu davranış F-25-i doğurmuşdu; taxta
//  onu «düzəltsəydi» testlər səhvi görməzdi.
//
//    const fake = require('./test-fakedb').install();
//    fake.reset({ employees: [...], avans: [...] });
//    fake.store.avans[0].status   // yazılan dəyəri oxu
// ══════════════════════════════════════════════════════════════════════════

function makeFake() {
  const store = {};
  const rowsOf = (t) => (store[t] = store[t] || []);

  function builder(table, op, payload, opts) {
    const filters = [];
    let single = null, limit = null, orderBy = null, orderAsc = true;   // null | 'single' | 'maybe'

    const api = {};
    const add = (fn) => { filters.push(fn); return api; };
    api.eq   = (c, v) => add(r => String(r[c]) === String(v));
    api.neq  = (c, v) => add(r => String(r[c]) !== String(v));
    api.in   = (c, v) => add(r => (v || []).map(String).includes(String(r[c])));
    api.gte  = (c, v) => add(r => r[c] >= v);
    api.lte  = (c, v) => add(r => r[c] <= v);
    api.gt   = (c, v) => add(r => r[c] >  v);
    api.lt   = (c, v) => add(r => r[c] <  v);
    api.is   = (c, v) => add(r => r[c] === v);
    api.like = (c, v) => {
      const rx = new RegExp('^' + String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$');
      return add(r => rx.test(String(r[c] == null ? '' : r[c])));
    };
    api.select      = () => api;
    api.order       = (c, o) => { orderBy = c; orderAsc = !o || o.ascending !== false; return api; };
    api.limit       = (n) => { limit = n; return api; };
    api.range       = (a, b) => { limit = b - a + 1; return api; };
    api.single      = () => { single = 'single'; return api; };
    api.maybeSingle = () => { single = 'maybe';  return api; };
    api.then        = (resolve) => resolve(run());

    const match = () => rowsOf(table).filter(r => filters.every(f => f(r)));

    function run() {
      if (op === 'insert' || op === 'upsert') {
        const rows = Array.isArray(payload) ? payload : [payload];
        for (const row of rows) {
          if (op === 'upsert' && opts && opts.onConflict) {
            const keys = String(opts.onConflict).split(',').map(x => x.trim()).filter(Boolean);
            const i = rowsOf(table).findIndex(r => keys.every(k => String(r[k]) === String(row[k])));
            if (i >= 0) { Object.assign(rowsOf(table)[i], row); continue; }
          }
          rowsOf(table).push({ ...row });
        }
        return { data: rows, error: null };
      }
      if (op === 'update') {
        const hit = match();
        for (const r of hit) Object.assign(r, payload);
        return { data: hit, error: null, count: hit.length };
      }
      if (op === 'delete') {
        const hit = new Set(match());
        store[table] = rowsOf(table).filter(r => !hit.has(r));
        return { data: [...hit], error: null, count: hit.size };
      }

      let out = match();
      if (orderBy) {
        out = out.slice().sort((a, b) => {
          const x = a[orderBy], y = b[orderBy];
          return (x > y ? 1 : x < y ? -1 : 0) * (orderAsc ? 1 : -1);
        });
      }
      if (limit != null) out = out.slice(0, limit);

      // PostgREST-in ƏSL davranışı — bunu «düzəltmirik», bax fayl başlığına.
      //  ⚠️ `single` və `maybeSingle` FƏRQLİDİR və bu fərq vacibdir:
      //  `maybeSingle` 0 sətirdə xəta VERMİR (elə buna görə var), `single` verir.
      //  İlk yazılışda ikisi eyni idi və `getSalaryPeriod` hər çağırışda
      //  saxta xəta logu yazırdı — test bunu üzə çıxardı.
      if (single) {
        if (out.length === 1) return { data: out[0], error: null };
        if (out.length === 0 && single === 'maybe') return { data: null, error: null };
        return { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } };
      }
      return { data: out, error: null, count: out.length };
    }

    return api;
  }

  const sb = {
    from: (table) => ({
      select: () => builder(table, 'select'),
      insert: (rows, o) => builder(table, 'insert', rows, o),
      upsert: (rows, o) => builder(table, 'upsert', rows, o),
      update: (row, o)  => builder(table, 'update', row, o),
      delete: (o)       => builder(table, 'delete', null, o),
    }),
  };

  return {
    sb,
    store,
    // Hər testdən əvvəl çağır — sətirlər KOPYALANIR ki, bir test digərinin
    // datasını dəyişdirməsin (update sətri yerində dəyişir).
    reset(seed) {
      for (const k of Object.keys(store)) delete store[k];
      for (const [t, rows] of Object.entries(seed || {})) store[t] = rows.map(r => ({ ...r }));
    },
  };
}

// `./db`-ni require keşində əvəz edir. Bunu `server.js`/`utils.js`
// require ETMƏZDƏN ƏVVƏL çağır.
function install() {
  const fake = makeFake();
  const path = require.resolve('./db');
  require.cache[path] = { id: path, filename: path, loaded: true, exports: fake.sb };
  return fake;
}

module.exports = { makeFake, install };
