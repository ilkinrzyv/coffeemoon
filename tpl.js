'use strict';
// ══════════════════════════════════════════════════════════════════════════
//  ŞABLON DƏYƏRLƏRİNİN TƏHLÜKƏSİZ YERLƏŞDİRİLMƏSİ
// ══════════════════════════════════════════════════════════════════════════
//  Bu, real bir problemin həllidir: apostroflu dəyər (məs. "Joe's Diner",
//  yaxud adında ' olan işçi) JS sətrinin içinə olduğu kimi yazılanda skript
//  qırılır və PANEL TAM AÇILMIR. Müştəri adları/brendlər artıq kənardan
//  gəldiyi üçün bu risk indi daha böyükdür.
//
//  İki placeholder növü var:
//    <?= ad ?>      → HTML mətn/atribut üçün (HTML-escape)
//    <?= ad_js ?>   → <script> içində dəyər üçün (tam JSON literal, dırnaqla)
//                     Şablonda dırnaq YAZILMIR:   var X = <?= ad_js ?>;
// ══════════════════════════════════════════════════════════════════════════

function htmlEscape(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// JSON literal + <script> daxilində təhlükəsizlik üçün əlavə qaçışlar.
// `</script>` və U+2028/2029 (JS-də sətir sonu sayılır) neytrallaşdırılır.
function jsLiteral(v) {
  return JSON.stringify(v == null ? '' : String(v))
    .replace(/</g, '\\u003C').replace(/>/g, '\\u003E')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function replaceVars(html, vars) {
  let out = html;
  for (const [k, v] of Object.entries(vars)) {
    // `_js` variantı əvvəl işlənir — əks halda `<?= n ?>` naxışı `<?= n_js ?>`
    // sətrinin içindəki `n`-i tutmazdı, amma ardıcıllıq səhv olsa qarışa bilər.
    out = out.replace(new RegExp(`<\\?= ${k}_js \\?>`, 'g'), () => jsLiteral(v));
    out = out.replace(new RegExp(`<\\?= ${k} \\?>`,    'g'), () => htmlEscape(v));
  }
  return out;
}

module.exports = { htmlEscape, jsLiteral, replaceVars };
