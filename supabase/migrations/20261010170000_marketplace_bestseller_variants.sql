-- Persist canonical marketplace variants as independent identity evidence.
-- Parent marketplace_bestsellers identifiers are never copied onto child rows.
create table if not exists public.marketplace_bestseller_variants (
  id uuid primary key default gen_random_uuid(),
  bestseller_id uuid not null references public.marketplace_bestsellers(id) on delete cascade,
  marketplace text not null,
  source text not null,
  source_variant_id text not null,
  sku text,
  title text,
  asin text,
  jan text,
  gtin text,
  ean text,
  upc text,
  mpn text,
  product_url text,
  evidence_source text not null,
  raw_evidence jsonb not null default '{}'::jsonb,
  fetched_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint marketplace_bestseller_variants_evidence_source_check
    check (evidence_source = 'schema_org_product_group_has_variant')
);

create unique index if not exists marketplace_bestseller_variants_parent_source_variant_uq
  on public.marketplace_bestseller_variants(bestseller_id, source_variant_id);

create index if not exists marketplace_bestseller_variants_jan_idx
  on public.marketplace_bestseller_variants(jan) where jan is not null;
create index if not exists marketplace_bestseller_variants_gtin_idx
  on public.marketplace_bestseller_variants(gtin) where gtin is not null;
create index if not exists marketplace_bestseller_variants_ean_idx
  on public.marketplace_bestseller_variants(ean) where ean is not null;
create index if not exists marketplace_bestseller_variants_upc_idx
  on public.marketplace_bestseller_variants(upc) where upc is not null;
create index if not exists marketplace_bestseller_variants_asin_idx
  on public.marketplace_bestseller_variants(asin) where asin is not null;

alter table public.marketplace_bestseller_variants enable row level security;
revoke all on table public.marketplace_bestseller_variants from anon, authenticated;
grant all on table public.marketplace_bestseller_variants to service_role;
