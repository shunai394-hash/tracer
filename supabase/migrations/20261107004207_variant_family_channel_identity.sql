-- Variant family channel identity migration

create table if not exists public.channel_listing_identity_backup (
  id bigint generated always as identity primary key,
  listing_id uuid not null,
  channel text not null,
  variant_id uuid not null,
  external_product_id text,
  external_variant_id text,
  external_sku text,
  status text,
  selling_price integer,
  reason text not null,
  created_at timestamptz not null default now()
);

-- Preserve every existing channel identity before relaxing the parent-product uniqueness rule.
-- The listing_id guard makes this copy safe to rerun if a migration is manually retried.
insert into public.channel_listing_identity_backup (
  listing_id, channel, variant_id, external_product_id, external_variant_id,
  external_sku, status, selling_price, reason
)
select
  cl.id, cl.channel, cl.variant_id, cl.external_product_id, cl.external_variant_id,
  cl.external_sku, cl.status, cl.selling_price, 'pre_variant_family_migration'
from public.channel_listings cl
where not exists (
  select 1
  from public.channel_listing_identity_backup b
  where b.listing_id = cl.id
);

alter table public.channel_listing_identity_backup enable row level security;
grant all privileges on table public.channel_listing_identity_backup to service_role;

do $$
declare
  sequence_name text;
begin
  sequence_name := pg_get_serial_sequence('public.channel_listing_identity_backup', 'id');
  if sequence_name is not null then
    execute format('grant usage, select on sequence %s to service_role', sequence_name);
  end if;
end $$;

alter table public.channel_listings
  drop constraint if exists channel_listings_channel_external_product_id_key;

create unique index if not exists channel_listings_channel_external_variant_uidx
  on public.channel_listings (channel, external_variant_id)
  where external_variant_id is not null;

alter table public.commerce_order_lines
  add column if not exists selection jsonb not null default '{}'::jsonb;

comment on column public.commerce_order_lines.selection is
  'Customer-selected color, size, and channel variant id. Procurement still orders the supplier variant linked on the line.';
