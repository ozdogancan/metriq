-- Metriq v1 şema — Supabase SQL Editor'de bir kez çalıştır
create table if not exists runs (
  id uuid primary key,
  project_name text not null,
  file_name text not null,
  file_size bigint not null default 0,
  vocab text not null default 'steel-plant',
  calibration_id uuid,
  status text not null default 'done',
  error text,
  totals jsonb not null default '{}',
  fasteners jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists mto_rows (
  id text primary key,
  run_id uuid not null references runs(id) on delete cascade,
  idx int not null default 0,
  line text not null default '?',
  code text not null,
  sub text not null default '',
  s1 numeric,
  s2 numeric not null default 0,
  qty numeric not null default 0,
  unit text not null default 'EA',
  remark text not null default '',
  scope text not null default 'MAIN',
  edited boolean not null default false
);
create index if not exists mto_rows_run on mto_rows(run_id, idx);

create table if not exists steel_rows (
  id text primary key,
  run_id uuid not null references runs(id) on delete cascade,
  profile text not null,
  length_mm numeric not null,
  count int not null default 1,
  total_kg numeric not null default 0
);
create index if not exists steel_rows_run on steel_rows(run_id);

create table if not exists calibrations (
  id uuid primary key,
  name text not null,
  rules jsonb not null,
  learned_from jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Depolama: 'models' adlı PRIVATE bucket oluştur (Dashboard > Storage > New bucket).
-- Servis rolü kullanıldığı için ek policy gerekmiyor (RLS bypass).
