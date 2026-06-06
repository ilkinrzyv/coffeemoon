-- XP sistemi üçün migration
-- Supabase SQL Editorunda çalışdırın

ALTER TABLE employees ADD COLUMN IF NOT EXISTS xp INTEGER DEFAULT 0;
