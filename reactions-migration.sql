-- Reaksiya cədvəli
-- Hər işçi digər işçiyə yalnız 1 reaksiya verə bilər (like/love/fire/angry).
-- Eyni reaksiyanı yenidən basmaq onu silir (toggle).

create table if not exists reactions (
  from_emp_id text not null,
  to_emp_id   text not null,
  type        text not null check (type in ('like','fire','sad','angry')),
  created_at  timestamptz default now(),
  primary key (from_emp_id, to_emp_id)
);
