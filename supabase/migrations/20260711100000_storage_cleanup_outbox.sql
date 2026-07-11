-- Keep database deletion atomic while making private Storage cleanup retryable.

create table if not exists public.storage_cleanup (
  path text primary key,
  queued_at timestamptz not null default now(),
  not_before timestamptz not null default now()
);

alter table public.storage_cleanup enable row level security;
alter table public.storage_cleanup force row level security;
revoke all privileges on table public.storage_cleanup from anon, authenticated, service_role;
grant select, insert, update, delete on table public.storage_cleanup to service_role;

create or replace function public.delete_run_and_queue_storage(p_run_id uuid, p_path text)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_path is null or length(p_path) > 220
    or position('/' in p_path) < 2
    or position('/' in substring(p_path from position('/' in p_path) + 1)) > 0 then
    raise exception 'invalid storage path';
  end if;

  perform 1 from public.runs where id = p_run_id for update;
  if not found then return false; end if;

  insert into public.storage_cleanup(path, queued_at, not_before)
  values (p_path, now(), now())
  on conflict (path) do update
    set queued_at = excluded.queued_at, not_before = excluded.not_before;
  delete from public.runs where id = p_run_id;
  return true;
end;
$$;

revoke all privileges on function public.delete_run_and_queue_storage(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.delete_run_and_queue_storage(uuid, text) to service_role;
