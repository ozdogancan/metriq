-- Contract phase, applied only after the tenant-aware application is promoted.
-- New writes now fail closed if any ownership/scope field is omitted.

alter table public.runs alter column tenant_key drop default;
alter table public.runs alter column created_by_key drop default;
alter table public.mto_rows alter column tenant_key drop default;
alter table public.steel_rows alter column tenant_key drop default;
alter table public.calibrations alter column tenant_key drop default;
alter table public.calibrations alter column model_family drop default;
alter table public.calibrations alter column client_key drop default;
alter table public.calibrations alter column status drop default;
alter table public.notifications alter column tenant_key drop default;
alter table public.notifications alter column user_key drop default;
alter table public.learning_events alter column tenant_key drop default;
alter table public.learning_events alter column actor_user_key drop default;
alter table public.push_subscriptions alter column tenant_key drop default;
alter table public.push_subscriptions alter column user_key drop default;
alter table public.storage_cleanup alter column tenant_key drop default;
alter table public.storage_cleanup alter column user_key drop default;
alter table public.answer_comparisons alter column tenant_key drop default;
alter table public.answer_comparisons alter column created_by_key drop default;
alter table public.calibration_versions alter column tenant_key drop default;
alter table public.calibration_versions alter column created_by_key drop default;
alter table public.calibration_commits alter column tenant_key drop default;
alter table public.calibration_commits alter column created_by_key drop default;

revoke all privileges on function public.replace_mto_rows(uuid, jsonb)
  from public, anon, authenticated, service_role;
revoke all privileges on function public.replace_steel_rows(uuid, jsonb)
  from public, anon, authenticated, service_role;
revoke all privileges on function public.delete_run_and_queue_storage(uuid, text)
  from public, anon, authenticated, service_role;
revoke all privileges on function public.record_answer_comparison_v1(
  uuid, uuid, bigint, bigint, text, text, text, text, jsonb, text, uuid
) from public, anon, authenticated, service_role;
revoke all privileges on function public.apply_answer_calibration_v1(
  uuid, uuid, uuid, text, bigint, bigint, uuid, text, jsonb, jsonb,
  jsonb, jsonb, text, jsonb, jsonb, jsonb, text, uuid
) from public, anon, authenticated, service_role;
revoke all privileges on function public.save_calibration_version_v1(
  uuid, bigint, text, jsonb, jsonb, text
) from public, anon, authenticated, service_role;
revoke all privileges on function public.archive_calibration_v1(uuid, bigint, text)
  from public, anon, authenticated, service_role;
