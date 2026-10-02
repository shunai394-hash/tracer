create or replace view public.supplier_product_mapping_status as
select
  spm.id,
  spm.shop_listing_id,
  sl.title as shop_title,
  sl.base_item_id,
  spm.supplier_listing_id,
  spm.supplier_account_id,
  sa.code as supplier_code,
  sa.display_name as supplier_name,
  supplier.title as supplier_title,
  supplier.external_id as supplier_external_id,
  supplier.sku as supplier_sku,
  supplier.supplier_product_id,
  supplier.supplier_variant_id,
  supplier.cost,
  supplier.shipping_cost,
  supplier.inventory,
  supplier.orderable,
  supplier.price_confirmed,
  supplier.inventory_confirmed,
  supplier.tracking_available,
  supplier.verification_status,
  supplier.shipping_status,
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
    and supplier.configured
    and supplier.orderable
    and supplier.price_confirmed
    and supplier.inventory_confirmed
    and supplier.tracking_available
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
join public.supplier_accounts sa on sa.id = spm.supplier_account_id
join public.supplier_listings supplier on supplier.id = spm.supplier_listing_id;
