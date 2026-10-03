-- Additive: allow a delivery to record that NEWFIND withdrew the promotion
-- after TRACER unpublished the listing. Existing rows are unchanged.
alter table public.newfind_promotion_deliveries
  drop constraint if exists newfind_promotion_deliveries_status_check;

alter table public.newfind_promotion_deliveries
  add constraint newfind_promotion_deliveries_status_check
  check (status in ('pending','sending','sent','processed','failed','withdrawn'));
