-- ══════════════════════════════════════════════════════════════════
--  trainer_exams cədvəli — İmtahan nəticələri
--  Supabase SQL Editor-də icra edin
-- ══════════════════════════════════════════════════════════════════

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

-- İndekslər (sürətli sorğu üçün)
CREATE INDEX IF NOT EXISTS trainer_exams_date_idx    ON trainer_exams (date_str);
CREATE INDEX IF NOT EXISTS trainer_exams_emp_idx     ON trainer_exams (emp_id);
CREATE INDEX IF NOT EXISTS trainer_exams_dept_idx    ON trainer_exams (dept);

-- RLS (Service Role Key keçir, amma qaydalar olsun)
ALTER TABLE trainer_exams ENABLE ROW LEVEL SECURITY;

-- Service role bütün əməliyyatlara icazəlidir (db.js SUPABASE_SERVICE_KEY istifadə edir)
-- Əlavə policy lazım deyil — service role avtomatik bypass edir.
