-- The ingestion code upserts canonical variant evidence on
-- (bestseller_id, source_variant_id). Without a matching unique index,
-- PostgREST rejects every such write with ON CONFLICT target errors.
-- This table is evidence storage only; it does not approve supplier links.
create unique index if not exists marketplace_bestseller_variants_bestseller_source_variant_uidx
  on public.marketplace_bestseller_variants (bestseller_id, source_variant_id);
