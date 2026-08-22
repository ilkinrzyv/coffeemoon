-- ══════════════════════════════════════════════════════════════════════════
--  ÇOX-MÜŞTƏRİLİ (MULTI-TENANT) SXEM  —  v3
--  TƏMİZ Supabase layihəsində işlədilir (mövcud Coffeemoon bazasında YOX).
--  Data köçürməsi: `node migrate-to-multitenant.js` (ayrıca fayl).
-- ══════════════════════════════════════════════════════════════════════════
--
--  ƏSAS QAYDA
--  ──────────
--  İki cədvəldən başqa HƏR cədvəldə `tenant_id` var və ilkin açar
--  `(tenant_id, ...)` ilə başlayır. Qlobal qalan iki cədvəl:
--
--    • tenants    — müştərilərin özü
--    • auth_keys  — panel açarları (açar → hansı müştəri + hansı rol)
--
--  Serverdəki `tdb.js` sarğısı hər sorğuya tenant_id-ni AVTOMATİK əlavə edir.
--  Kontekst olmadan sorğu atılsa xəta verir → data sızması mümkün deyil.
--
--  QLOBAL UNİKAL OLMALI OLAN 3 DƏYƏR (müştəri məlum olmadan tanınırlar)
--  ────────────────────────────────────────────────────────────────────
--    1. auth_keys.key            — panel açarları (admin/menecer/icraçı/...)
--    2. employees.secret         — işçi giriş açarı (/mycode?secret=…)
--    3. scan_devices.device_id   — filial kiosk cihazı
--  Bunlar təsadüfi uzun sətirlərdir; toqquşma ehtimalı praktiki olaraq sıfırdır,
--  amma UNIQUE indeks bunu bazada da təmin edir.
-- ══════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────
--  0. QORUYUCU
-- ─────────────────────────────────────────────────────────────────────────
--  Aşağıdakı `DROP TABLE` blokunu təsadüfən İKİNCİ DƏFƏ işlətmək bütün
--  datanı silir. Bu, real olaraq baş verdi: SQL Editor-də köhnə sorğu tabı
--  açıq qalmışdı və yenidən Run edildi → köçürülmüş 4115 sətir yox oldu.
--
--  Bu blok həmin səhvi mümkünsüz edir: bazada artıq müştəri varsa skript
--  DAYANIR və heç nə silmir.
--
--  Həqiqətən sıfırdan qurmaq istəyirsənsə əvvəlcə əl ilə:
--      DELETE FROM tenants;
-- ─────────────────────────────────────────────────────────────────────────
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'tenants')
     AND EXISTS (SELECT 1 FROM public.tenants)
  THEN
    RAISE EXCEPTION
      E'DAYANDIRILDI: bu bazada artıq müştəri datası var.\n'
      'Bu fayl cədvəlləri SİLİB yenidən qurur — işlətsən hər şey itər.\n'
      'Sxem onsuz da qurulub; sənə yəqin ki başqa fayl lazımdır '
      '(post-migrate-sequences.sql və ya fix-*.sql).';
  END IF;
END
$guard$;

-- ─────────────────────────────────────────────────────────────────────────
--  1. TƏMİZLİK (yalnız təzə layihədə)
-- ─────────────────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS ops_ratings            CASCADE;
DROP TABLE IF EXISTS ops_emp_notes          CASCADE;
DROP TABLE IF EXISTS ops_issues             CASCADE;
DROP TABLE IF EXISTS ops_visits             CASCADE;
DROP TABLE IF EXISTS xp_audit_log           CASCADE;
DROP TABLE IF EXISTS trainer_exams          CASCADE;
DROP TABLE IF EXISTS trainer_logs           CASCADE;
DROP TABLE IF EXISTS trainer_materials      CASCADE;
DROP TABLE IF EXISTS trainer_checklist_items CASCADE;
DROP TABLE IF EXISTS exam_questions         CASCADE;
DROP TABLE IF EXISTS push_subscriptions     CASCADE;
DROP TABLE IF EXISTS reactions              CASCADE;
DROP TABLE IF EXISTS profiles               CASCADE;
DROP TABLE IF EXISTS salary_periods         CASCADE;
DROP TABLE IF EXISTS mgr_fines              CASCADE;
DROP TABLE IF EXISTS fines                  CASCADE;
DROP TABLE IF EXISTS avans                  CASCADE;
DROP TABLE IF EXISTS announcements          CASCADE;
DROP TABLE IF EXISTS late_perms             CASCADE;
DROP TABLE IF EXISTS mgr_schedule           CASCADE;
DROP TABLE IF EXISTS product_logs           CASCADE;
DROP TABLE IF EXISTS products               CASCADE;
DROP TABLE IF EXISTS mgr_acks               CASCADE;
DROP TABLE IF EXISTS checklist_logs         CASCADE;
DROP TABLE IF EXISTS checklist_items        CASCADE;
DROP TABLE IF EXISTS izin                   CASCADE;
DROP TABLE IF EXISTS cedvel                 CASCADE;
DROP TABLE IF EXISTS scan_devices           CASCADE;
DROP TABLE IF EXISTS nahar                  CASCADE;
DROP TABLE IF EXISTS attendance             CASCADE;
DROP TABLE IF EXISTS employees              CASCADE;
DROP TABLE IF EXISTS positions              CASCADE;
DROP TABLE IF EXISTS branches               CASCADE;
DROP TABLE IF EXISTS settings               CASCADE;
DROP TABLE IF EXISTS auth_keys              CASCADE;
DROP TABLE IF EXISTS tenants                CASCADE;

-- ═════════════════════════════════════════════════════════════════════════
--  1. PLATFORMA QATI  (qlobal — tenant_id YOXDUR)
-- ═════════════════════════════════════════════════════════════════════════

-- Müştərilər. Coffeemoon burada sadəcə bir sətirdir.
CREATE TABLE tenants (
  tenant_id     TEXT PRIMARY KEY,              -- 'cm', 'pizzaland' — qısa, dəyişməz
  name          TEXT NOT NULL,                 -- 'Coffeemoon'
  slug          TEXT UNIQUE,                   -- gələcək subdomain: coffeemoon.<domen>
  custom_domain TEXT UNIQUE,                   -- gələcək: öz domeni

  -- Abunəlik
  plan          TEXT NOT NULL DEFAULT 'trial', -- trial | basic | pro
  status        TEXT NOT NULL DEFAULT 'active',-- active | suspended | expired
  trial_ends_at DATE,
  max_employees INTEGER DEFAULT 0,             -- 0 = limitsiz
  max_branches  INTEGER DEFAULT 0,             -- 0 = limitsiz

  -- Görünüş və lokal parametrlər
  brand         JSONB NOT NULL DEFAULT '{}',   -- {displayName, icon, themeColor, bgColor, footer, terms:{...}}
  locale        TEXT NOT NULL DEFAULT 'az',
  currency      TEXT NOT NULL DEFAULT 'AZN',
  timezone      TEXT NOT NULL DEFAULT 'Asia/Baku',

  notes         TEXT DEFAULT '',               -- platforma sahibinin daxili qeydi
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON COLUMN tenants.status IS
  'suspended/expired → API dispatcher bütün sorğuları 402/403 ilə rədd edir (data silinmir).';
COMMENT ON COLUMN tenants.slug IS
  'Faza 3 üçün ehtiyat: subdomain ilə giriş. Hazırda tenant açardan tapılır.';

-- Bütün panel açarları. Tenant həlli BU cədvəldən başlayır.
CREATE TABLE auth_keys (
  key         TEXT PRIMARY KEY,                -- qlobal unikal təsadüfi sətir
  tenant_id   TEXT REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  role        TEXT NOT NULL,                   -- platform | admin | manager | exec | trainer | ops
  branch_id   TEXT,                            -- yalnız role='manager' üçün
  label       TEXT DEFAULT '',                 -- kimə verilib (insan üçün qeyd)
  revoked     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  CONSTRAINT auth_keys_role_chk
    CHECK (role IN ('platform','admin','manager','exec','trainer','ops')),
  -- 'platform' rolu bütün müştərilərin üstündədir → tenant_id-si olmur.
  -- Qalan bütün rollar mütləq bir müştəriyə bağlıdır.
  CONSTRAINT auth_keys_tenant_chk
    CHECK ((role = 'platform' AND tenant_id IS NULL)
        OR (role <> 'platform' AND tenant_id IS NOT NULL))
);

CREATE INDEX idx_auth_keys_tenant ON auth_keys (tenant_id, role);

-- Hər müştəridə hər roldan yalnız BİR aktiv açar (menecer istisna — filial başına bir).
CREATE UNIQUE INDEX idx_auth_keys_singleton
  ON auth_keys (tenant_id, role)
  WHERE revoked = FALSE AND role IN ('admin','exec','trainer','ops');
CREATE UNIQUE INDEX idx_auth_keys_mgr
  ON auth_keys (tenant_id, branch_id)
  WHERE revoked = FALSE AND role = 'manager';

-- ═════════════════════════════════════════════════════════════════════════
--  2. MÜŞTƏRİ KONFİQURASİYASI
-- ═════════════════════════════════════════════════════════════════════════

-- Açar-dəyər parametrlər (SHIFT_CONFIG, SALARY_CONFIG, TG_*, EXAM_ACTIVE, ...)
-- Əvvəl qlobal idi → indi hər müştərinin öz dəsti var.
CREATE TABLE settings (
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  key       TEXT NOT NULL,
  value     TEXT DEFAULT '',
  PRIMARY KEY (tenant_id, key)
);

-- FİLİALLAR — əvvəl utils.js-də `DEPT_SLUG` hardcode idi.
-- Bununla birlikdə bunlar da koddan silinir:
--   IP_<slug>, TG_CHAT_<Ad>, MGR_NAME_<slug>, MGR_MSG_<slug>, WASTE_LIMITS
CREATE TABLE branches (
  tenant_id   TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  branch_id   TEXT NOT NULL,                   -- slug: 'elmler'
  name        TEXT NOT NULL,                   -- 'Elmlər' — qeydlərdə saxlanan ad
  color       TEXT DEFAULT '#bfdbfe',          -- paneldəki rəng nişanı
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      BOOLEAN NOT NULL DEFAULT TRUE,

  wifi_ips    TEXT DEFAULT '',                 -- vergüllə ayrılmış IP prefiksləri
  tg_chat_id  TEXT DEFAULT '',                 -- filialın Telegram qrupu
  waste_limit NUMERIC(5,2) DEFAULT 3.0,        -- icazə verilən itki faizi
  mgr_name    TEXT DEFAULT '',                 -- filial idarəçisinin adı
  mgr_msg     TEXT DEFAULT '',                 -- admindən idarəçiyə mesaj

  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, branch_id),
  -- Filial ADI müştəri daxilində unikaldır: bütün qeydlər (attendance, cedvel, …)
  -- filialı ADI ilə saxlayır, ona görə iki eyni adlı filial ola bilməz.
  UNIQUE (tenant_id, name)
);

COMMENT ON TABLE branches IS
  'Filialın adını dəyişmək tarixçəni qırır → server `renameBranch` ilə bütün '
  'denormallaşdırılmış `dept` sütunlarını kaskad yeniləyir. Əl ilə UPDATE ETMƏ.';

-- VƏZİFƏLƏR — əvvəl utils.js-də `POSITIONS` hardcode idi.
-- Restoranda "Ofisiant", kofeşopda "Barista" ola bilər → müştəri özü təyin edir.
CREATE TABLE positions (
  tenant_id  TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (tenant_id, name)
);

-- ═════════════════════════════════════════════════════════════════════════
--  3. İŞÇİLƏR VƏ DAVAMİYYƏT
-- ═════════════════════════════════════════════════════════════════════════

CREATE TABLE employees (
  tenant_id          TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  id                 TEXT NOT NULL,
  name               TEXT NOT NULL,
  dept               TEXT DEFAULT '',          -- branches.name
  position           TEXT DEFAULT '',          -- positions.name
  secret             TEXT,                     -- giriş açarı — QLOBAL unikal (aşağıda indeks)
  device_id          TEXT DEFAULT '',
  message            TEXT DEFAULT '',
  streak             INTEGER DEFAULT 0,
  xp                 INTEGER DEFAULT 0,
  milestones_claimed JSONB DEFAULT '[]',
  taxi_limit         INTEGER,                  -- NULL → ümumi limit
  is_test            BOOLEAN DEFAULT FALSE,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (tenant_id, id)
);

-- İşçi /mycode?secret=… ilə girir — o anda hansı müştəri olduğu MƏLUM DEYİL,
-- ona görə secret bütün platforma üzrə unikal olmalıdır.
CREATE UNIQUE INDEX idx_employees_secret_global ON employees (secret) WHERE secret IS NOT NULL;
CREATE INDEX idx_employees_dept     ON employees (tenant_id, dept);
CREATE INDEX idx_employees_position ON employees (tenant_id, position);

CREATE TABLE attendance (
  tenant_id  TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  id         BIGSERIAL,
  emp_id     TEXT NOT NULL,
  emp_name   TEXT,
  dept       TEXT,
  timestamp  TIMESTAMPTZ NOT NULL,
  type       TEXT,                             -- GƏLİŞ | CIXIS
  overtime   TEXT DEFAULT '',
  shift_type TEXT DEFAULT '',
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX idx_attendance_emp_type_ts ON attendance (tenant_id, emp_id, type, timestamp);
CREATE INDEX idx_attendance_ts          ON attendance (tenant_id, timestamp);

CREATE TABLE nahar (
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  nahar_id  TEXT NOT NULL,
  emp_id    TEXT NOT NULL,
  emp_name  TEXT,
  dept      TEXT,
  timestamp TIMESTAMPTZ NOT NULL,
  type      TEXT,                              -- NAHAR_GET | NAHAR_QAY
  PRIMARY KEY (tenant_id, nahar_id)
);
CREATE INDEX idx_nahar_emp ON nahar (tenant_id, emp_id);

CREATE TABLE scan_devices (
  tenant_id  TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  device_id  TEXT NOT NULL,
  branch     TEXT DEFAULT '',
  status     TEXT DEFAULT 'pending',           -- pending | approved | blocked
  label      TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (tenant_id, device_id)
);
-- Kiosk cihazı özünü yalnız device_id ilə tanıdır → qlobal unikal olmalıdır.
CREATE UNIQUE INDEX idx_scan_devices_global ON scan_devices (device_id);

-- ═════════════════════════════════════════════════════════════════════════
--  4. CƏDVƏL / İZİN / İCAZƏ
-- ═════════════════════════════════════════════════════════════════════════

CREATE TABLE cedvel (
  tenant_id  TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  cedvel_id  TEXT NOT NULL,
  emp_id     TEXT NOT NULL,
  emp_name   TEXT,
  dept       TEXT,
  date_str   TEXT NOT NULL,
  shift_type TEXT DEFAULT '',
  PRIMARY KEY (tenant_id, cedvel_id)
);
CREATE INDEX idx_cedvel_emp_date  ON cedvel (tenant_id, emp_id, date_str);
CREATE INDEX idx_cedvel_dept_date ON cedvel (tenant_id, dept, date_str);

CREATE TABLE izin (
  tenant_id  TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  izin_id    TEXT NOT NULL,
  emp_id     TEXT,
  emp_name   TEXT,
  dept       TEXT,
  start_date TEXT,
  end_date   TEXT,
  type       TEXT DEFAULT 'İzin',
  note       TEXT DEFAULT '',
  status     TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (tenant_id, izin_id)
);
CREATE INDEX idx_izin_emp_status ON izin (tenant_id, emp_id, status);

CREATE TABLE late_perms (
  tenant_id      TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  perm_id        TEXT NOT NULL,
  emp_id         TEXT,
  emp_name       TEXT,
  dept           TEXT,
  date_str       TEXT,
  requested_time TEXT,
  status         TEXT DEFAULT 'pending',
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  approved_at    TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, perm_id)
);
CREATE INDEX idx_lateperms_emp_date ON late_perms (tenant_id, emp_id, date_str);
CREATE INDEX idx_lateperms_status   ON late_perms (tenant_id, status);

CREATE TABLE mgr_schedule (
  tenant_id  TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  sched_id   TEXT NOT NULL,
  dept       TEXT,
  date_str   TEXT,
  shift_type TEXT DEFAULT '',
  PRIMARY KEY (tenant_id, sched_id)
);
CREATE INDEX idx_mgrsched_dept_date ON mgr_schedule (tenant_id, dept, date_str);

-- ═════════════════════════════════════════════════════════════════════════
--  5. ÇEKLİST VƏ MƏHSUL
-- ═════════════════════════════════════════════════════════════════════════

CREATE TABLE checklist_items (
  tenant_id  TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  item_id    TEXT NOT NULL,
  text       TEXT,
  category   TEXT,
  sort_order INTEGER DEFAULT 0,
  active     BOOLEAN DEFAULT TRUE,
  PRIMARY KEY (tenant_id, item_id)
);

CREATE TABLE checklist_logs (
  tenant_id  TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  log_id     TEXT NOT NULL,
  date       TEXT,
  dept       TEXT,
  item_id    TEXT,
  item_text  TEXT,
  checked    BOOLEAN DEFAULT FALSE,
  checked_at TEXT DEFAULT '',
  mgr_note   TEXT DEFAULT '',
  admin_note TEXT DEFAULT '',
  PRIMARY KEY (tenant_id, log_id)
);
CREATE INDEX idx_checklog_date_dept ON checklist_logs (tenant_id, date, dept);

CREATE TABLE mgr_acks (
  tenant_id       TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  ack_id          TEXT NOT NULL,
  date            TEXT,
  dept            TEXT,
  global_acked    BOOLEAN DEFAULT FALSE,
  global_acked_at TEXT DEFAULT '',
  branch_acked    BOOLEAN DEFAULT FALSE,
  branch_acked_at TEXT DEFAULT '',
  PRIMARY KEY (tenant_id, ack_id)
);

CREATE TABLE products (
  tenant_id  TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  name       TEXT,
  unit       TEXT DEFAULT 'ədəd',
  active     BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (tenant_id, product_id)
);

CREATE TABLE product_logs (
  tenant_id    TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  log_id       TEXT NOT NULL,
  date_str     TEXT,
  dept         TEXT,
  product_id   TEXT,
  product_name TEXT,
  incoming     NUMERIC DEFAULT 0,
  wasted       NUMERIC DEFAULT 0,
  saved_at     TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (tenant_id, log_id)
);
CREATE INDEX idx_productlogs_dept_date ON product_logs (tenant_id, dept, date_str);

-- ═════════════════════════════════════════════════════════════════════════
--  6. PUL: AVANS, CƏRİMƏ, MAAŞ
-- ═════════════════════════════════════════════════════════════════════════

CREATE TABLE avans (
  tenant_id   TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  avans_id    TEXT NOT NULL,
  emp_id      TEXT NOT NULL,
  emp_name    TEXT NOT NULL,
  dept        TEXT DEFAULT '',
  amount      NUMERIC(8,2) NOT NULL,
  note        TEXT DEFAULT '',
  status      TEXT DEFAULT 'pending',          -- pending | approved | rejected | paid
  date_str    TEXT NOT NULL,                   -- tələb günü
  decided_ymd TEXT,                            -- təsdiq/ödəniş günü — hesabat BUNA baxır
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (tenant_id, avans_id)
);
CREATE INDEX idx_avans_emp_date ON avans (tenant_id, emp_id, date_str);
CREATE INDEX idx_avans_decided  ON avans (tenant_id, decided_ymd);

-- Sistem (avtomatik gecikmə) cərimələri
CREATE TABLE fines (
  tenant_id  TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  fine_id    TEXT NOT NULL,
  emp_id     TEXT NOT NULL,
  emp_name   TEXT,
  dept       TEXT,
  date_str   TEXT,
  amount     NUMERIC(8,2) DEFAULT 30,
  late_num   INTEGER,
  late_mins  INTEGER,
  reason     TEXT DEFAULT '',
  status     TEXT DEFAULT 'unpaid',            -- unpaid | paid | waived
  acked      BOOLEAN DEFAULT FALSE,
  acked_at   TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (tenant_id, fine_id)
);
CREATE INDEX idx_fines_emp_date ON fines (tenant_id, emp_id, date_str);
CREATE INDEX idx_fines_status   ON fines (tenant_id, status);

-- Menecer cərimələri (əl ilə yazılır, işçi e-imza ilə təsdiqləyir)
CREATE TABLE mgr_fines (
  tenant_id  TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  fine_id    TEXT NOT NULL,
  emp_id     TEXT NOT NULL,
  emp_name   TEXT,
  dept       TEXT DEFAULT '',
  amount     NUMERIC(8,2) NOT NULL,
  reason     TEXT DEFAULT '',
  status     TEXT DEFAULT 'pending',           -- pending | acknowledged
  created_by TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  acked_at   TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, fine_id)
);
CREATE INDEX idx_mgrfines_emp  ON mgr_fines (tenant_id, emp_id, status);
CREATE INDEX idx_mgrfines_dept ON mgr_fines (tenant_id, dept, created_at);

-- Bağlanmış maaş ayları (snapshot — ödənilmiş ay geriyə dəyişmir)
CREATE TABLE salary_periods (
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  period    TEXT NOT NULL,                     -- 'YYYY-MM'
  closed_at TIMESTAMPTZ DEFAULT NOW(),
  closed_by TEXT DEFAULT 'admin',
  config    JSONB,
  rows      JSONB,
  totals    JSONB,
  PRIMARY KEY (tenant_id, period)
);

-- ═════════════════════════════════════════════════════════════════════════
--  7. SOSİAL / PROFİL / BİLDİRİŞ
-- ═════════════════════════════════════════════════════════════════════════

CREATE TABLE announcements (
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  id        TEXT NOT NULL,
  title     TEXT,
  body      TEXT,
  type      TEXT DEFAULT 'info',
  pinned    BOOLEAN DEFAULT FALSE,
  date      TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE profiles (
  tenant_id    TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  emp_id       TEXT NOT NULL,
  avatar_type  TEXT NOT NULL DEFAULT 'preset',
  avatar_value TEXT NOT NULL DEFAULT 'mug-hot',
  accent_color TEXT NOT NULL DEFAULT '#5b5ef4',
  bio          TEXT DEFAULT '',
  photo_data   TEXT DEFAULT '',
  -- Oyunlaşdırma bəzəkləri: işçi öz kartını özəlləşdirir
  -- (mycode.html-dəki tema/çərçivə/banner/aura seçimləri).
  card_theme   TEXT DEFAULT 'glass',    -- glass | dark | coffee | void | gradient | aurora …
  frame_style  TEXT DEFAULT 'none',     -- none | simple | rainbow_anim | glitch | lightning …
  banner_style TEXT DEFAULT 'none',     -- none | gradient | candy | geometric | waves …
  glow_effect  TEXT DEFAULT 'none',
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (tenant_id, emp_id)
);

CREATE TABLE reactions (
  tenant_id   TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  from_emp_id TEXT NOT NULL,
  to_emp_id   TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('like','fire','sad','angry')),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (tenant_id, from_emp_id, to_emp_id)
);

CREATE TABLE push_subscriptions (
  tenant_id  TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  id         BIGSERIAL,
  emp_id     TEXT NOT NULL,                    -- işçi id / 'MGR-<Filial>' / 'EXEC' / 'TRAINER'
  endpoint   TEXT NOT NULL,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, id)
);
-- Bir brauzer endpoint-i yalnız bir yerə bağlana bilər (brauzerin özü qlobal unikaldır).
CREATE UNIQUE INDEX idx_push_endpoint_global ON push_subscriptions (endpoint);
-- Abunəlik `upsert(..., { onConflict: 'endpoint' })` ilə yazılır; tdb.js münaqişə
-- hədəfini `(tenant_id, endpoint)`-a çevirir. Postgres ON CONFLICT üçün MƏHZ bu
-- sütunlar üzrə unikal indeks tələb edir — yuxarıdakı qlobal indeks kifayət etmir.
-- Bu sətir olmasa hər abunəlik 42P10 ilə sınır (bax push-endpoint-migration.sql).
CREATE UNIQUE INDEX idx_push_tenant_endpoint ON push_subscriptions (tenant_id, endpoint);
CREATE INDEX idx_push_subs_emp ON push_subscriptions (tenant_id, emp_id);

-- ═════════════════════════════════════════════════════════════════════════
--  8. TƏLİM / İMTAHAN / XP
-- ═════════════════════════════════════════════════════════════════════════

CREATE TABLE xp_audit_log (
  tenant_id    TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  id           BIGSERIAL,
  trainer_name TEXT,
  emp_id       TEXT,
  emp_name     TEXT,
  dept         TEXT,
  amount       INTEGER,
  type         TEXT,                           -- rating | manual
  stars        INTEGER,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX idx_xp_audit_emp ON xp_audit_log (tenant_id, emp_id);

CREATE TABLE trainer_exams (
  tenant_id    TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  exam_id      TEXT NOT NULL,
  trainer_name TEXT NOT NULL DEFAULT '',
  dept         TEXT NOT NULL DEFAULT '',
  emp_id       TEXT NOT NULL DEFAULT '',
  emp_name     TEXT NOT NULL DEFAULT '',
  score        NUMERIC NOT NULL DEFAULT 0,
  max_score    NUMERIC NOT NULL DEFAULT 100,
  answers      JSONB NOT NULL DEFAULT '[]',
  note         TEXT NOT NULL DEFAULT '',
  date_str     TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, exam_id)
);
CREATE INDEX idx_trainer_exams_date ON trainer_exams (tenant_id, date_str);
CREATE INDEX idx_trainer_exams_emp  ON trainer_exams (tenant_id, emp_id);

CREATE TABLE trainer_logs (
  tenant_id    TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  log_id       TEXT NOT NULL,
  trainer_name TEXT DEFAULT '',
  dept         TEXT DEFAULT '',
  emp_id       TEXT DEFAULT '',
  emp_name     TEXT DEFAULT '',
  date_str     TEXT DEFAULT '',
  items        JSONB NOT NULL DEFAULT '[]',
  general_note TEXT DEFAULT '',
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (tenant_id, log_id)
);
CREATE INDEX idx_trainer_logs_date ON trainer_logs (tenant_id, date_str);

CREATE TABLE trainer_checklist_items (
  tenant_id  TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  item_id    TEXT NOT NULL,
  text       TEXT DEFAULT '',
  category   TEXT DEFAULT '',
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, item_id)
);

CREATE TABLE trainer_materials (
  tenant_id   TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  material_id TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',
  category    TEXT NOT NULL DEFAULT '',
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, material_id)
);
CREATE INDEX idx_trainer_materials_active ON trainer_materials (tenant_id, active);

CREATE TABLE exam_questions (
  tenant_id   TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  question_id TEXT NOT NULL,
  text        TEXT NOT NULL DEFAULT '',
  type        TEXT NOT NULL DEFAULT 'open',    -- test | open
  options     JSONB NOT NULL DEFAULT '[]',
  correct     TEXT NOT NULL DEFAULT '',
  category    TEXT NOT NULL DEFAULT '',
  role        TEXT NOT NULL DEFAULT 'umumi',
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, question_id)
);
CREATE INDEX idx_exam_questions_active ON exam_questions (tenant_id, active);

-- ═════════════════════════════════════════════════════════════════════════
--  9. ƏMƏLİYYAT (OPS) PANELİ
-- ═════════════════════════════════════════════════════════════════════════

CREATE TABLE ops_visits (
  tenant_id     TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  visit_id      TEXT NOT NULL,
  dept          TEXT NOT NULL,
  ops_name      TEXT DEFAULT '',
  visit_date    TEXT NOT NULL,
  overall_score NUMERIC(3,1) DEFAULT 0,
  summary       TEXT DEFAULT '',
  status        TEXT DEFAULT 'done',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (tenant_id, visit_id)
);
CREATE INDEX idx_ops_visits_dept_date ON ops_visits (tenant_id, dept, visit_date);

CREATE TABLE ops_ratings (
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  rating_id TEXT NOT NULL,
  visit_id  TEXT NOT NULL,
  category  TEXT NOT NULL,
  score     INTEGER DEFAULT 0,
  note      TEXT DEFAULT '',
  photo_url TEXT DEFAULT '',
  PRIMARY KEY (tenant_id, rating_id)
);
CREATE INDEX idx_ops_ratings_visit ON ops_ratings (tenant_id, visit_id);

CREATE TABLE ops_emp_notes (
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  note_id   TEXT NOT NULL,
  visit_id  TEXT NOT NULL,
  dept      TEXT DEFAULT '',
  emp_id    TEXT NOT NULL,
  emp_name  TEXT DEFAULT '',
  sentiment TEXT DEFAULT 'neutral',
  note      TEXT DEFAULT '',
  photo_url TEXT DEFAULT '',
  PRIMARY KEY (tenant_id, note_id)
);
CREATE INDEX idx_ops_emp_notes_visit ON ops_emp_notes (tenant_id, visit_id);

CREATE TABLE ops_issues (
  tenant_id       TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  issue_id        TEXT NOT NULL,
  dept            TEXT NOT NULL,
  emp_id          TEXT DEFAULT '',
  emp_name        TEXT DEFAULT '',
  title           TEXT NOT NULL,
  detail          TEXT DEFAULT '',
  severity        TEXT DEFAULT 'orta',
  status          TEXT DEFAULT 'open',
  assigned_to     TEXT DEFAULT '',
  due_date        TEXT DEFAULT '',
  source_visit_id TEXT DEFAULT '',
  photo_url       TEXT DEFAULT '',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, issue_id)
);
CREATE INDEX idx_ops_issues_dept_status ON ops_issues (tenant_id, dept, status);

-- ═════════════════════════════════════════════════════════════════════════
--  10. RLS
--  Server Service Role Key ilə qoşulur və onu keçir. Policy yazmırıq —
--  yəni anon/public açar ilə HEÇ NƏ oxunmur (fail-closed). İzolyasiyanı
--  tətbiq qatındakı `tdb.js` təmin edir.
-- ═════════════════════════════════════════════════════════════════════════
DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- ═════════════════════════════════════════════════════════════════════════
--  11. YOXLAMA
-- ═════════════════════════════════════════════════════════════════════════
-- Tenant sütunu olmayan cədvəl qalıbmı? (yalnız tenants + auth_keys çıxmalıdır)
--
--   SELECT t.tablename
--   FROM pg_tables t
--   WHERE t.schemaname='public'
--     AND NOT EXISTS (
--       SELECT 1 FROM information_schema.columns c
--       WHERE c.table_name=t.tablename AND c.column_name='tenant_id')
--   ORDER BY 1;
