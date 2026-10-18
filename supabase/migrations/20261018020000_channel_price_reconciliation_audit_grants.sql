-- Production insert failed with SQLSTATE 42501:
-- permission denied for table channel_price_reconciliation_audit.
-- The table existed, but row level security without a policy rejects the
-- service role when bypass is not applied, and a missing grant does the same.
alter table public.channel_price_reconciliation_audit disable row level security;

grant all privileges on table public.channel_price_reconciliation_audit to service_role;

do $$
declare
  seq name;
begin
  seq := pg_get_serial_sequence('public.channel_price_reconciliation_audit', 'id');
  if seq is not null then
    execute format('grant usage, select on sequence %s to service_role', seq);
  end if;
end $$;

notify pgrst, 'reload schema';
