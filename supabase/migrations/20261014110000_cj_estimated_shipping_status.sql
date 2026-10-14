-- Estimated freight is a priced reserve, not a verified supplier quote.
-- Keep the distinction explicit while allowing profitable candidates to proceed.
ALTER TABLE public.supplier_listings
  DROP CONSTRAINT IF EXISTS supplier_listings_shipping_status_check;

ALTER TABLE public.supplier_listings
  ADD CONSTRAINT supplier_listings_shipping_status_check
  CHECK (shipping_status IN ('unknown', 'verified', 'unavailable', 'retryable', 'estimated'));
