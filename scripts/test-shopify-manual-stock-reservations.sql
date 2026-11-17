-- PostgreSQL integration tests for Shopify manual-stock reservations.
\set ON_ERROR_STOP on

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
END
$$;

CREATE TABLE public.shop_orders (id uuid PRIMARY KEY, shopify_order_id text NOT NULL);
CREATE TABLE public.shop_order_items (id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES public.shop_orders(id), listing_id uuid NOT NULL, shopify_line_item_id text NOT NULL);

CREATE TABLE public.shop_listings (
  id uuid PRIMARY KEY,
  manual_inventory boolean NOT NULL DEFAULT false,
  published boolean NOT NULL DEFAULT false,
  inventory integer NOT NULL DEFAULT 0,
  archived_at timestamptz,
  updated_at timestamptz DEFAULT now()
);

\ir ../supabase/migrations/20261117093000_shopify_manual_stock_idempotent_reservations.sql
\ir ../supabase/migrations/20261118010000_shopify_manual_fulfillment_work_items.sql

INSERT INTO public.shop_listings (id, manual_inventory, published, inventory)
VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true, true, 5),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', true, true, 1),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', false, true, 10);

DO $$
DECLARE
  result jsonb;
  stock integer;
BEGIN
  -- First delivery reserves exactly two units.
  SELECT public.reserve_shopify_manual_stock(
    'order-100', 'line-100', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 2
  ) INTO result;
  IF result->>'duplicate' <> 'false' OR result->>'status' <> 'reserved' THEN
    RAISE EXCEPTION 'first reservation should be new: %', result;
  END IF;
  SELECT inventory INTO stock FROM public.shop_listings WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  IF stock <> 3 THEN RAISE EXCEPTION 'expected stock 3 after reserve, got %', stock; END IF;

  -- A retry of the same Shopify line item must not decrement again.
  SELECT public.reserve_shopify_manual_stock(
    'order-100', 'line-100', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 2
  ) INTO result;
  IF result->>'duplicate' <> 'true' THEN RAISE EXCEPTION 'retry should be duplicate: %', result; END IF;
  SELECT inventory INTO stock FROM public.shop_listings WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  IF stock <> 3 THEN RAISE EXCEPTION 'retry changed stock: %', stock; END IF;

  -- A reused line ID with changed identity must fail closed.
  BEGIN
    PERFORM public.reserve_shopify_manual_stock(
      'order-else', 'line-100', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 2
    );
    RAISE EXCEPTION 'identity conflict unexpectedly succeeded';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'manual_stock_reservation_identity_conflict' THEN RAISE; END IF;
  END;

  -- Insufficient stock must roll back the reservation row and inventory.
  BEGIN
    PERFORM public.reserve_shopify_manual_stock(
      'order-101', 'line-101', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 2
    );
    RAISE EXCEPTION 'insufficient stock unexpectedly succeeded';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'manual_stock_unavailable' THEN RAISE; END IF;
  END;
  IF EXISTS (SELECT 1 FROM public.shopify_manual_stock_reservations WHERE shopify_line_item_id = 'line-101') THEN
    RAISE EXCEPTION 'failed reservation row was not rolled back';
  END IF;
  SELECT inventory INTO stock FROM public.shop_listings WHERE id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  IF stock <> 1 THEN RAISE EXCEPTION 'insufficient-stock attempt changed stock: %', stock; END IF;

  -- Release restores once; repeated release is a no-op.
  SELECT public.release_shopify_manual_stock('line-100', 'integration_test') INTO result;
  IF result->>'duplicate' <> 'false' OR result->>'status' <> 'released' THEN
    RAISE EXCEPTION 'first release should restore stock: %', result;
  END IF;
  SELECT public.release_shopify_manual_stock('line-100', 'duplicate_test') INTO result;
  IF result->>'duplicate' <> 'true' THEN RAISE EXCEPTION 'second release should be duplicate: %', result; END IF;
  SELECT inventory INTO stock FROM public.shop_listings WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  IF stock <> 5 THEN RAISE EXCEPTION 'release should restore stock to 5, got %', stock; END IF;

  -- A listing archived after reservation still represents physical stock to restore.
  SELECT public.reserve_shopify_manual_stock(
    'order-102', 'line-102', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1
  ) INTO result;
  UPDATE public.shop_listings SET archived_at = now(), published = false
  WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  SELECT public.release_shopify_manual_stock('line-102', 'archived_test') INTO result;
  IF result->>'status' <> 'released' THEN RAISE EXCEPTION 'archived listing release failed: %', result; END IF;
  SELECT inventory INTO stock FROM public.shop_listings WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  IF stock <> 5 THEN RAISE EXCEPTION 'archived listing stock should restore to 5, got %', stock; END IF;

  -- A paid manual-stock line can be represented in the dedicated fulfillment queue.
  INSERT INTO public.shop_orders (id, shopify_order_id)
  VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'order-104');
  INSERT INTO public.shop_order_items (id, order_id, listing_id, shopify_line_item_id)
  VALUES ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'line-104');
  SELECT public.reserve_shopify_manual_stock(
    'order-104', 'line-104', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 1
  ) INTO result;
  INSERT INTO public.shopify_manual_fulfillment_work_items (
    reservation_id, shop_order_id, shop_order_item_id, listing_id,
    shopify_order_id, shopify_line_item_id, quantity
  )
  SELECT r.id, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', r.listing_id,
    r.shopify_order_id, r.shopify_line_item_id, r.quantity
  FROM public.shopify_manual_stock_reservations r
  WHERE r.shopify_line_item_id = 'line-104';
  IF NOT EXISTS (
    SELECT 1 FROM public.shopify_manual_fulfillment_work_items
    WHERE shopify_line_item_id = 'line-104' AND status = 'queued' AND quantity = 1
  ) THEN RAISE EXCEPTION 'manual fulfillment work item was not queued'; END IF;
  UPDATE public.shopify_manual_fulfillment_work_items
  SET status = 'shipped', carrier = 'test-carrier', tracking_number = 'TEST-123', shipped_at = now()
  WHERE shopify_line_item_id = 'line-104';
  IF NOT EXISTS (
    SELECT 1 FROM public.shopify_manual_fulfillment_work_items
    WHERE shopify_line_item_id = 'line-104' AND status = 'shipped' AND tracking_number = 'TEST-123'
  ) THEN RAISE EXCEPTION 'manual fulfillment tracking update failed'; END IF;
  BEGIN
    INSERT INTO public.shopify_manual_fulfillment_work_items (
      reservation_id, shop_order_id, shop_order_item_id, listing_id,
      shopify_order_id, shopify_line_item_id, quantity
    )
    SELECT r.id, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', r.listing_id,
      r.shopify_order_id, r.shopify_line_item_id, r.quantity
    FROM public.shopify_manual_stock_reservations r
    WHERE r.shopify_line_item_id = 'line-104';
    RAISE EXCEPTION 'duplicate fulfillment work item unexpectedly inserted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- Supplier-owned listings must not be reservable by this RPC.
  BEGIN
    PERFORM public.reserve_shopify_manual_stock(
      'order-103', 'line-103', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 1
    );
    RAISE EXCEPTION 'non-manual listing unexpectedly reserved';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'manual_stock_unavailable' THEN RAISE; END IF;
  END;
END
$$;

SELECT 'Shopify manual stock reservation and fulfillment queue SQL integration tests passed' AS result;
