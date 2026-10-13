-- Read-only PRE-MERGE preflight for PR #502.
-- Run against production BEFORE any migration/deploy. This checks migration
-- prerequisites only; it deliberately does not require objects that the PR
-- migrations are expected to create. It performs no writes.
-- Do NOT apply 20261013120000_remove_amazon_rakuten_market_data.sql.

with checks as (
  select 1 ord, 'supplier_order_attempts_table_exists' check_name,
    to_regclass('public.supplier_order_attempts') is not null ok,
    coalesce(to_regclass('public.supplier_order_attempts')::text, 'missing') detail
  union all
  select 2, 'supplier_order_attempts_required_columns',
    exists (select 1 from information_schema.columns where table_schema='public' and table_name='supplier_order_attempts' and column_name='idempotency_key')
    and exists (select 1 from information_schema.columns where table_schema='public' and table_name='supplier_order_attempts' and column_name='purchase_order_id'),
    'requires idempotency_key and purchase_order_id'
  union all
  select 3, 'no_duplicate_idempotency_keys',
    not exists (select 1 from public.supplier_order_attempts group by idempotency_key having count(*) > 1),
    (select count(*)::text || ' duplicate groups' from (select 1 from public.supplier_order_attempts group by idempotency_key having count(*) > 1) d)
  union all
  select 4, 'no_duplicate_purchase_order_ids',
    not exists (select 1 from public.supplier_order_attempts group by purchase_order_id having count(*) > 1),
    (select count(*)::text || ' duplicate groups' from (select 1 from public.supplier_order_attempts group by purchase_order_id having count(*) > 1) d)
  union all
  select 5, 'marketplace_bestseller_variants_table_exists',
    to_regclass('public.marketplace_bestseller_variants') is not null,
    coalesce(to_regclass('public.marketplace_bestseller_variants')::text, 'missing')
  union all
  select 6, 'evidence_source_constraint_exists',
    exists (select 1 from pg_constraint c join pg_class t on t.oid=c.conrelid join pg_namespace n on n.oid=t.relnamespace
      where n.nspname='public' and t.relname='marketplace_bestseller_variants' and c.conname='marketplace_bestseller_variants_evidence_source_check'),
    'existing constraint must be present before replacement migration'
  union all
  select 7, 'shop_listings_table_exists',
    to_regclass('public.shop_listings') is not null,
    coalesce(to_regclass('public.shop_listings')::text, 'missing')
)
select check_name, ok, detail from checks order by ord;
