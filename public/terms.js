/**
 * TERMİNOLOGİYA
 * ─────────────
 * Sistem kofeşop lüğəti ilə yazılıb ("Filial", "Nahar", "Smen"...). Başqa
 * sahələr üçün bu sözlər uyğun gəlmir: mağazada "Şöbə", ofisdə "Növbə" deyilir.
 *
 * Bu skript müştərinin seçdiyi əvəzləmələri səhifədəki MƏTNLƏRƏ tətbiq edir.
 *
 * NİYƏ BRAUZERDƏ, SERVERDƏ YOX?
 * Panellərin böyük hissəsi JS ilə qurulur (`'<div>Filial</div>'` kimi sətirlər).
 * Serverdə yalnız statik HTML-i əvəz etsək, dinamik qurulan yazılar köhnə
 * sözlə qalardı. Burada isə mətn düyünləri gəzilir → hər ikisi tutulur.
 *
 * TƏHLÜKƏSİZLİK
 * · Yalnız MƏTN düyünlərinə toxunur — teq adları, class, id, JS dəyişənləri
 *   toxunulmaz qalır.
 * · <script>, <style>, <input>, <textarea> tamamilə atlanır.
 * · Əvəzləmə yoxdursa (defolt hal) skript heç nə etmir — sıfır risk.
 */
(function () {
  'use strict';

  var T = window.TERMS;
  if (!T || !Object.keys(T).length) return;   // əvəzləmə yoxdur → çıx

  var SKIP = { SCRIPT: 1, STYLE: 1, INPUT: 1, TEXTAREA: 1, SELECT: 1, CODE: 1, PRE: 1 };

  // Azərbaycan dilində i↔İ və ı↔I fərqlidir — sadə toUpperCase() səhv verir.
  function up(s) { try { return s.toLocaleUpperCase('az'); } catch (e) { return s.toUpperCase(); } }
  function low(s) { try { return s.toLocaleLowerCase('az'); } catch (e) { return s.toLowerCase(); } }

  // Orijinalın böyük/kiçik naxışını əvəzləyənə köçürür:
  //   FİLİAL → ŞÖBƏ,  Filial → Şöbə,  filial → şöbə
  function matchCase(src, dst) {
    if (src === up(src) && src !== low(src)) return up(dst);
    if (src[0] === up(src[0])) return up(dst[0]) + low(dst.slice(1));
    return low(dst);
  }

  // ── Şəkilçi və sait ahəngi ──────────────────────────────────────
  //  Azərbaycan dili şəkilçilidir: "Filial" → filialDA, filialIN, filialLAR.
  //  Yalnız tam sözü əvəz etsək, mətnlərin çoxu dəyişməz qalar.
  //  Ona görə: kök + şəkilçi tutulur, kök əvəzlənir, şəkilçinin saitləri isə
  //  YENİ kökün ahənginə uyğunlaşdırılır:
  //     İşçi + lər  →  Əməkdaş + lar   ("Əməkdaşlər" yanlış olardı)
  //     Filial + da →  Şöbə + də
  var BACK = 'aıou', FRONT = 'eəiöü';
  var HARM = { 'a':'ə', 'ə':'a', 'ı':'i', 'i':'ı', 'u':'ü', 'ü':'u', 'o':'ö', 'ö':'o' };

  // Sözün son saitinə görə qalın (back) yoxsa incə (front) olduğunu tapır
  function isBack(word) {
    var w = low(word);
    for (var i = w.length - 1; i >= 0; i--) {
      if (BACK.indexOf(w[i]) >= 0) return true;
      if (FRONT.indexOf(w[i]) >= 0) return false;
    }
    return true;   // saitsizdirsə qalın sayılır
  }

  // Şəkilçinin saitlərini yeni kökün ahənginə çevirir
  function harmonize(suffix, stemIsBack) {
    var out = '';
    for (var i = 0; i < suffix.length; i++) {
      var ch = suffix[i], lc = low(ch), isVowel = (BACK + FRONT).indexOf(lc) >= 0;
      if (!isVowel) { out += ch; continue; }
      var chBack = BACK.indexOf(lc) >= 0;
      // Sait artıq düzgün ahəngdədirsə toxunma, deyilsə cütünə çevir
      var newCh = (chBack === stemIsBack) ? lc : (HARM[lc] || lc);
      out += (ch === up(ch) && ch !== low(ch)) ? up(newCh) : newCh;
    }
    return out;
  }

  // ── Bitişdirici samit ───────────────────────────────────────────
  //  Saitlə bitən kökdən sonra şəkilçi bitişdirici samit alır:
  //     İşçi + (n)in ,  Fasilə + (y)ə
  //  Samitlə bitəndə isə almır:
  //     Əməkdaş + ın ,  Nahar + a
  //  Kök dəyişəndə bu da dəyişməlidir, yoxsa "Əməkdaşnın" kimi söz çıxır.
  var VOWELS = BACK + FRONT;
  var isVowelCh = function (c) { return VOWELS.indexOf(low(c)) >= 0; };
  var endsVowel = function (w) { return w && isVowelCh(w[w.length - 1]); };

  function fixSuffix(suffix, oldStem, newStem) {
    if (!suffix) return '';
    var core = suffix;
    // Köhnə kök saitlə bitirdisə, şəkilçinin əvvəlindəki bitişdiricini at
    if (endsVowel(oldStem) && /^[nysNYS]/.test(core) && core.length > 1 && isVowelCh(core[1])) {
      core = core.slice(1);
    }
    // Yeni kök saitlə bitirsə və şəkilçi saitlə başlayırsa bitişdirici əlavə et.
    // Tək sait (yönlük hal: -a/-ə) → "y", qalanları → "n".
    if (endsVowel(newStem) && isVowelCh(core[0])) {
      core = (core.length === 1 ? 'y' : 'n') + core;
    }
    return harmonize(core, isBack(newStem));
  }

  // ── Axtarış naxışı ──────────────────────────────────────────────
  //  Azərbaycan dilində i/İ və ı/I ayrı hərf cütləridir; JS-in `i` bayrağı
  //  onları düzgün uyğunlaşdırmır (İ → i̇ olur). Ona görə hər i-ailəsi hərfini
  //  açıq şəkildə simvol sinfinə çeviririk.
  var LETTER = 'A-Za-zƏəÖöÜüÇçŞşĞğİıI';
  function pattern(word) {
    return word.split('').map(function (ch) {
      if ('iİ'.indexOf(ch) >= 0) return '[iİ]';
      if ('ıI'.indexOf(ch) >= 0) return '[ıI]';
      if (/[.*+?^${}()|[\]\\]/.test(ch)) return '\\' + ch;
      return ch;
    }).join('');
  }

  var rules = [];
  Object.keys(T).forEach(function (k) {
    var v = T[k];
    if (!v || low(v) === low(k)) return;               // dəyişməyib → qaydaya salma
    rules.push({
      // (əvvəl)(kök)(şəkilçi — ən çox 6 hərf)
      re: new RegExp('(^|[^' + LETTER + '])(' + pattern(k) + ')([' + LETTER + ']{0,6})(?![' + LETTER + '])', 'gi'),
      from: k,
      to: v,
    });
  });
  if (!rules.length) return;

  function convert(text) {
    var out = text;
    for (var i = 0; i < rules.length; i++) {
      (function (rule) {
        out = out.replace(rule.re, function (m, pre, word, suffix) {
          return pre + matchCase(word, rule.to) + fixSuffix(suffix, rule.from, rule.to);
        });
      })(rules[i]);
    }
    return out;
  }

  function walk(root) {
    if (!root) return;
    // Yalnız mətn düyünləri; qadağan olunmuş valideyn içindəkilər atlanır.
    var it = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        for (var p = n.parentNode; p && p !== root.parentNode; p = p.parentNode) {
          if (p.nodeType === 1 && SKIP[p.tagName]) return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    var n, batch = [];
    while ((n = it.nextNode())) batch.push(n);
    for (var i = 0; i < batch.length; i++) {
      var v = batch[i].nodeValue, nv = convert(v);
      if (nv !== v) batch[i].nodeValue = nv;
    }
    // placeholder/title kimi görünən atributlar
    if (root.querySelectorAll) {
      var els = root.querySelectorAll('[placeholder],[title]');
      for (var j = 0; j < els.length; j++) {
        ['placeholder', 'title'].forEach(function (a) {
          var val = els[j].getAttribute(a);
          if (val) { var c = convert(val); if (c !== val) els[j].setAttribute(a, c); }
        });
      }
    }
  }

  function run() {
    walk(document.body);
    // Panellər məzmunu sonradan JS ilə qurur → dəyişiklikləri izləyirik.
    // Öz dəyişikliyimiz yenidən tetikləməsin deyə bayraq işlədilir.
    var busy = false;
    new MutationObserver(function (muts) {
      if (busy) return;
      busy = true;
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          if (added[j].nodeType === 1) walk(added[j]);
          else if (added[j].nodeType === 3 && added[j].nodeValue) {
            var c = convert(added[j].nodeValue);
            if (c !== added[j].nodeValue) added[j].nodeValue = c;
          }
        }
      }
      busy = false;
    }).observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
