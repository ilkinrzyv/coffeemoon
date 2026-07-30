/**
 * common.js — bütün panellərin ortaq köməkçiləri
 *
 * Əvvəl bu funksiyalar hər HTML faylında ayrıca kopyalanmışdı (admin, manager,
 * icraci, ops, mycode). Ən təhlükəlisi `generateDynamicPin` idi: 3 nüsxə vardı və
 * biri dəyişsəydi heç kim gəliş qeyd edə bilməzdi.
 *
 * DİQQƏT:
 *  - Burada YALNIZ `function` elanları olmalıdır. `const`/`let` işlətsən və panelin
 *    öz skriptində eyni ad varsa, səhifə SyntaxError verib TAM sınır.
 *  - `generateDynamicPin` serverdəki `utils.js` nüsxəsi ilə HƏRFİ-HƏRFİNƏ eyni
 *    nəticə verməlidir. Birini dəyişsən, o birini də dəyiş (test-pin.js ilə yoxla).
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

/* Dinamik PIN — server (utils.js) ilə EYNİ alqoritm. 10 saniyəlik pəncərə (tw). */
function generateDynamicPin(secret, tw) {
  var str = String(secret) + String(tw), hash = 0;
  for (var i = 0; i < str.length; i++) { hash = (hash << 5) - hash + str.charCodeAt(i); hash |= 0; }
  hash ^= (hash << 13); hash ^= (hash >>> 17); hash ^= (hash << 5);
  return (Math.abs(Math.imul(hash, 1664525) + 1013904223) % 10000).toString().padStart(4, '0');
}
