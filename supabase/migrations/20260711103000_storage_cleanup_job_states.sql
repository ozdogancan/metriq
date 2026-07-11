-- Distinguish upload reservations from real deletion jobs and claim work with
-- compare-and-swap updates in the application before touching external Storage.

alter table public.storage_cleanup
  add column if not exists kind text not null default 'delete';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'storage_cleanup_kind_valid') then
    alter table public.storage_cleanup add constraint storage_cleanup_kind_valid
      check (kind in ('reservation', 'finalizing', 'delete', 'deleting'));
  end if;
end $$;

create index if not exists storage_cleanup_due
  on public.storage_cleanup(not_before, queued_at);

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

  insert into public.storage_cleanup(path, queued_at, not_before, kind)
  values (p_path, now(), now(), 'delete')
  on conflict (path) do update set
    queued_at = excluded.queued_at,
    not_before = excluded.not_before,
    kind = excluded.kind;
  delete from public.runs where id = p_run_id;
  return true;
end;
$$;

revoke all privileges on function public.delete_run_and_queue_storage(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.delete_run_and_queue_storage(uuid, text) to service_role;
