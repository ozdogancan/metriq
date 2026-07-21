-- Stable tenant ownership for the custom AUTH_USERS session model.
-- Existing production data is deliberately assigned to one explicit legacy
-- tenant. New application writes have no database default and therefore fail
-- closed when a tenant scope is omitted.

alter table public.runs add column if not exists tenant_key text;
alter table public.runs add column if not exists created_by_key text;
alter table public.runs add column if not exists analysis jsonb;
alter table public.runs add column if not exists calibration_snapshot jsonb;
alter table public.mto_rows add column if not exists tenant_key text;
alter table public.steel_rows add column if not exists tenant_key text;
alter table public.calibrations add column if not exists tenant_key text;
alter table public.calibrations add column if not exists model_family text;
alter table public.calibrations add column if not exists client_key text;
alter table public.calibrations add column if not exists status text;
alter table public.notifications add column if not exists tenant_key text;
alter table public.notifications add column if not exists user_key text;
alter table public.learning_events add column if not exists tenant_key text;
alter table public.learning_events add column if not exists actor_user_key text;
alter table public.push_subscriptions add column if not exists tenant_key text;
alter table public.push_subscriptions add column if not exists user_key text;
alter table public.storage_cleanup add column if not exists tenant_key text;
alter table public.storage_cleanup add column if not exists user_key text;
alter table public.answer_comparisons add column if not exists tenant_key text;
alter table public.answer_comparisons add column if not exists created_by_key text;
alter table public.calibration_versions add column if not exists tenant_key text;
alter table public.calibration_versions add column if not exists created_by_key text;
alter table public.calibration_commits add column if not exists tenant_key text;
alter table public.calibration_commits add column if not exists created_by_key text;

update public.runs set tenant_key = 'legacy-default' where tenant_key is null;
update public.runs set created_by_key = 'legacy-system' where created_by_key is null;
update public.runs set analysis = aps -> 'analysis'
where analysis is null and jsonb_typeof(aps -> 'analysis') = 'object';
update public.mto_rows set tenant_key = 'legacy-default' where tenant_key is null;
update public.steel_rows set tenant_key = 'legacy-default' where tenant_key is null;
update public.calibrations set
  tenant_key = coalesce(tenant_key, 'legacy-default'),
  model_family = coalesce(model_family, 'legacy'),
  client_key = coalesce(client_key, 'default'),
  status = coalesce(status, case when archived_at is null then 'active' else 'archived' end);
update public.notifications set
  tenant_key = coalesce(tenant_key, 'legacy-default'),
  user_key = coalesce(user_key, 'legacy-system');
update public.learning_events set
  tenant_key = coalesce(tenant_key, 'legacy-default'),
  actor_user_key = coalesce(actor_user_key, 'legacy-system');
update public.push_subscriptions set
  tenant_key = coalesce(tenant_key, 'legacy-default'),
  user_key = coalesce(user_key, 'legacy-system');
update public.storage_cleanup set
  tenant_key = coalesce(tenant_key, 'legacy-default'),
  user_key = coalesce(user_key, 'legacy-system');
update public.answer_comparisons set
  tenant_key = coalesce(tenant_key, 'legacy-default'),
  created_by_key = coalesce(created_by_key, 'legacy-system');
update public.calibration_versions set
  tenant_key = coalesce(tenant_key, 'legacy-default'),
  created_by_key = coalesce(created_by_key, 'legacy-system');
update public.calibration_commits set
  tenant_key = coalesce(tenant_key, 'legacy-default'),
  created_by_key = coalesce(created_by_key, 'legacy-system');

-- Zero-downtime rollout bridge: the currently promoted application still uses
-- the v1 RPCs for the few minutes between this expand migration and the new
-- deployment. Defaults keep those writes in the single legacy tenant. The
-- following contract migration removes every default and revokes v1 execute.
alter table public.runs alter column tenant_key set default 'legacy-default';
alter table public.runs alter column created_by_key set default 'legacy-system';
alter table public.mto_rows alter column tenant_key set default 'legacy-default';
alter table public.steel_rows alter column tenant_key set default 'legacy-default';
alter table public.calibrations alter column tenant_key set default 'legacy-default';
alter table public.calibrations alter column model_family set default 'legacy';
alter table public.calibrations alter column client_key set default 'default';
alter table public.calibrations alter column status set default 'active';
alter table public.notifications alter column tenant_key set default 'legacy-default';
alter table public.notifications alter column user_key set default 'legacy-system';
alter table public.learning_events alter column tenant_key set default 'legacy-default';
alter table public.learning_events alter column actor_user_key set default 'legacy-system';
alter table public.push_subscriptions alter column tenant_key set default 'legacy-default';
alter table public.push_subscriptions alter column user_key set default 'legacy-system';
alter table public.storage_cleanup alter column tenant_key set default 'legacy-default';
alter table public.storage_cleanup alter column user_key set default 'legacy-system';
alter table public.answer_comparisons alter column tenant_key set default 'legacy-default';
alter table public.answer_comparisons alter column created_by_key set default 'legacy-system';
alter table public.calibration_versions alter column tenant_key set default 'legacy-default';
alter table public.calibration_versions alter column created_by_key set default 'legacy-system';
alter table public.calibration_commits alter column tenant_key set default 'legacy-default';
alter table public.calibration_commits alter column created_by_key set default 'legacy-system';

alter table public.runs alter column tenant_key set not null;
alter table public.runs alter column created_by_key set not null;
alter table public.mto_rows alter column tenant_key set not null;
alter table public.steel_rows alter column tenant_key set not null;
alter table public.calibrations alter column tenant_key set not null;
alter table public.calibrations alter column model_family set not null;
alter table public.calibrations alter column client_key set not null;
alter table public.calibrations alter column status set not null;
alter table public.notifications alter column tenant_key set not null;
alter table public.notifications alter column user_key set not null;
alter table public.learning_events alter column tenant_key set not null;
alter table public.learning_events alter column actor_user_key set not null;
alter table public.push_subscriptions alter column tenant_key set not null;
alter table public.push_subscriptions alter column user_key set not null;
alter table public.storage_cleanup alter column tenant_key set not null;
alter table public.storage_cleanup alter column user_key set not null;
alter table public.answer_comparisons alter column tenant_key set not null;
alter table public.answer_comparisons alter column created_by_key set not null;
alter table public.calibration_versions alter column tenant_key set not null;
alter table public.calibration_versions alter column created_by_key set not null;
alter table public.calibration_commits alter column tenant_key set not null;
alter table public.calibration_commits alter column created_by_key set not null;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'runs', 'mto_rows', 'steel_rows', 'calibrations', 'notifications',
    'learning_events', 'push_subscriptions', 'storage_cleanup',
    'answer_comparisons', 'calibration_versions', 'calibration_commits'
  ] loop
    execute format(
      'alter table public.%I add constraint %I check (tenant_key = ''legacy-default'' or tenant_key ~ ''^[0-9a-f]{64}$'')',
      table_name, table_name || '_tenant_key_valid'
    );
  end loop;
end $$;

alter table public.runs add constraint runs_created_by_key_valid
  check (created_by_key = 'legacy-system' or created_by_key ~ '^[0-9a-f]{64}$');
alter table public.notifications add constraint notifications_user_key_valid
  check (user_key = 'legacy-system' or user_key ~ '^[0-9a-f]{64}$');
alter table public.learning_events add constraint learning_events_actor_user_key_valid
  check (actor_user_key = 'legacy-system' or actor_user_key ~ '^[0-9a-f]{64}$');
alter table public.push_subscriptions add constraint push_subscriptions_user_key_valid
  check (user_key = 'legacy-system' or user_key ~ '^[0-9a-f]{64}$');
alter table public.storage_cleanup add constraint storage_cleanup_user_key_valid
  check (user_key = 'legacy-system' or user_key ~ '^[0-9a-f]{64}$');
alter table public.answer_comparisons add constraint answer_comparisons_created_by_key_valid
  check (created_by_key = 'legacy-system' or created_by_key ~ '^[0-9a-f]{64}$');
alter table public.calibration_versions add constraint calibration_versions_created_by_key_valid
  check (created_by_key = 'legacy-system' or created_by_key ~ '^[0-9a-f]{64}$');
alter table public.calibration_commits add constraint calibration_commits_created_by_key_valid
  check (created_by_key = 'legacy-system' or created_by_key ~ '^[0-9a-f]{64}$');
alter table public.calibrations add constraint calibrations_scope_valid check (
  model_family in ('plant3d-local', 'aps', 'legacy')
  and client_key ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
  and status in ('draft', 'active', 'archived')
  and ((status = 'archived') = (archived_at is not null))
);

create unique index if not exists runs_tenant_id_unique on public.runs(tenant_key, id);
create unique index if not exists calibrations_tenant_id_unique on public.calibrations(tenant_key, id);
create unique index if not exists answer_comparisons_tenant_id_unique
  on public.answer_comparisons(tenant_key, id);
create unique index if not exists answer_comparisons_tenant_run_id_unique
  on public.answer_comparisons(tenant_key, run_id, id);
create unique index if not exists calibration_versions_tenant_version_unique
  on public.calibration_versions(tenant_key, calibration_id, version);
create unique index if not exists calibration_commits_tenant_id_unique
  on public.calibration_commits(tenant_key, id);

alter table public.mto_rows drop constraint if exists mto_rows_pkey;
alter table public.mto_rows add constraint mto_rows_pkey primary key (tenant_key, run_id, id);
alter table public.steel_rows drop constraint if exists steel_rows_pkey;
alter table public.steel_rows add constraint steel_rows_pkey primary key (tenant_key, run_id, id);

alter table public.mto_rows add constraint mto_rows_tenant_run_fk
  foreign key (tenant_key, run_id) references public.runs(tenant_key, id) on delete cascade;
alter table public.steel_rows add constraint steel_rows_tenant_run_fk
  foreign key (tenant_key, run_id) references public.runs(tenant_key, id) on delete cascade;
alter table public.runs add constraint runs_tenant_calibration_fk
  foreign key (tenant_key, calibration_id) references public.calibrations(tenant_key, id)
  on delete set null (calibration_id);
alter table public.learning_events add constraint learning_events_tenant_run_fk
  foreign key (tenant_key, run_id) references public.runs(tenant_key, id)
  on delete set null (run_id);
alter table public.answer_comparisons add constraint answer_comparisons_tenant_run_fk
  foreign key (tenant_key, run_id) references public.runs(tenant_key, id) on delete cascade;
alter table public.calibration_versions add constraint calibration_versions_tenant_calibration_fk
  foreign key (tenant_key, calibration_id) references public.calibrations(tenant_key, id) on delete restrict;
alter table public.calibration_versions add constraint calibration_versions_tenant_comparison_fk
  foreign key (tenant_key, source_comparison_id) references public.answer_comparisons(tenant_key, id)
  on delete set null (source_comparison_id);
alter table public.calibration_commits add constraint calibration_commits_tenant_comparison_fk
  foreign key (tenant_key, run_id, comparison_id)
  references public.answer_comparisons(tenant_key, run_id, id) on delete cascade;
alter table public.calibration_commits add constraint calibration_commits_tenant_version_fk
  foreign key (tenant_key, calibration_id, new_profile_version)
  references public.calibration_versions(tenant_key, calibration_id, version);
alter table public.learning_events add constraint learning_events_tenant_comparison_fk
  foreign key (tenant_key, comparison_id) references public.answer_comparisons(tenant_key, id)
  on delete set null (comparison_id);
alter table public.learning_events add constraint learning_events_tenant_commit_fk
  foreign key (tenant_key, calibration_commit_id) references public.calibration_commits(tenant_key, id)
  on delete set null (calibration_commit_id);

drop index if exists public.mto_rows_run_idx_unique;
create unique index mto_rows_tenant_run_idx_unique on public.mto_rows(tenant_key, run_id, idx);
create index if not exists runs_tenant_created_desc on public.runs(tenant_key, created_at desc);
create index if not exists mto_rows_tenant_run_idx on public.mto_rows(tenant_key, run_id, idx);
create index if not exists steel_rows_tenant_run_length on public.steel_rows(tenant_key, run_id, length_mm desc);
create index if not exists calibrations_tenant_scope_updated on public.calibrations(
  tenant_key, model_family, client_key, status, updated_at desc
);
create index if not exists notifications_tenant_created on public.notifications(tenant_key, created_at desc);
create index if not exists learning_events_tenant_ts on public.learning_events(tenant_key, ts desc);
create index if not exists storage_cleanup_tenant_due on public.storage_cleanup(tenant_key, not_before, queued_at);
create index if not exists answer_comparisons_tenant_run_created
  on public.answer_comparisons(tenant_key, run_id, created_at desc);
create index if not exists calibration_commits_tenant_run_created
  on public.calibration_commits(tenant_key, run_id, created_at desc);

-- Endpoint remains globally unique: the same browser push endpoint may not be
-- silently attached to a second tenant and receive both tenants' messages.
create unique index if not exists push_subscriptions_tenant_endpoint_unique
  on public.push_subscriptions(tenant_key, endpoint);

-- Preserve server-only access after adding the new ownership columns.
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
alter table public.storage_cleanup enable row level security;
alter table public.storage_cleanup force row level security;
alter table public.answer_comparisons enable row level security;
alter table public.answer_comparisons force row level security;
alter table public.calibration_versions enable row level security;
alter table public.calibration_versions force row level security;
alter table public.calibration_commits enable row level security;
alter table public.calibration_commits force row level security;

revoke all privileges on table
  public.runs, public.mto_rows, public.steel_rows, public.calibrations,
  public.notifications, public.learning_events, public.push_subscriptions,
  public.storage_cleanup, public.answer_comparisons, public.calibration_versions,
  public.calibration_commits
from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.runs to service_role;
grant select, insert, delete on table public.mto_rows, public.steel_rows to service_role;
grant select, insert, update, delete on table public.calibrations to service_role;
grant select, insert, update, delete on table public.notifications to service_role;
grant select, insert on table public.learning_events to service_role;
grant select, insert, update, delete on table public.push_subscriptions, public.storage_cleanup to service_role;
grant select, insert on table public.answer_comparisons, public.calibration_versions, public.calibration_commits to service_role;

create or replace function public.replace_mto_rows_v2(
  p_tenant_key text, p_run_id uuid, p_rows jsonb
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_tenant_key is null or p_rows is null or jsonb_typeof(p_rows) <> 'array'
     or jsonb_array_length(p_rows) > 10000 then
    raise exception 'invalid mto row payload';
  end if;
  perform 1 from public.runs
  where tenant_key = p_tenant_key and id = p_run_id for update;
  if not found then raise exception 'run not found'; end if;

  delete from public.mto_rows where tenant_key = p_tenant_key and run_id = p_run_id;
  insert into public.mto_rows (
    tenant_key, id, run_id, idx, line, code, sub, s1, s2, qty, unit, remark, scope, edited
  )
  select p_tenant_key, x.id, p_run_id, x.idx, x.line, x.code, x.sub, x.s1, x.s2,
         x.qty, x.unit, x.remark, x.scope, coalesce(x.edited, false)
  from jsonb_to_recordset(p_rows) as x(
    id text, idx int, line text, code text, sub text, s1 numeric, s2 numeric,
    qty numeric, unit text, remark text, scope text, edited boolean
  );
  update public.runs set row_revision = row_revision + 1, rows_hash = null, answer = null
  where tenant_key = p_tenant_key and id = p_run_id;
end;
$$;

create or replace function public.replace_steel_rows_v2(
  p_tenant_key text, p_run_id uuid, p_rows jsonb
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_tenant_key is null or p_rows is null or jsonb_typeof(p_rows) <> 'array'
     or jsonb_array_length(p_rows) > 10000 then
    raise exception 'invalid steel row payload';
  end if;
  perform 1 from public.runs
  where tenant_key = p_tenant_key and id = p_run_id for update;
  if not found then raise exception 'run not found'; end if;

  delete from public.steel_rows where tenant_key = p_tenant_key and run_id = p_run_id;
  insert into public.steel_rows (tenant_key, id, run_id, profile, length_mm, count, total_kg)
  select p_tenant_key, x.id, p_run_id, x.profile, x.length_mm, x.count, x.total_kg
  from jsonb_to_recordset(p_rows) as x(
    id text, profile text, length_mm numeric, count int, total_kg numeric
  );
end;
$$;

create or replace function public.delete_run_and_queue_storage_v2(
  p_tenant_key text, p_run_id uuid, p_path text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_key text;
begin
  if p_path is null or length(p_path) > 220
    or position('/' in p_path) < 2
    or position('/' in substring(p_path from position('/' in p_path) + 1)) > 0
    or split_part(p_path, '/', 1) <> p_run_id::text then
    raise exception 'invalid storage path';
  end if;
  select created_by_key into v_user_key from public.runs
  where tenant_key = p_tenant_key and id = p_run_id for update;
  if not found then return false; end if;
  if exists (
    select 1 from public.storage_cleanup
    where path = p_path and tenant_key <> p_tenant_key
  ) then
    raise sqlstate 'PT409' using message = 'STORAGE_PATH_REUSED';
  end if;

  insert into public.storage_cleanup(tenant_key, user_key, path, queued_at, not_before, kind)
  values (p_tenant_key, v_user_key, p_path, now(), now(), 'delete')
  on conflict (path) do update set
    user_key = excluded.user_key,
    queued_at = excluded.queued_at, not_before = excluded.not_before, kind = excluded.kind;
  delete from public.runs where tenant_key = p_tenant_key and id = p_run_id;
  return true;
end;
$$;

create or replace function public.record_answer_comparison_v2(
  p_tenant_key text,
  p_user_key text,
  p_run_id uuid,
  p_comparison_id uuid,
  p_expected_row_revision bigint,
  p_expected_comparison_revision bigint,
  p_base_rows_hash text,
  p_answer_sha256 text,
  p_source_file_name text,
  p_source_sheet text,
  p_diff jsonb,
  p_actor_label text,
  p_learning_event_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_run public.runs%rowtype;
  v_problem_count int;
  v_unique_ids int;
begin
  select * into v_run from public.runs
  where tenant_key = p_tenant_key and id = p_run_id for update;
  if not found then raise exception 'run not found'; end if;

  if exists (
    select 1 from public.answer_comparisons
    where tenant_key = p_tenant_key and id = p_comparison_id
  ) then
    if exists (
      select 1 from public.answer_comparisons
      where tenant_key = p_tenant_key and id = p_comparison_id and run_id = p_run_id
        and base_rows_hash = p_base_rows_hash and diff = p_diff
    ) then
      return jsonb_build_object(
        'comparisonId', p_comparison_id,
        'comparisonRevision', v_run.comparison_revision,
        'answer', v_run.answer
      );
    end if;
    raise sqlstate 'PT409' using message = 'COMPARISON_ID_REUSED';
  end if;
  if exists (
    select 1 from public.answer_comparisons
    where id = p_comparison_id and tenant_key <> p_tenant_key
  ) then
    raise sqlstate 'PT409' using message = 'COMPARISON_ID_REUSED';
  end if;

  if v_run.status <> 'done' then raise sqlstate 'PT409' using message = 'RUN_NOT_DONE'; end if;
  if p_expected_row_revision is null or p_expected_comparison_revision is null
     or v_run.row_revision <> p_expected_row_revision
     or v_run.comparison_revision <> p_expected_comparison_revision then
    raise sqlstate 'PT409' using message = 'RUN_REVISION_CONFLICT';
  end if;
  if v_run.rows_hash is not null and v_run.rows_hash <> p_base_rows_hash then
    raise sqlstate 'PT409' using message = 'ROWS_HASH_CONFLICT';
  end if;
  if p_user_key is null or p_base_rows_hash is null
     or p_base_rows_hash !~ '^[0-9a-f]{64}$'
     or p_answer_sha256 is null or p_answer_sha256 !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(p_diff) is distinct from 'object'
     or jsonb_typeof(p_diff -> 'rows') is distinct from 'array'
     or jsonb_array_length(p_diff -> 'rows') not between 1 and 1000 then
    raise exception 'invalid comparison payload';
  end if;

  select count(*), count(distinct row_item ->> 'id')
  into v_problem_count, v_unique_ids
  from jsonb_array_elements(p_diff -> 'rows') row_item
  where nullif(row_item ->> 'id', '') is not null;
  if v_problem_count <> jsonb_array_length(p_diff -> 'rows') or v_unique_ids <> v_problem_count then
    raise exception 'comparison item ids must be present and unique';
  end if;

  insert into public.answer_comparisons (
    tenant_key, created_by_key, id, run_id, sequence_no, base_row_revision,
    base_rows_hash, answer_sha256, source_file_name, source_sheet, diff, created_by
  ) values (
    p_tenant_key, p_user_key, p_comparison_id, p_run_id,
    v_run.comparison_revision + 1, p_expected_row_revision, p_base_rows_hash,
    p_answer_sha256, p_source_file_name, p_source_sheet, p_diff, p_actor_label
  );

  update public.runs set
    answer = p_diff, rows_hash = p_base_rows_hash,
    comparison_revision = comparison_revision + 1
  where tenant_key = p_tenant_key and id = p_run_id;

  insert into public.learning_events (
    tenant_key, actor_user_key, id, run_id, ts, kind, before, after, context,
    actor_label, comparison_id
  ) values (
    p_tenant_key, p_user_key, p_learning_event_id, p_run_id, now(),
    'run_feedback', null,
    jsonb_build_object(
      'accuracy', p_diff -> 'accuracy', 'counts', p_diff -> 'counts',
      'fileName', p_source_file_name
    ),
    jsonb_build_object(
      'vocab', v_run.vocab, 'fileName', v_run.file_name,
      'calibrationId', v_run.calibration_id
    ),
    p_actor_label, p_comparison_id
  );

  return jsonb_build_object(
    'comparisonId', p_comparison_id,
    'comparisonRevision', v_run.comparison_revision + 1,
    'answer', p_diff
  );
end;
$$;

create or replace function public.save_calibration_version_v2(
  p_tenant_key text,
  p_user_key text,
  p_calibration_id uuid,
  p_expected_version bigint,
  p_name text,
  p_rules jsonb,
  p_learned_from jsonb,
  p_actor_label text,
  p_model_family text,
  p_client_key text,
  p_status text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_calibration public.calibrations%rowtype;
  v_new_version bigint;
begin
  if p_user_key is null or p_calibration_id is null
     or p_expected_version is null or p_expected_version < 0
     or p_name is null or length(p_name) not between 1 and 120
     or jsonb_typeof(p_rules) is distinct from 'object'
     or jsonb_typeof(p_learned_from) is distinct from 'array'
     or jsonb_array_length(p_learned_from) > 1000
     or p_model_family is null or p_model_family not in ('plant3d-local', 'aps', 'legacy')
     or p_client_key is null or p_client_key !~ '^[a-z0-9][a-z0-9_-]{0,63}$'
     or p_status is null or p_status not in ('draft', 'active') then
    raise exception 'invalid calibration payload';
  end if;
  if exists (
    select 1 from public.calibrations
    where id = p_calibration_id and tenant_key <> p_tenant_key
  ) then
    raise sqlstate 'PT409' using message = 'PROFILE_ID_REUSED';
  end if;

  select * into v_calibration from public.calibrations
  where tenant_key = p_tenant_key and id = p_calibration_id for update;
  if found then
    if v_calibration.archived_at is not null then
      raise sqlstate 'PT409' using message = 'PROFILE_ARCHIVED';
    end if;
    if v_calibration.version <> p_expected_version then
      raise sqlstate 'PT409' using message = 'PROFILE_VERSION_CONFLICT';
    end if;
    if v_calibration.model_family <> p_model_family
       or v_calibration.client_key <> p_client_key then
      raise sqlstate 'PT409' using message = 'PROFILE_SCOPE_CONFLICT';
    end if;
    v_new_version := v_calibration.version + 1;
    update public.calibrations set
      name = p_name, rules = p_rules, learned_from = p_learned_from,
      status = p_status, version = v_new_version, updated_at = now()
    where tenant_key = p_tenant_key and id = p_calibration_id;
  else
    if p_expected_version <> 0 then
      raise sqlstate 'PT409' using message = 'PROFILE_VERSION_CONFLICT';
    end if;
    v_new_version := 1;
    insert into public.calibrations (
      tenant_key, id, name, rules, learned_from, version,
      model_family, client_key, status, created_at, updated_at
    ) values (
      p_tenant_key, p_calibration_id, p_name, p_rules, p_learned_from, 1,
      p_model_family, p_client_key, p_status, now(), now()
    );
  end if;

  insert into public.calibration_versions (
    tenant_key, created_by_key, calibration_id, version, name, rules,
    learned_from, metrics, created_by
  ) values (
    p_tenant_key, p_user_key, p_calibration_id, v_new_version, p_name, p_rules,
    p_learned_from,
    jsonb_build_object(
      'kind', 'manual', 'modelFamily', p_model_family,
      'clientKey', p_client_key, 'status', p_status
    ),
    p_actor_label
  );
  return jsonb_build_object('id', p_calibration_id, 'version', v_new_version);
end;
$$;

create or replace function public.archive_calibration_v2(
  p_tenant_key text,
  p_user_key text,
  p_calibration_id uuid,
  p_expected_version bigint,
  p_actor_label text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_calibration public.calibrations%rowtype;
  v_new_version bigint;
begin
  select * into v_calibration from public.calibrations
  where tenant_key = p_tenant_key and id = p_calibration_id for update;
  if not found then return jsonb_build_object('ok', true, 'missing', true); end if;
  if v_calibration.archived_at is not null then
    return jsonb_build_object('ok', true, 'version', v_calibration.version);
  end if;
  if v_calibration.version <> p_expected_version then
    raise sqlstate 'PT409' using message = 'PROFILE_VERSION_CONFLICT';
  end if;
  v_new_version := v_calibration.version + 1;
  update public.calibrations set
    archived_at = now(), status = 'archived', version = v_new_version, updated_at = now()
  where tenant_key = p_tenant_key and id = p_calibration_id;
  insert into public.calibration_versions (
    tenant_key, created_by_key, calibration_id, version, name, rules,
    learned_from, metrics, created_by
  ) values (
    p_tenant_key, p_user_key, p_calibration_id, v_new_version,
    v_calibration.name, v_calibration.rules, v_calibration.learned_from,
    jsonb_build_object('archived', true), p_actor_label
  );
  return jsonb_build_object('ok', true, 'version', v_new_version);
end;
$$;

create or replace function public.apply_answer_calibration_v2(
  p_tenant_key text,
  p_user_key text,
  p_run_id uuid,
  p_comparison_id uuid,
  p_commit_id uuid,
  p_request_hash text,
  p_expected_row_revision bigint,
  p_expected_profile_version bigint,
  p_calibration_id uuid,
  p_calibration_name text,
  p_rules jsonb,
  p_learned_from jsonb,
  p_decisions jsonb,
  p_rows jsonb,
  p_rows_after_hash text,
  p_totals jsonb,
  p_answer_after jsonb,
  p_metrics_after jsonb,
  p_actor_label text,
  p_learning_event_id uuid,
  p_model_family text,
  p_client_key text,
  p_status text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_run public.runs%rowtype;
  v_comparison public.answer_comparisons%rowtype;
  v_calibration public.calibrations%rowtype;
  v_existing_commit public.calibration_commits%rowtype;
  v_new_profile_version bigint;
  v_problem_count int;
  v_decision_count int;
  v_unique_decisions int;
begin
  select * into v_run from public.runs
  where tenant_key = p_tenant_key and id = p_run_id for update;
  if not found then raise exception 'run not found'; end if;

  select * into v_existing_commit from public.calibration_commits
  where tenant_key = p_tenant_key and id = p_commit_id;
  if found then
    if v_existing_commit.request_hash <> p_request_hash
       or v_existing_commit.run_id <> p_run_id then
      raise sqlstate 'PT409' using message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return jsonb_build_object(
      'commitId', p_commit_id,
      'calibrationId', v_existing_commit.calibration_id,
      'calibrationVersion', v_existing_commit.new_profile_version,
      'rowRevision', v_existing_commit.new_row_revision,
      'answer', v_run.answer,
      'idempotent', true
    );
  end if;
  if exists (
    select 1 from public.calibration_commits
    where id = p_commit_id and tenant_key <> p_tenant_key
  ) then
    raise sqlstate 'PT409' using message = 'IDEMPOTENCY_KEY_REUSED';
  end if;

  if v_run.status <> 'done' then raise sqlstate 'PT409' using message = 'RUN_NOT_DONE'; end if;
  if p_expected_row_revision is null or v_run.row_revision <> p_expected_row_revision then
    raise sqlstate 'PT409' using message = 'RUN_REVISION_CONFLICT';
  end if;
  if p_user_key is null or p_calibration_id is null
     or p_expected_profile_version is null or p_expected_profile_version < 0
     or p_calibration_name is null or length(p_calibration_name) not between 1 and 120
     or p_request_hash is null
     or p_request_hash !~ '^[0-9a-f]{64}$'
     or p_rows_after_hash is null or p_rows_after_hash !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) > 5000
     or jsonb_typeof(p_decisions) is distinct from 'array'
     or jsonb_array_length(p_decisions) not between 1 and 1000
     or jsonb_typeof(p_rules) is distinct from 'object'
     or jsonb_typeof(p_totals) is distinct from 'object'
     or jsonb_typeof(p_answer_after) is distinct from 'object'
     or jsonb_typeof(p_metrics_after) is distinct from 'object'
     or jsonb_typeof(p_learned_from) is distinct from 'array'
     or jsonb_array_length(p_learned_from) > 1000
     or p_model_family is null or p_model_family not in ('plant3d-local', 'aps', 'legacy')
     or p_client_key is null or p_client_key !~ '^[a-z0-9][a-z0-9_-]{0,63}$'
     or p_status is null or p_status not in ('draft', 'active') then
    raise exception 'invalid calibration payload';
  end if;

  select * into v_comparison from public.answer_comparisons
  where tenant_key = p_tenant_key and id = p_comparison_id and run_id = p_run_id;
  if not found then raise exception 'comparison not found'; end if;
  if v_comparison.base_row_revision <> v_run.row_revision
     or v_comparison.base_rows_hash <> v_run.rows_hash
     or v_run.answer ->> 'id' is distinct from p_comparison_id::text then
    raise sqlstate 'PT409' using message = 'COMPARISON_STALE';
  end if;

  select count(*) into v_problem_count
  from jsonb_array_elements(v_comparison.diff -> 'rows') item
  where item ->> 'status' <> 'match';
  select count(*), count(distinct decision ->> 'itemId')
  into v_decision_count, v_unique_decisions
  from jsonb_array_elements(p_decisions) decision;
  if v_decision_count <> v_problem_count or v_unique_decisions <> v_decision_count
     or exists (
       select 1 from jsonb_array_elements(p_decisions) decision
       where decision ->> 'choice' not in ('ours', 'answer', 'custom')
          or not exists (
            select 1 from jsonb_array_elements(v_comparison.diff -> 'rows') item
            where item ->> 'id' = decision ->> 'itemId' and item ->> 'status' <> 'match'
          )
     ) then
    raise exception 'every comparison difference needs one valid decision';
  end if;

  if exists (
    select 1 from public.calibrations
    where id = p_calibration_id and tenant_key <> p_tenant_key
  ) then
    raise sqlstate 'PT409' using message = 'PROFILE_ID_REUSED';
  end if;
  select * into v_calibration from public.calibrations
  where tenant_key = p_tenant_key and id = p_calibration_id for update;
  if found then
    if v_calibration.archived_at is not null then
      raise sqlstate 'PT409' using message = 'PROFILE_ARCHIVED';
    end if;
    if v_calibration.version <> p_expected_profile_version then
      raise sqlstate 'PT409' using message = 'PROFILE_VERSION_CONFLICT';
    end if;
    if v_calibration.model_family <> p_model_family
       or v_calibration.client_key <> p_client_key then
      raise sqlstate 'PT409' using message = 'PROFILE_SCOPE_CONFLICT';
    end if;
    v_new_profile_version := v_calibration.version + 1;
    update public.calibrations set
      name = p_calibration_name, rules = p_rules, learned_from = p_learned_from,
      status = p_status, version = v_new_profile_version, updated_at = now()
    where tenant_key = p_tenant_key and id = p_calibration_id;
  else
    if p_expected_profile_version <> 0 then
      raise sqlstate 'PT409' using message = 'PROFILE_VERSION_CONFLICT';
    end if;
    v_new_profile_version := 1;
    insert into public.calibrations (
      tenant_key, id, name, rules, learned_from, version,
      model_family, client_key, status, created_at, updated_at
    ) values (
      p_tenant_key, p_calibration_id, p_calibration_name, p_rules,
      p_learned_from, 1, p_model_family, p_client_key, p_status, now(), now()
    );
  end if;

  insert into public.calibration_versions (
    tenant_key, created_by_key, calibration_id, version, name, rules,
    learned_from, source_comparison_id, metrics, created_by
  ) values (
    p_tenant_key, p_user_key, p_calibration_id, v_new_profile_version,
    p_calibration_name, p_rules, p_learned_from, p_comparison_id,
    jsonb_build_object(
      'before', v_comparison.diff -> 'accuracy',
      'after', p_metrics_after -> 'accuracy',
      'counts', v_comparison.diff -> 'counts',
      'modelFamily', p_model_family, 'clientKey', p_client_key, 'status', p_status
    ),
    p_actor_label
  );

  delete from public.mto_rows where tenant_key = p_tenant_key and run_id = p_run_id;
  insert into public.mto_rows (
    tenant_key, id, run_id, idx, line, code, sub, s1, s2, qty, unit, remark, scope, edited
  )
  select p_tenant_key, x.id, p_run_id, x.idx, x.line, x.code, x.sub, x.s1,
         x.s2, x.qty, x.unit, x.remark, x.scope, coalesce(x.edited, false)
  from jsonb_to_recordset(p_rows) as x(
    id text, idx int, line text, code text, sub text, s1 numeric, s2 numeric,
    qty numeric, unit text, remark text, scope text, edited boolean
  );

  update public.runs set
    totals = p_totals, answer = p_answer_after, calibration_id = p_calibration_id,
    row_revision = row_revision + 1, rows_hash = p_rows_after_hash
  where tenant_key = p_tenant_key and id = p_run_id;

  insert into public.calibration_commits (
    tenant_key, created_by_key, id, request_hash, run_id, comparison_id,
    calibration_id, base_row_revision, new_row_revision, base_profile_version,
    new_profile_version, decisions, rows_before_hash, rows_after_hash, rows_after,
    metrics_before, metrics_after, created_by
  ) values (
    p_tenant_key, p_user_key, p_commit_id, p_request_hash, p_run_id,
    p_comparison_id, p_calibration_id, v_run.row_revision, v_run.row_revision + 1,
    p_expected_profile_version, v_new_profile_version, p_decisions,
    v_run.rows_hash, p_rows_after_hash, p_rows,
    jsonb_build_object('accuracy', v_comparison.diff -> 'accuracy'),
    p_metrics_after, p_actor_label
  );

  insert into public.learning_events (
    tenant_key, actor_user_key, id, run_id, ts, kind, before, after, context,
    actor_label, comparison_id, calibration_commit_id
  ) values (
    p_tenant_key, p_user_key, p_learning_event_id, p_run_id, now(),
    'calibration_saved',
    jsonb_build_object('accuracy', v_comparison.diff -> 'accuracy'),
    jsonb_build_object(
      'accuracy', p_metrics_after -> 'accuracy',
      'profileVersion', v_new_profile_version,
      'decisions', p_decisions
    ),
    jsonb_build_object(
      'vocab', v_run.vocab, 'fileName', v_run.file_name,
      'calibrationId', p_calibration_id
    ),
    p_actor_label, p_comparison_id, p_commit_id
  );

  return jsonb_build_object(
    'commitId', p_commit_id,
    'calibrationId', p_calibration_id,
    'calibrationVersion', v_new_profile_version,
    'rowRevision', v_run.row_revision + 1,
    'answer', p_answer_after,
    'idempotent', false
  );
end;
$$;

create or replace function public.apply_run_feedback_v1(
  p_tenant_key text,
  p_user_key text,
  p_run_id uuid,
  p_expected_row_revision bigint,
  p_expected_rows_hash text,
  p_rows jsonb,
  p_rows_after_hash text,
  p_totals jsonb,
  p_actor_label text,
  p_events jsonb,
  p_calibration_id uuid default null,
  p_expected_profile_version bigint default null,
  p_calibration_name text default null,
  p_rules jsonb default null,
  p_learned_from jsonb default null,
  p_model_family text default null,
  p_client_key text default null,
  p_status text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_run public.runs%rowtype;
  v_calibration public.calibrations%rowtype;
  v_new_profile_version bigint;
  v_event_count int;
  v_unique_events int;
begin
  select * into v_run from public.runs
  where tenant_key = p_tenant_key and id = p_run_id for update;
  if not found then raise exception 'run not found'; end if;
  if v_run.status <> 'done' then raise sqlstate 'PT409' using message = 'RUN_NOT_DONE'; end if;
  if p_expected_row_revision is null or v_run.row_revision <> p_expected_row_revision then
    raise sqlstate 'PT409' using message = 'RUN_REVISION_CONFLICT';
  end if;
  if v_run.rows_hash is not null and v_run.rows_hash <> p_expected_rows_hash then
    raise sqlstate 'PT409' using message = 'ROWS_HASH_CONFLICT';
  end if;
  if p_user_key is null or p_expected_rows_hash is null
     or p_expected_rows_hash !~ '^[0-9a-f]{64}$'
     or p_rows_after_hash is null or p_rows_after_hash !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) > 5000
     or jsonb_typeof(p_totals) is distinct from 'object'
     or jsonb_typeof(p_events) is distinct from 'array'
     or jsonb_array_length(p_events) not between 1 and 20 then
    raise exception 'invalid feedback payload';
  end if;

  select count(*), count(distinct event_item ->> 'id')
  into v_event_count, v_unique_events
  from jsonb_array_elements(p_events) event_item;
  if v_event_count <> v_unique_events or exists (
    select 1 from jsonb_array_elements(p_events) event_item
    where event_item ->> 'kind' <> 'run_feedback'
       or nullif(event_item ->> 'id', '') is null
       or event_item ->> 'runId' is distinct from p_run_id::text
       or jsonb_typeof(event_item -> 'after') is distinct from 'object'
       or jsonb_typeof(event_item -> 'context') is distinct from 'object'
  ) then
    raise exception 'invalid feedback learning events';
  end if;

  if p_calibration_id is not null then
    if p_expected_profile_version is null or p_expected_profile_version < 0
       or p_calibration_name is null or length(p_calibration_name) not between 1 and 120
       or jsonb_typeof(p_rules) is distinct from 'object'
       or jsonb_typeof(p_learned_from) is distinct from 'array'
       or jsonb_array_length(p_learned_from) > 1000
       or p_model_family is null or p_model_family not in ('plant3d-local', 'aps', 'legacy')
       or p_client_key is null or p_client_key !~ '^[a-z0-9][a-z0-9_-]{0,63}$'
       or p_status is null or p_status not in ('draft', 'active') then
      raise exception 'invalid feedback calibration payload';
    end if;
    if exists (
      select 1 from public.calibrations
      where id = p_calibration_id and tenant_key <> p_tenant_key
    ) then
      raise sqlstate 'PT409' using message = 'PROFILE_ID_REUSED';
    end if;

    select * into v_calibration from public.calibrations
    where tenant_key = p_tenant_key and id = p_calibration_id for update;
    if found then
      if v_calibration.archived_at is not null then
        raise sqlstate 'PT409' using message = 'PROFILE_ARCHIVED';
      end if;
      if v_calibration.version <> p_expected_profile_version then
        raise sqlstate 'PT409' using message = 'PROFILE_VERSION_CONFLICT';
      end if;
      if v_calibration.model_family <> p_model_family
         or v_calibration.client_key <> p_client_key then
        raise sqlstate 'PT409' using message = 'PROFILE_SCOPE_CONFLICT';
      end if;
      v_new_profile_version := v_calibration.version + 1;
      update public.calibrations set
        name = p_calibration_name, rules = p_rules, learned_from = p_learned_from,
        status = p_status, version = v_new_profile_version, updated_at = now()
      where tenant_key = p_tenant_key and id = p_calibration_id;
    else
      if p_expected_profile_version <> 0 then
        raise sqlstate 'PT409' using message = 'PROFILE_VERSION_CONFLICT';
      end if;
      v_new_profile_version := 1;
      insert into public.calibrations (
        tenant_key, id, name, rules, learned_from, version,
        model_family, client_key, status, created_at, updated_at
      ) values (
        p_tenant_key, p_calibration_id, p_calibration_name, p_rules,
        p_learned_from, 1, p_model_family, p_client_key, p_status, now(), now()
      );
    end if;

    insert into public.calibration_versions (
      tenant_key, created_by_key, calibration_id, version, name, rules,
      learned_from, metrics, created_by
    ) values (
      p_tenant_key, p_user_key, p_calibration_id, v_new_profile_version,
      p_calibration_name, p_rules, p_learned_from,
      jsonb_build_object(
        'kind', 'run_feedback', 'runId', p_run_id,
        'modelFamily', p_model_family, 'clientKey', p_client_key, 'status', p_status
      ),
      p_actor_label
    );
  elsif p_expected_profile_version is not null or p_calibration_name is not null
     or p_rules is not null or p_learned_from is not null or p_model_family is not null
     or p_client_key is not null or p_status is not null then
    raise exception 'partial feedback calibration payload';
  end if;

  delete from public.mto_rows where tenant_key = p_tenant_key and run_id = p_run_id;
  insert into public.mto_rows (
    tenant_key, id, run_id, idx, line, code, sub, s1, s2, qty, unit, remark, scope, edited
  )
  select p_tenant_key, x.id, p_run_id, x.idx, x.line, x.code, x.sub, x.s1,
         x.s2, x.qty, x.unit, x.remark, x.scope, coalesce(x.edited, false)
  from jsonb_to_recordset(p_rows) as x(
    id text, idx int, line text, code text, sub text, s1 numeric, s2 numeric,
    qty numeric, unit text, remark text, scope text, edited boolean
  );

  update public.runs set
    totals = p_totals, answer = null,
    calibration_id = coalesce(p_calibration_id, calibration_id),
    row_revision = row_revision + 1, rows_hash = p_rows_after_hash
  where tenant_key = p_tenant_key and id = p_run_id;

  insert into public.learning_events (
    tenant_key, actor_user_key, id, run_id, ts, kind, before, after,
    context, actor_label
  )
  select p_tenant_key, p_user_key, (event_item ->> 'id')::uuid, p_run_id,
         now(), 'run_feedback', null, event_item -> 'after',
         jsonb_build_object(
           'vocab', v_run.vocab, 'fileName', v_run.file_name,
           'calibrationId', coalesce(p_calibration_id, v_run.calibration_id)
         ),
         p_actor_label
  from jsonb_array_elements(p_events) event_item;

  return jsonb_build_object(
    'rowRevision', v_run.row_revision + 1,
    'calibrationId', coalesce(p_calibration_id, v_run.calibration_id),
    'calibrationVersion', v_new_profile_version
  );
end;
$$;

-- Scoped v2 entry points are exposed now. Unscoped v1 functions stay callable
-- only through the short deployment bridge and are retired in the contract migration.
revoke all privileges on function public.replace_mto_rows_v2(text, uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.replace_mto_rows_v2(text, uuid, jsonb) to service_role;
revoke all privileges on function public.replace_steel_rows_v2(text, uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.replace_steel_rows_v2(text, uuid, jsonb) to service_role;
revoke all privileges on function public.delete_run_and_queue_storage_v2(text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.delete_run_and_queue_storage_v2(text, uuid, text) to service_role;
revoke all privileges on function public.record_answer_comparison_v2(
  text, text, uuid, uuid, bigint, bigint, text, text, text, text, jsonb, text, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.record_answer_comparison_v2(
  text, text, uuid, uuid, bigint, bigint, text, text, text, text, jsonb, text, uuid
) to service_role;
revoke all privileges on function public.save_calibration_version_v2(
  text, text, uuid, bigint, text, jsonb, jsonb, text, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.save_calibration_version_v2(
  text, text, uuid, bigint, text, jsonb, jsonb, text, text, text, text
) to service_role;
revoke all privileges on function public.archive_calibration_v2(text, text, uuid, bigint, text)
  from public, anon, authenticated, service_role;
grant execute on function public.archive_calibration_v2(text, text, uuid, bigint, text) to service_role;
revoke all privileges on function public.apply_answer_calibration_v2(
  text, text, uuid, uuid, uuid, text, bigint, bigint, uuid, text, jsonb, jsonb,
  jsonb, jsonb, text, jsonb, jsonb, jsonb, text, uuid, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.apply_answer_calibration_v2(
  text, text, uuid, uuid, uuid, text, bigint, bigint, uuid, text, jsonb, jsonb,
  jsonb, jsonb, text, jsonb, jsonb, jsonb, text, uuid, text, text, text
) to service_role;
revoke all privileges on function public.apply_run_feedback_v1(
  text, text, uuid, bigint, text, jsonb, text, jsonb, text, jsonb,
  uuid, bigint, text, jsonb, jsonb, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.apply_run_feedback_v1(
  text, text, uuid, bigint, text, jsonb, text, jsonb, text, jsonb,
  uuid, bigint, text, jsonb, jsonb, text, text, text
) to service_role;
