-- Prevent repeated market-sourcing runs from multiplying the same observation.
-- Preserve historical duplicate rows; only the newest row for each stable
-- source item receives the canonical key. Older duplicates are retained with
-- a deterministic legacy suffix so evidence/history is not deleted.
alter table public.marketplace_bestsellers
  add column if not exists source_item_key text;

with ranked as (
  select
    id,
    source,
    asin,
    product_url,
    marketplace,
    title,
    rank,
    row_number() over (
      partition by source,
      coalesce(
        nullif(asin, ''),
        nullif(product_url, ''),
        concat(
          coalesce(marketplace, ''),
          '::',
          coalesce(title, ''),
          '::rank:',
          coalesce(rank::text, '')
        )
      )
      order by fetched_at desc, created_at desc, id desc
    ) as rn
  from public.marketplace_bestsellers
)
update public.marketplace_bestsellers m
set source_item_key = concat(
  r.source,
  '::',
  coalesce(
    nullif(r.asin, ''),
    nullif(r.product_url, ''),
    concat(
      coalesce(r.marketplace, ''),
      '::',
      coalesce(r.title, ''),
      '::rank:',
      coalesce(r.rank::text, '')
    )
  ),
  case when r.rn = 1 then '' else concat('::legacy:', r.id::text) end
)
from ranked r
where m.id = r.id;

alter table public.marketplace_bestsellers
  alter column source_item_key set not null;

create unique index if not exists marketplace_bestsellers_source_item_key_uidx
  on public.marketplace_bestsellers(source_item_key);
