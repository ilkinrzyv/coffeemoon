-- XP sistemi üçün migration
-- Supabase SQL Editorunda çalışdırın

ALTER TABLE employees ADD COLUMN IF NOT EXISTS xp INTEGER DEFAULT 0;

-- Milestone bonusları üçün
ALTER TABLE employees ADD COLUMN IF NOT EXISTS milestones_claimed JSONB DEFAULT '[]';

-- XP audit loqu
CREATE TABLE IF NOT EXISTS xp_audit_log (
  id          BIGSERIAL PRIMARY KEY,
  trainer_name TEXT,
  emp_id      TEXT,
  emp_name    TEXT,
  dept        TEXT,
  amount      INTEGER,
  type        TEXT,   -- 'rating' | 'manual'
  stars       INTEGER,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
