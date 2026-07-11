-- Canonical Metriq baseline.
-- Keep this migration self-contained so a fresh `supabase db reset` can build
-- every relation required by the later hardening and integrity migrations.

create table if not exists public.runs (
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
  progress jsonb not null default '[]',
  ai jsonb,
  answer jsonb,
  created_at timestamptz not null default now()
);

-- Also converge databases that were created from the old v1 manual baseline.
alter table public.runs add column if not exists progress jsonb not null default '[]';
alter table public.runs add column if not exists ai jsonb;
alter table public.runs add column if not exists answer jsonb;

create table if not exists public.mto_rows (
  id text primary key,
  run_id uuid not null references public.runs(id) on delete cascade,
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
create index if not exists mto_rows_run on public.mto_rows(run_id, idx);

create table if not exists public.steel_rows (
  id text primary key,
  run_id uuid not null references public.runs(id) on delete cascade,
  profile text not null,
  length_mm numeric not null,
  count int not null default 1,
  total_kg numeric not null default 0
);
create index if not exists steel_rows_run on public.steel_rows(run_id);

create table if not exists public.calibrations (
  id uuid primary key,
  name text not null,
  rules jsonb not null,
  learned_from jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.notifications (
  id uuid primary key,
  kind text not null default 'system',
  title text not null,
  body text not null default '',
  url text not null default '/',
  read boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists notifications_created on public.notifications(created_at desc);

create table if not exists public.learning_events (
  id uuid primary key,
  run_id uuid,
  ts timestamptz not null default now(),
  kind text not null,
  before jsonb,
  after jsonb,
  context jsonb not null default '{}'
);
create index if not exists learning_events_run on public.learning_events(run_id);
create index if not exists learning_events_ts on public.learning_events(ts desc);

create table if not exists public.push_subscriptions (
  endpoint text primary key,
  subscription jsonb not null,
  created_at timestamptz not null default now()
);
