-- Read-only POST-MIGRATION schema verification for PR #502.
-- Verifies each PR #502 migration by the structure it creates, not by its
-- version name, because an equivalent object may exist under another version.
-- Contains only SELECT statements: it creates, alters and deletes nothing.
-- For pre-merge checks of existing prerequisites, use scripts/verify-pr502-premerge.sql.
-- 20261013120000_remove_amazon_rakuten_market_data.sql is intentionally not
-- checked here and must not be applied as part of this rollout.
-- Run after the approved non-destructive migrations are applied; every row should report ok = true before enabling the new production paths.

with
expected_shop_listing_columns(column_name) as (
  values
    ('supplier_listing_id'), ('supplier_product_id'), ('supplier_variant_id'),
    ('identity_method'), ('identity_confidence'), ('source_cost'), ('shipping_cost'),
    ('contribution_profit'), ('contribution_margin'), ('base_item_id'),
    ('base_publication_status'), ('base_publication_lease_until'), ('base_last_error'),
    ('shopify_product_id'), ('shopify_variant_id'), ('shopify_handle'),
    ('shopify_sync_status'), ('shopify_sync_error'), ('orderable'), ('tracking_available')
),
retry_queue_columns(column_name) as (
  values
    ('bestseller_id'), ('supplier_listing_id'), ('supply_variant_id'), ('reason'),
    ('link_status'), ('retry_count'), ('last_attempt_at'), ('next_attempt_at'),
    ('last_error'), ('created_at'), ('updated_at')
),
unique_index_defs as (
  select indexdef
  from pg_indexes
  where schemaname = 'public'
    and tablename = 'supplier_order_attempts'
    and indexdef ilike 'create unique index%'
),
evidence_check as (
  select pg_get_constraintdef(c.oid) as def
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  join pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'public'
    and t.relname = 'marketplace_bestseller_variants'
    and c.conname = 'marketplace_bestseller_variants_evidence_source_check'
)
select * from (
  -- 20261010190000_internal_supply_link_retry_queue.sql
  select 1 as ord, 'retry_queue_table_exists' as check_name,
    to_regclass('public.internal_supply_link_retry_queue') is not null as ok,
    coalesce(to_regclass('public.internal_supply_link_retry_queue')::text, 'missing') as detail
  union all
  select 2, 'retry_queue_columns',
    not exists (
      select 1 from retry_queue_columns e
      where not exists (
        select 1 from information_schema.columns c
        where c.table_schema = 'public' and c.table_name = 'internal_supply_link_retry_queue' and c.column_name = e.column_name
      )
    ),
    coalesce((
      select 'missing: ' || string_agg(e.column_name, ', ')
      from retry_queue_columns e
      where not exists (
        select 1 from information_schema.columns c
        where c.table_schema = 'public' and c.table_name = 'internal_supply_link_retry_queue' and c.column_name = e.column_name
      )
    ), 'all present')
  union all
  select 3, 'retry_queue_due_index',
    exists (
      select 1 from pg_indexes
      where schemaname = 'public' and tablename = 'internal_supply_link_retry_queue' and indexdef ilike '%(next_attempt_at%'
    ),
    coalesce((
      select string_agg(indexname, ', ') from pg_indexes
      where schemaname = 'public' and tablename = 'internal_supply_link_retry_queue'
    ), 'no indexes')
  union all
  select 4, 'retry_queue_rls_enabled',
    coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.internal_supply_link_retry_queue')), false),
    'row level security flag'

  -- 20261011123000 / 20261013040000 canonical variant evidence constraint
  union all
  select 5, 'evidence_source_check_allows_all_explicit_sources',
    exists (
      select 1 from evidence_check
      where def like '%schema_org_product_group_has_variant%'
        and def like '%schema_org_product_is_variant_of%'
        and def like '%amazon_variation_asin_map%'
    ),
    coalesce((select def from evidence_check), 'constraint missing')

  -- 20261012193000_supplier_order_attempt_duplicate_guard.sql
  union all
  select 6, 'supplier_order_attempts_unique_idempotency_key',
    exists (select 1 from unique_index_defs where indexdef ilike '%(idempotency_key)%'),
    coalesce((select string_agg(indexdef, ' | ') from unique_index_defs), 'no unique indexes')
  union all
  select 7, 'supplier_order_attempts_unique_purchase_order',
    exists (select 1 from unique_index_defs where indexdef ilike '%(purchase_order_id)%'),
    coalesce((select string_agg(indexdef, ' | ') from unique_index_defs), 'no unique indexes')
  union all
  select 8, 'supplier_order_attempts_no_duplicate_idempotency_keys',
    not exists (
      select 1 from public.supplier_order_attempts group by idempotency_key having count(*) > 1
    ),
    (select count(*)::text || ' duplicate key groups' from (
      select 1 from public.supplier_order_attempts group by idempotency_key having count(*) > 1
    ) g)
  union all
  select 9, 'supplier_order_attempts_no_duplicate_purchase_orders',
    not exists (
      select 1 from public.supplier_order_attempts group by purchase_order_id having count(*) > 1
    ),
    (select count(*)::text || ' duplicate purchase-order groups' from (
      select 1 from public.supplier_order_attempts group by purchase_order_id having count(*) > 1
    ) g)

  -- Columns the merged channel code reads from shop_listings.
  union all
  select 10, 'shop_listings_columns',
    not exists (
      select 1 from expected_shop_listing_columns e
      where not exists (
        select 1 from information_schema.columns c
        where c.table_schema = 'public' and c.table_name = 'shop_listings' and c.column_name = e.column_name
      )
    ),
    coalesce((
      select 'missing: ' || string_agg(e.column_name, ', ')
      from expected_shop_listing_columns e
      where not exists (
        select 1 from information_schema.columns c
        where c.table_schema = 'public' and c.table_name = 'shop_listings' and c.column_name = e.column_name
      )
    ), 'all present')

  -- Recorded versions, for reference only (structure above is authoritative).
  union all
  select 11, 'recorded_migration_versions_since_20261010',
    true,
    coalesce((
      select string_agg(version, ', ' order by version)
      from supabase_migrations.schema_migrations
      where version >= '20261010'
    ), 'none')
) checks
order by ord;
