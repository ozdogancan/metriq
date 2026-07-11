-- Integrity and transaction boundaries for offer-critical row replacement.

-- Historical learning events may intentionally outlive a deleted run.
update public.learning_events l
set run_id = null
where run_id is not null
  and not exists (select 1 from public.runs r where r.id = l.run_id);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'runs_calibration_fk') then
    alter table public.runs
      add constraint runs_calibration_fk foreign key (calibration_id)
      references public.calibrations(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'learning_events_run_fk') then
    alter table public.learning_events
      add constraint learning_events_run_fk foreign key (run_id)
      references public.runs(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'runs_file_size_nonnegative') then
    alter table public.runs add constraint runs_file_size_nonnegative check (file_size >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'mto_rows_values_valid') then
    alter table public.mto_rows add constraint mto_rows_values_valid check (
      idx >= 0 and (s1 is null or s1 > 0) and s2 >= 0 and qty >= 0
      and unit in ('M', 'EA') and scope in ('MAIN', 'INFO')
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'steel_rows_values_valid') then
    alter table public.steel_rows add constraint steel_rows_values_valid check (
      length_mm >= 0 and count >= 0 and total_kg >= 0
    );
  end if;
end $$;

create unique index if not exists mto_rows_run_idx_unique
  on public.mto_rows(run_id, idx);
create index if not exists runs_created_desc
  on public.runs(created_at desc);
create index if not exists calibrations_updated_desc
  on public.calibrations(updated_at desc);
create index if not exists steel_rows_run_length
  on public.steel_rows(run_id, length_mm desc, id);

create or replace function public.replace_mto_rows(p_run_id uuid, p_rows jsonb)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 10000 then
    raise exception 'invalid mto row payload';
  end if;
  if not exists (select 1 from public.runs where id = p_run_id for update) then
    raise exception 'run not found';
  end if;

  delete from public.mto_rows where run_id = p_run_id;
  insert into public.mto_rows (id, run_id, idx, line, code, sub, s1, s2, qty, unit, remark, scope, edited)
  select x.id, p_run_id, x.idx, x.line, x.code, x.sub, x.s1, x.s2, x.qty,
         x.unit, x.remark, x.scope, coalesce(x.edited, false)
  from jsonb_to_recordset(p_rows) as x(
    id text, idx int, line text, code text, sub text, s1 numeric, s2 numeric,
    qty numeric, unit text, remark text, scope text, edited boolean
  );
end;
$$;

create or replace function public.replace_steel_rows(p_run_id uuid, p_rows jsonb)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 10000 then
    raise exception 'invalid steel row payload';
  end if;
  if not exists (select 1 from public.runs where id = p_run_id for update) then
    raise exception 'run not found';
  end if;

  delete from public.steel_rows where run_id = p_run_id;
  insert into public.steel_rows (id, run_id, profile, length_mm, count, total_kg)
  select x.id, p_run_id, x.profile, x.length_mm, x.count, x.total_kg
  from jsonb_to_recordset(p_rows) as x(
    id text, profile text, length_mm numeric, count int, total_kg numeric
  );
end;
$$;

revoke all privileges on function public.replace_mto_rows(uuid, jsonb)
  from public, anon, authenticated, service_role;
revoke all privileges on function public.replace_steel_rows(uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.replace_mto_rows(uuid, jsonb) to service_role;
grant execute on function public.replace_steel_rows(uuid, jsonb) to service_role;
