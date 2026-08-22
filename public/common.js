/**
 * common.js — bütün panellərin ortaq köməkçiləri
 *
 * Əvvəl bu funksiyalar hər HTML faylında ayrıca kopyalanmışdı (admin, manager,
 * icraci, ops, mycode).
 *
 * DİQQƏT: Burada YALNIZ `function` elanları olmalıdır. `const`/`let` işlətsən və
 * panelin öz skriptində eyni ad varsa, səhifə SyntaxError verib TAM sınır.
 *
 * QEYD: `generateDynamicPin` 2026-08-22-də SİLİNDİ. Dinamik PIN sistemi tamamilə
 * ləğv olundu — işçi artıq `secret` ilə tanınır, «oradasan» sübutu isə kiosk QR
 * tokeni + filial WiFi IP-sidir. (Səbəb: 4 rəqəm = 10 000 variant, toqquşmada
 * gəliş SƏHV işçiyə yazılırdı; üstəlik secret onsuz da hər sorğuda gedirdi.)
 */

/* HTML-ə yazılan mətni təhlükəsizləşdirir (ad, qeyd, filial və s.) */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}

/* Date → "YYYY-MM-DD" (yerli saat, UTC deyil — bütün sistem yerli günlə işləyir) */
function toYMD(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

/* "YYYY-MM-DD" və ya Date → "DD.MM.YYYY"; tanınmayan dəyəri olduğu kimi qaytarır */
function fmtDMY(s) {
  if (!s) return '';
  if (s instanceof Date)
    return String(s.getDate()).padStart(2, '0') + '.' +
           String(s.getMonth() + 1).padStart(2, '0') + '.' +
           s.getFullYear();
  var p = String(s).split('-');
  return p.length === 3 ? p[2] + '.' + p[1] + '.' + p[0] : String(s);
}
