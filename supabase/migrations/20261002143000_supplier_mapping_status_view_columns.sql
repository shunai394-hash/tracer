drop view if exists public.supplier_product_mapping_status;

create view public.supplier_product_mapping_status as
select
  spm.id,
  spm.shop_listing_id,
  sl.title as shop_title,
  sl.base_item_id,
  spm.supplier_listing_id,
  spm.supplier_account_id,
  sa.code as supplier_code,
  sa.display_name as supplier_name,
  sil.title as supplier_title,
  sil.external_id as supplier_external_id,
  sil.sku as supplier_sku,
  sil.supplier_product_id,
  sil.supplier_variant_id,
  sil.cost,
  sil.shipping_cost,
  sil.inventory,
  sil.orderable,
  sil.price_confirmed,
  sil.inventory_confirmed,
  sil.tracking_available,
  sil.verification_status,
  sil.shipping_status,
  spm.priority,
  spm.active,
  spm.auto_order_enabled,
  spm.auto_payment_enabled,
  spm.auto_tracking_enabled,
  spm.automation_status,
  spm.verification_status as mapping_verification_status,
  spm.created_at,
  spm.updated_at,
  (
    spm.active
    and sil.configured
    and coalesce(sil.orderable,false)
    and coalesce(sil.price_confirmed,false)
    and coalesce(sil.inventory_confirmed,false)
    and coalesce(sil.tracking_available,false)
    and sa.order_automation_status = 'automatable'
    and sa.payment_automation_status = 'automatable'
    and sa.shipping_tracking_status = 'automatable'
    and spm.auto_order_enabled
    and spm.auto_payment_enabled
    and spm.auto_tracking_enabled
    and spm.automation_status = 'eligible'
    and spm.verification_status = 'verified'
  ) as fully_automatable
from public.supplier_product_mappings spm
join public.shop_listings sl on sl.id = spm.shop_listing_id
join public.supplier_listings sil on sil.id = spm.supplier_listing_id
join public.supplier_accounts sa on sa.id = spm.supplier_account_id;

revoke all on table public.supplier_product_mapping_status from anon, authenticated;
grant select on table public.supplier_product_mapping_status to service_role;