-- XP sistemi üçün migration
-- Supabase SQL Editorunda çalışdırın

ALTER TABLE employees ADD COLUMN IF NOT EXISTS xp INTEGER DEFAULT 0;

-- Milestone bonusları üçün
ALTER TABLE employees ADD COLUMN IF NOT EXISTS milestones_claimed JSONB DEFAULT '[]';
