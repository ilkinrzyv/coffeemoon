-- ══════════════════════════════════════════════════════════════════
--  Supabase SQL Editor-də icra edin
-- ══════════════════════════════════════════════════════════════════

-- 1. İmtahan nəticələri
CREATE TABLE IF NOT EXISTS trainer_exams (
  exam_id      text         PRIMARY KEY,
  trainer_name text         NOT NULL DEFAULT '',
  dept         text         NOT NULL DEFAULT '',
  emp_id       text         NOT NULL DEFAULT '',
  emp_name     text         NOT NULL DEFAULT '',
  score        numeric      NOT NULL DEFAULT 0,
  max_score    numeric      NOT NULL DEFAULT 100,
  answers      jsonb        NOT NULL DEFAULT '[]',
  note         text         NOT NULL DEFAULT '',
  date_str     text         NOT NULL DEFAULT '',
  created_at   timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trainer_exams_date_idx ON trainer_exams (date_str);
CREATE INDEX IF NOT EXISTS trainer_exams_emp_idx  ON trainer_exams (emp_id);

-- 2. Trainer öz imtahan sualları
CREATE TABLE IF NOT EXISTS exam_questions (
  question_id  text         PRIMARY KEY,
  text         text         NOT NULL DEFAULT '',
  type         text         NOT NULL DEFAULT 'open',  -- 'test' | 'open'
  options      jsonb        NOT NULL DEFAULT '[]',    -- [{label:'A', text:'...'}, ...]
  correct      text         NOT NULL DEFAULT '',      -- 'A' | 'B' | 'C' | 'D'
  category     text         NOT NULL DEFAULT '',
  active       boolean      NOT NULL DEFAULT true,
  sort_order   integer      NOT NULL DEFAULT 0,
  created_at   timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS exam_questions_active_idx ON exam_questions (active);

-- 3. Trainer öz təlim materialları
CREATE TABLE IF NOT EXISTS trainer_materials (
  material_id  text         PRIMARY KEY,
  title        text         NOT NULL DEFAULT '',
  body         text         NOT NULL DEFAULT '',
  category     text         NOT NULL DEFAULT '',
  active       boolean      NOT NULL DEFAULT true,
  sort_order   integer      NOT NULL DEFAULT 0,
  created_at   timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trainer_materials_active_idx ON trainer_materials (active);

-- RLS — Service Role Key avtomatik bypass edir, əlavə policy lazım deyil.
ALTER TABLE trainer_exams      ENABLE ROW LEVEL SECURITY;
ALTER TABLE exam_questions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE trainer_materials  ENABLE ROW LEVEL SECURITY;
