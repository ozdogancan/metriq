-- Auditable calibration workbench: immutable comparisons/versions/commits,
-- optimistic row/profile revisions, and atomic answer application.

alter table public.runs
  add column if not exists row_revision bigint not null default 0,
  add column if not exists rows_hash text,
  add column if not exists comparison_revision bigint not null default 0;

alter table public.calibrations
  add column if not exists version bigint not null default 1,
  add column if not exists archived_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'runs_revisions_valid' and conrelid = 'public.runs'::regclass
  ) then
    alter table public.runs add constraint runs_revisions_valid check (
      row_revision >= 0 and comparison_revision >= 0
      and (rows_hash is null or rows_hash ~ '^[0-9a-f]{64}$')
    );
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'calibrations_version_valid' and conrelid = 'public.calibrations'::regclass
  ) then
    alter table public.calibrations
      add constraint calibrations_version_valid check (version > 0);
  end if;
end $$;

create table if not exists public.answer_comparisons (
  id uuid primary key,
  run_id uuid not null references public.runs(id) on delete cascade,
  sequence_no bigint not null check (sequence_no > 0),
  base_row_revision bigint not null check (base_row_revision >= 0),
  base_rows_hash text not null check (base_rows_hash ~ '^[0-9a-f]{64}$'),
  answer_sha256 text not null check (answer_sha256 ~ '^[0-9a-f]{64}$'),
  source_file_name text not null check (length(source_file_name) between 1 and 255),
  source_sheet text not null check (length(source_sheet) between 1 and 120),
  diff jsonb not null check (
    case
      when jsonb_typeof(diff) = 'object' and jsonb_typeof(diff -> 'rows') = 'array'
      then jsonb_array_length(diff -> 'rows') between 1 and 1000
      else false
    end
  ),
  created_by text not null check (length(created_by) between 1 and 254),
  created_at timestamptz not null default now(),
  unique (run_id, sequence_no),
  unique (run_id, id)
);

create index if not exists answer_comparisons_run_created
  on public.answer_comparisons(run_id, created_at desc);

create table if not exists public.calibration_versions (
  calibration_id uuid not null references public.calibrations(id) on delete restrict,
  version bigint not null check (version > 0),
  name text not null check (length(name) between 1 and 120),
  rules jsonb not null check (jsonb_typeof(rules) = 'object'),
  learned_from jsonb not null default '[]'::jsonb check (
    case when jsonb_typeof(learned_from) = 'array'
      then jsonb_array_length(learned_from) <= 1000 else false end
  ),
  source_comparison_id uuid references public.answer_comparisons(id) on delete set null,
  metrics jsonb not null default '{}'::jsonb check (jsonb_typeof(metrics) = 'object'),
  created_by text not null check (length(created_by) between 1 and 254),
  created_at timestamptz not null default now(),
  primary key (calibration_id, version)
);

create index if not exists calibration_versions_source_comparison
  on public.calibration_versions(source_comparison_id);

insert into public.calibration_versions (
  calibration_id, version, name, rules, learned_from, created_by, created_at
)
select id, version, name, rules, learned_from, 'system:migration', coalesce(updated_at, created_at)
from public.calibrations
on conflict (calibration_id, version) do nothing;

create table if not exists public.calibration_commits (
  id uuid primary key,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  run_id uuid not null,
  comparison_id uuid not null,
  calibration_id uuid not null,
  base_row_revision bigint not null check (base_row_revision >= 0),
  new_row_revision bigint not null,
  base_profile_version bigint not null check (base_profile_version >= 0),
  new_profile_version bigint not null,
  decisions jsonb not null check (
    case when jsonb_typeof(decisions) = 'array'
      then jsonb_array_length(decisions) between 1 and 1000 else false end
  ),
  rows_before_hash text not null check (rows_before_hash ~ '^[0-9a-f]{64}$'),
  rows_after_hash text not null check (rows_after_hash ~ '^[0-9a-f]{64}$'),
  rows_after jsonb not null check (
    case when jsonb_typeof(rows_after) = 'array'
      then jsonb_array_length(rows_after) <= 5000 else false end
  ),
  metrics_before jsonb not null check (jsonb_typeof(metrics_before) = 'object'),
  metrics_after jsonb not null check (jsonb_typeof(metrics_after) = 'object'),
  created_by text not null check (length(created_by) between 1 and 254),
  created_at timestamptz not null default now(),
  constraint calibration_commit_row_revision_step
    check (new_row_revision = base_row_revision + 1),
  constraint calibration_commit_profile_version_step
    check (new_profile_version = base_profile_version + 1),
  constraint calibration_commit_comparison_fk
    foreign key (run_id, comparison_id)
    references public.answer_comparisons(run_id, id) on delete cascade,
  constraint calibration_commit_version_fk
    foreign key (calibration_id, new_profile_version)
    references public.calibration_versions(calibration_id, version)
);

create index if not exists calibration_commits_run_created
  on public.calibration_commits(run_id, created_at desc);
create index if not exists calibration_commits_comparison
  on public.calibration_commits(comparison_id);
create index if not exists calibration_commits_profile_version
  on public.calibration_commits(calibration_id, new_profile_version);

alter table public.learning_events
  add column if not exists actor_label text,
  add column if not exists comparison_id uuid references public.answer_comparisons(id) on delete set null,
  add column if not exists calibration_commit_id uuid references public.calibration_commits(id) on delete set null;

create index if not exists learning_events_comparison on public.learning_events(comparison_id);
create index if not exists learning_events_calibration_commit on public.learning_events(calibration_commit_id);

alter table public.answer_comparisons enable row level security;
alter table public.answer_comparisons force row level security;
alter table public.calibration_versions enable row level security;
alter table public.calibration_versions force row level security;
alter table public.calibration_commits enable row level security;
alter table public.calibration_commits force row level security;

revoke all privileges on table
  public.answer_comparisons,
  public.calibration_versions,
  public.calibration_commits
from public, anon, authenticated, service_role;

grant select, insert on table
  public.answer_comparisons,
  public.calibration_versions,
  public.calibration_commits
to service_role;

-- Every generic row replacement invalidates the active comparison and bumps
-- the optimistic revision. The caller can record a fresh canonical hash on
-- the next answer comparison.
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

  update public.runs
  set row_revision = row_revision + 1, rows_hash = null, answer = null
  where id = p_run_id;
end;
$$;

create or replace function public.record_answer_comparison_v1(
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
  select * into v_run from public.runs where id = p_run_id for update;
  if not found then raise exception 'run not found'; end if;

  if exists (select 1 from public.answer_comparisons where id = p_comparison_id) then
    if exists (
      select 1 from public.answer_comparisons
      where id = p_comparison_id and run_id = p_run_id
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

  if v_run.status <> 'done' then raise sqlstate 'PT409' using message = 'RUN_NOT_DONE'; end if;
  if v_run.row_revision <> p_expected_row_revision
     or v_run.comparison_revision <> p_expected_comparison_revision then
    raise sqlstate 'PT409' using message = 'RUN_REVISION_CONFLICT';
  end if;
  if v_run.rows_hash is not null and v_run.rows_hash <> p_base_rows_hash then
    raise sqlstate 'PT409' using message = 'ROWS_HASH_CONFLICT';
  end if;
  if p_base_rows_hash !~ '^[0-9a-f]{64}$' or p_answer_sha256 !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(p_diff) <> 'object' or jsonb_typeof(p_diff -> 'rows') <> 'array'
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
    id, run_id, sequence_no, base_row_revision, base_rows_hash, answer_sha256,
    source_file_name, source_sheet, diff, created_by
  ) values (
    p_comparison_id, p_run_id, v_run.comparison_revision + 1,
    p_expected_row_revision, p_base_rows_hash, p_answer_sha256,
    p_source_file_name, p_source_sheet, p_diff, p_actor_label
  );

  update public.runs
  set answer = p_diff,
      rows_hash = p_base_rows_hash,
      comparison_revision = comparison_revision + 1
  where id = p_run_id;

  insert into public.learning_events (
    id, run_id, ts, kind, before, after, context, actor_label, comparison_id
  ) values (
    p_learning_event_id, p_run_id, now(), 'run_feedback', null,
    jsonb_build_object(
      'accuracy', p_diff -> 'accuracy', 'counts', p_diff -> 'counts',
      'fileName', p_source_file_name
    ),
    jsonb_build_object('vocab', v_run.vocab, 'fileName', v_run.file_name,
      'calibrationId', v_run.calibration_id),
    p_actor_label, p_comparison_id
  );

  return jsonb_build_object(
    'comparisonId', p_comparison_id,
    'comparisonRevision', v_run.comparison_revision + 1,
    'answer', p_diff
  );
end;
$$;

create or replace function public.apply_answer_calibration_v1(
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
  p_learning_event_id uuid
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
  v_result jsonb;
begin
  select * into v_run from public.runs where id = p_run_id for update;
  if not found then raise exception 'run not found'; end if;

  select * into v_existing_commit from public.calibration_commits where id = p_commit_id;
  if found then
    if v_existing_commit.request_hash <> p_request_hash then
      raise sqlstate 'PT409' using message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    select answer into v_result from public.runs where id = p_run_id;
    return jsonb_build_object(
      'commitId', p_commit_id,
      'calibrationId', v_existing_commit.calibration_id,
      'calibrationVersion', v_existing_commit.new_profile_version,
      'rowRevision', v_existing_commit.new_row_revision,
      'answer', v_result,
      'idempotent', true
    );
  end if;

  if v_run.status <> 'done' then raise sqlstate 'PT409' using message = 'RUN_NOT_DONE'; end if;
  if v_run.row_revision <> p_expected_row_revision then
    raise sqlstate 'PT409' using message = 'RUN_REVISION_CONFLICT';
  end if;
  if p_request_hash !~ '^[0-9a-f]{64}$' or p_rows_after_hash !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 5000
     or jsonb_typeof(p_decisions) <> 'array' or jsonb_array_length(p_decisions) not between 1 and 1000
     or jsonb_typeof(p_rules) <> 'object' or jsonb_typeof(p_totals) <> 'object'
     or jsonb_typeof(p_answer_after) <> 'object' or jsonb_typeof(p_metrics_after) <> 'object'
     or jsonb_typeof(p_learned_from) <> 'array' or jsonb_array_length(p_learned_from) > 1000 then
    raise exception 'invalid calibration payload';
  end if;

  select * into v_comparison
  from public.answer_comparisons
  where id = p_comparison_id and run_id = p_run_id;
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

  select * into v_calibration
  from public.calibrations where id = p_calibration_id for update;
  if found then
    if v_calibration.archived_at is not null then
      raise sqlstate 'PT409' using message = 'PROFILE_ARCHIVED';
    end if;
    if v_calibration.version <> p_expected_profile_version then
      raise sqlstate 'PT409' using message = 'PROFILE_VERSION_CONFLICT';
    end if;
    v_new_profile_version := v_calibration.version + 1;
    update public.calibrations
    set name = p_calibration_name, rules = p_rules, learned_from = p_learned_from,
        version = v_new_profile_version, updated_at = now()
    where id = p_calibration_id;
  else
    if p_expected_profile_version <> 0 then
      raise sqlstate 'PT409' using message = 'PROFILE_VERSION_CONFLICT';
    end if;
    v_new_profile_version := 1;
    insert into public.calibrations (
      id, name, rules, learned_from, version, created_at, updated_at
    ) values (
      p_calibration_id, p_calibration_name, p_rules, p_learned_from, 1, now(), now()
    );
  end if;

  insert into public.calibration_versions (
    calibration_id, version, name, rules, learned_from,
    source_comparison_id, metrics, created_by
  ) values (
    p_calibration_id, v_new_profile_version, p_calibration_name, p_rules,
    p_learned_from, p_comparison_id,
    jsonb_build_object(
      'before', v_comparison.diff -> 'accuracy',
      'after', p_metrics_after -> 'accuracy',
      'counts', v_comparison.diff -> 'counts'
    ),
    p_actor_label
  );

  delete from public.mto_rows where run_id = p_run_id;
  insert into public.mto_rows (id, run_id, idx, line, code, sub, s1, s2, qty, unit, remark, scope, edited)
  select x.id, p_run_id, x.idx, x.line, x.code, x.sub, x.s1, x.s2, x.qty,
         x.unit, x.remark, x.scope, coalesce(x.edited, false)
  from jsonb_to_recordset(p_rows) as x(
    id text, idx int, line text, code text, sub text, s1 numeric, s2 numeric,
    qty numeric, unit text, remark text, scope text, edited boolean
  );

  update public.runs
  set totals = p_totals, answer = p_answer_after, calibration_id = p_calibration_id,
      row_revision = row_revision + 1, rows_hash = p_rows_after_hash
  where id = p_run_id;

  insert into public.calibration_commits (
    id, request_hash, run_id, comparison_id, calibration_id,
    base_row_revision, new_row_revision, base_profile_version, new_profile_version,
    decisions, rows_before_hash, rows_after_hash, rows_after,
    metrics_before, metrics_after, created_by
  ) values (
    p_commit_id, p_request_hash, p_run_id, p_comparison_id, p_calibration_id,
    v_run.row_revision, v_run.row_revision + 1,
    p_expected_profile_version, v_new_profile_version,
    p_decisions, v_run.rows_hash, p_rows_after_hash, p_rows,
    jsonb_build_object('accuracy', v_comparison.diff -> 'accuracy'),
    p_metrics_after, p_actor_label
  );

  insert into public.learning_events (
    id, run_id, ts, kind, before, after, context,
    actor_label, comparison_id, calibration_commit_id
  ) values (
    p_learning_event_id, p_run_id, now(), 'calibration_saved',
    jsonb_build_object('accuracy', v_comparison.diff -> 'accuracy'),
    jsonb_build_object(
      'accuracy', p_metrics_after -> 'accuracy',
      'profileVersion', v_new_profile_version,
      'decisions', p_decisions
    ),
    jsonb_build_object('vocab', v_run.vocab, 'fileName', v_run.file_name,
      'calibrationId', p_calibration_id),
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

create or replace function public.save_calibration_version_v1(
  p_calibration_id uuid,
  p_expected_version bigint,
  p_name text,
  p_rules jsonb,
  p_learned_from jsonb,
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
  if length(p_name) not between 1 and 120 or jsonb_typeof(p_rules) <> 'object'
     or jsonb_typeof(p_learned_from) <> 'array' or jsonb_array_length(p_learned_from) > 1000 then
    raise exception 'invalid calibration payload';
  end if;
  select * into v_calibration from public.calibrations
  where id = p_calibration_id for update;
  if found then
    if v_calibration.archived_at is not null then
      raise sqlstate 'PT409' using message = 'PROFILE_ARCHIVED';
    end if;
    if v_calibration.version <> p_expected_version then
      raise sqlstate 'PT409' using message = 'PROFILE_VERSION_CONFLICT';
    end if;
    v_new_version := v_calibration.version + 1;
    update public.calibrations
    set name = p_name, rules = p_rules, learned_from = p_learned_from,
        version = v_new_version, updated_at = now()
    where id = p_calibration_id;
  else
    if p_expected_version <> 0 then
      raise sqlstate 'PT409' using message = 'PROFILE_VERSION_CONFLICT';
    end if;
    v_new_version := 1;
    insert into public.calibrations (
      id, name, rules, learned_from, version, created_at, updated_at
    ) values (p_calibration_id, p_name, p_rules, p_learned_from, 1, now(), now());
  end if;
  insert into public.calibration_versions (
    calibration_id, version, name, rules, learned_from, metrics, created_by
  ) values (
    p_calibration_id, v_new_version, p_name, p_rules, p_learned_from,
    jsonb_build_object('kind', 'manual'), p_actor_label
  );
  return jsonb_build_object('id', p_calibration_id, 'version', v_new_version);
end;
$$;

create or replace function public.archive_calibration_v1(
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
  where id = p_calibration_id for update;
  if not found then return jsonb_build_object('ok', true, 'missing', true); end if;
  if v_calibration.archived_at is not null then
    return jsonb_build_object('ok', true, 'version', v_calibration.version);
  end if;
  if v_calibration.version <> p_expected_version then
    raise sqlstate 'PT409' using message = 'PROFILE_VERSION_CONFLICT';
  end if;
  v_new_version := v_calibration.version + 1;
  update public.calibrations
  set archived_at = now(), version = v_new_version, updated_at = now()
  where id = p_calibration_id;
  insert into public.calibration_versions (
    calibration_id, version, name, rules, learned_from, metrics, created_by
  ) values (
    p_calibration_id, v_new_version, v_calibration.name, v_calibration.rules,
    v_calibration.learned_from, jsonb_build_object('archived', true), p_actor_label
  );
  return jsonb_build_object('ok', true, 'version', v_new_version);
end;
$$;

revoke all privileges on function public.record_answer_comparison_v1(
  uuid, uuid, bigint, bigint, text, text, text, text, jsonb, text, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.record_answer_comparison_v1(
  uuid, uuid, bigint, bigint, text, text, text, text, jsonb, text, uuid
) to service_role;

revoke all privileges on function public.apply_answer_calibration_v1(
  uuid, uuid, uuid, text, bigint, bigint, uuid, text, jsonb, jsonb,
  jsonb, jsonb, text, jsonb, jsonb, jsonb, text, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.apply_answer_calibration_v1(
  uuid, uuid, uuid, text, bigint, bigint, uuid, text, jsonb, jsonb,
  jsonb, jsonb, text, jsonb, jsonb, jsonb, text, uuid
) to service_role;

revoke all privileges on function public.save_calibration_version_v1(
  uuid, bigint, text, jsonb, jsonb, text
) from public, anon, authenticated, service_role;
grant execute on function public.save_calibration_version_v1(
  uuid, bigint, text, jsonb, jsonb, text
) to service_role;

revoke all privileges on function public.archive_calibration_v1(
  uuid, bigint, text
) from public, anon, authenticated, service_role;
grant execute on function public.archive_calibration_v1(
  uuid, bigint, text
) to service_role;
