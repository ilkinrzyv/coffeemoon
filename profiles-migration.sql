-- Profiles cədvəli — işçi profili özəlləşdirmə
CREATE TABLE IF NOT EXISTS profiles (
  emp_id       TEXT PRIMARY KEY,
  avatar_type  TEXT NOT NULL DEFAULT 'preset',
  avatar_value TEXT NOT NULL DEFAULT 'mug-hot',
  accent_color TEXT NOT NULL DEFAULT '#5b5ef4',
  bio          TEXT DEFAULT '',
  photo_data   TEXT DEFAULT '',
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- RLS (Row Level Security) — istənilsə aktiv et
-- ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
