-- Keep the exact canonical child-variant evidence row on each supplier link.
-- The parent bestseller ID alone is insufficient to prove size/color/pack identity.
alter table public.internal_supply_links
  add column if not exists marketplace_variant_evidence_id uuid
  references public.marketplace_bestseller_variants(id) on delete set null;

create index if not exists internal_supply_links_marketplace_variant_evidence_idx
  on public.internal_supply_links(marketplace_variant_evidence_id)
  where marketplace_variant_evidence_id is not null;
