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

-- ===== v2: canlı işleme + AI denetçi + bildirimler + öğrenme günlüğü =====
alter table runs add column if not exists progress jsonb not null default '[]';
alter table runs add column if not exists ai jsonb;

create table if not exists notifications (
  id uuid primary key,
  kind text not null default 'system',
  title text not null,
  body text not null default '',
  url text not null default '/',
  read boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists notifications_created on notifications(created_at desc);

create table if not exists learning_events (
  id uuid primary key,
  run_id uuid,
  ts timestamptz not null default now(),
  kind text not null,
  before jsonb,
  after jsonb,
  context jsonb not null default '{}'
);
create index if not exists learning_events_run on learning_events(run_id);
create index if not exists learning_events_ts on learning_events(ts desc);

create table if not exists push_subscriptions (
  endpoint text primary key,
  subscription jsonb not null,
  created_at timestamptz not null default now()
);

-- ===== v3: müşteri cevap karşılaştırması (ground truth) =====
alter table runs add column if not exists answer jsonb;

-- ===== v4: server-only Data API hardening =====
-- Metriq accesses these tables only with service_role from server-only code.
-- Browser roles receive no policies and no direct table privileges.
alter table public.runs enable row level security;
alter table public.runs force row level security;
alter table public.mto_rows enable row level security;
alter table public.mto_rows force row level security;
alter table public.steel_rows enable row level security;
alter table public.steel_rows force row level security;
alter table public.calibrations enable row level security;
alter table public.calibrations force row level security;
alter table public.notifications enable row level security;
alter table public.notifications force row level security;
alter table public.learning_events enable row level security;
alter table public.learning_events force row level security;
alter table public.push_subscriptions enable row level security;
alter table public.push_subscriptions force row level security;

revoke all privileges on table
  public.runs,
  public.mto_rows,
  public.steel_rows,
  public.calibrations,
  public.notifications,
  public.learning_events,
  public.push_subscriptions
from anon, authenticated;

revoke all privileges on table
  public.runs,
  public.mto_rows,
  public.steel_rows,
  public.calibrations,
  public.notifications,
  public.learning_events,
  public.push_subscriptions
from service_role;
grant select, insert, update, delete on table public.runs to service_role;
grant select, insert, delete on table public.mto_rows, public.steel_rows to service_role;
grant select, insert, update, delete on table public.calibrations to service_role;
grant select, insert, update on table public.notifications to service_role;
grant select, insert on table public.learning_events to service_role;
grant select, insert, update, delete on table public.push_subscriptions to service_role;

alter default privileges for role postgres in schema public
  revoke all privileges on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke all privileges on sequences from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke all privileges on functions from public, anon, authenticated, service_role;
-- supabase_admin is platform-managed; application objects are created by postgres.
