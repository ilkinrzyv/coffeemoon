-- ══════════════════════════════════════════════════════
--  Əməliyyat Meneceri (OPS) paneli — cədvəllər
--  Supabase SQL Editor-də işlət. Mövcud cədvəllərə toxunmur.
-- ══════════════════════════════════════════════════════

DROP TABLE IF EXISTS ops_ratings CASCADE;
DROP TABLE IF EXISTS ops_emp_notes CASCADE;
DROP TABLE IF EXISTS ops_issues CASCADE;
DROP TABLE IF EXISTS ops_visits CASCADE;

-- Ziyarət (bir filial inspeksiyası)
CREATE TABLE ops_visits (
  visit_id      TEXT PRIMARY KEY,
  dept          TEXT NOT NULL,
  ops_name      TEXT DEFAULT '',
  visit_date    TEXT NOT NULL,            -- məntiqi YMD (YYYY-MM-DD)
  overall_score NUMERIC(3,1) DEFAULT 0,
  summary       TEXT DEFAULT '',
  status        TEXT DEFAULT 'done',      -- open | done
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Kateqoriya qiymətləri (ziyarət daxili)
CREATE TABLE ops_ratings (
  rating_id  TEXT PRIMARY KEY,
  visit_id   TEXT NOT NULL,
  category   TEXT NOT NULL,
  score      INTEGER DEFAULT 0,           -- 1..5
  note       TEXT DEFAULT '',
  photo_url  TEXT DEFAULT ''
);

-- İşçi qeydləri (problem OLMAYAN müşahidələr: tərif/neytral)
CREATE TABLE ops_emp_notes (
  note_id    TEXT PRIMARY KEY,
  visit_id   TEXT NOT NULL,
  dept       TEXT DEFAULT '',
  emp_id     TEXT NOT NULL,
  emp_name   TEXT DEFAULT '',
  sentiment  TEXT DEFAULT 'neutral',      -- pos | neg | neutral
  note       TEXT DEFAULT '',
  photo_url  TEXT DEFAULT ''
);

-- Problemlər / tapşırıqlar (filial və ya işçiyə bağlı; iclaslar arası daşınır)
CREATE TABLE ops_issues (
  issue_id        TEXT PRIMARY KEY,
  dept            TEXT NOT NULL,
  emp_id          TEXT DEFAULT '',         -- istəyə görə: işçiyə bağlı problem
  emp_name        TEXT DEFAULT '',
  title           TEXT NOT NULL,
  detail          TEXT DEFAULT '',
  severity        TEXT DEFAULT 'orta',     -- asagi | orta | kritik
  status          TEXT DEFAULT 'open',     -- open | progress | resolved
  assigned_to     TEXT DEFAULT '',
  due_date        TEXT DEFAULT '',
  source_visit_id TEXT DEFAULT '',
  photo_url       TEXT DEFAULT '',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ
);

CREATE INDEX idx_ops_visits_dept_date  ON ops_visits(dept, visit_date);
CREATE INDEX idx_ops_ratings_visit     ON ops_ratings(visit_id);
CREATE INDEX idx_ops_emp_notes_visit   ON ops_emp_notes(visit_id);
CREATE INDEX idx_ops_issues_dept_status ON ops_issues(dept, status);
