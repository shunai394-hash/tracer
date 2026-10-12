-- Require an observation timestamp for supplier prices used by Shopify publication.
-- Existing rows remain NULL and therefore fail closed until live price refresh succeeds.
ALTER TABLE public.supplier_listings
  ADD COLUMN IF NOT EXISTS price_checked_at timestamptz;
