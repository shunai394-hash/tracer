-- Prevent repeated market-sourcing runs from multiplying the same observation.
-- Keep the latest row for each stable source item, then enforce uniqueness.
alter table public.marketplace_bestsellers
  add column if not exists source_item_key text;

update public.marketplace_bestsellers
set source_item_key = concat(
  source,
  '::',
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
)
where source_item_key is null;

alter table public.marketplace_bestsellers
  alter column source_item_key set not null;

with ranked as (
  select
    id,
    row_number() over (
      partition by source_item_key
      order by fetched_at desc, created_at desc, id desc
    ) as rn
  from public.marketplace_bestsellers
  where source_item_key is not null
)
delete from public.marketplace_bestsellers m
using ranked r
where m.id = r.id
  and r.rn > 1;

create unique index if not exists marketplace_bestsellers_source_item_key_uidx
  on public.marketplace_bestsellers(source_item_key);
