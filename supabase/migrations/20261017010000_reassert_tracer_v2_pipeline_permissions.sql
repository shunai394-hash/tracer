-- Reassert the least-privilege grants for environments where the ledger
-- table existed before the original migration/grants were applied.
-- The application reads the append-only ledger and writes only through the
-- SECURITY DEFINER RPC; do not grant direct INSERT/UPDATE/DELETE access.
grant usage on schema public to service_role;
grant select on table public.tracer_v2_pipeline_events to service_role;
revoke insert, update, delete on table public.tracer_v2_pipeline_events from service_role;
revoke all on function public.record_tracer_v2_pipeline_event(text,text,text,text,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.record_tracer_v2_pipeline_event(text,text,text,text,text,text,jsonb) to service_role;
