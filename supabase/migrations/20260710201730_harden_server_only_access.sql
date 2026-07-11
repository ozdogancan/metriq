-- Metriq's Data API is server-only. Browser roles must never reach offer data.
-- The application uses SUPABASE_SERVICE_ROLE_KEY exclusively from server-only code;
-- service_role has BYPASSRLS, so these locks do not change normal app behavior.

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

-- service_role bypasses RLS but still receives only the operations Metriq uses.
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

-- Prevent future migrations from silently recreating the same exposure.
alter default privileges for role postgres in schema public
  revoke all privileges on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke all privileges on sequences from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke all privileges on functions from public, anon, authenticated, service_role;

-- Supabase's managed supabase_admin defaults are platform-owned and cannot be
-- altered by the project postgres role. Metriq migrations run as postgres, so
-- the defaults above cover every application table/function we create.
