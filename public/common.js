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

/* Dəyəri `onclick="fn('<BURA>')"` kontekstinə təhlükəsiz yerləşdirir.
 *
 * Burada İKİ ayrı parser var və hər ikisi öz qaydası ilə oxuyur:
 *   1. Brauzer əvvəlcə atributu HTML-dekod edir  ("  &quot; → "  )
 *   2. SONRA nəticəni JS kimi ayrıştırır          (  \' → '     )
 * Ona görə qaçış sırası da məhz belədir: əvvəl JS, sonra HTML.
 * Tərs sıra yazsaq HTML-dekod bizim JS qaçışımızı geri açardı.
 *
 * `esc()` tək dırnağı QƏSDƏN qaçırmır — biz onu `\'` kimi buraxırıq ki,
 * HTML-dekoddan sonra JS üçün düzgün qaçış olsun. Atributu qoruyan isə
 * `esc()`-in `"` → `&quot;` çevirməsidir.
 *
 * ⚠️ Yalnız bu kontekst üçündür. Adi mətn üçün `esc()` işlət.
 */
function escJs(s) {
  return esc(String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"));
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
