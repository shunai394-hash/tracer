-- Persist CJ verification state so scheduled runs do not re-hit the same supplier APIs.
ALTER TABLE public.supplier_listings
  ADD COLUMN IF NOT EXISTS verification_status text NOT NULL DEFAULT 'unverified',
  ADD COLUMN IF NOT EXISTS shipping_status text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS shipping_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS inventory_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS next_verification_at timestamptz,
  ADD COLUMN IF NOT EXISTS verification_error text,
  ADD COLUMN IF NOT EXISTS verification_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_verified_at timestamptz;

ALTER TABLE public.supplier_listings
  DROP CONSTRAINT IF EXISTS supplier_listings_verification_status_check;
ALTER TABLE public.supplier_listings
  ADD CONSTRAINT supplier_listings_verification_status_check
  CHECK (verification_status IN ('unverified','verified','unavailable','retryable'));

ALTER TABLE public.supplier_listings
  DROP CONSTRAINT IF EXISTS supplier_listings_shipping_status_check;
ALTER TABLE public.supplier_listings
  ADD CONSTRAINT supplier_listings_shipping_status_check
  CHECK (shipping_status IN ('unknown','verified','unavailable','retryable'));

CREATE INDEX IF NOT EXISTS supplier_listings_cj_verification_due_idx
  ON public.supplier_listings (supplier, verification_status, next_verification_at)
  WHERE supplier = 'cj';

UPDATE public.supplier_listings
SET verification_status = CASE
      WHEN orderable = true AND price_confirmed = true AND inventory_confirmed = true
        AND shipping_cost IS NOT NULL AND shipping_cost > 0
      THEN 'verified'
      ELSE 'unverified'
    END,
    shipping_status = CASE
      WHEN shipping_cost IS NOT NULL AND shipping_cost > 0 THEN 'verified'
      ELSE 'unknown'
    END
WHERE supplier = 'cj';
