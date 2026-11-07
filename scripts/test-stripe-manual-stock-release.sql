-- Integration test for the Stripe manual-inventory release migration.
\set ON_ERROR_STOP on

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
END
$$;

CREATE TABLE public.shop_orders (
  id uuid PRIMARY KEY,
  payment_status text NOT NULL,
  order_status text NOT NULL,
  manual_inventory_released_at timestamptz,
  cancelled_at timestamptz
);
CREATE TABLE public.shop_listings (
  id uuid PRIMARY KEY,
  manual_inventory boolean NOT NULL DEFAULT false,
  inventory integer NOT NULL DEFAULT 0,
  archived_at timestamptz,
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.shop_order_items (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES public.shop_orders(id),
  listing_id uuid NOT NULL REFERENCES public.shop_listings(id),
  qty integer NOT NULL CHECK (qty > 0)
);

\ir ../supabase/migrations/20261107005739_release_manual_inventory_once.sql

INSERT INTO public.shop_listings (id, manual_inventory, inventory, archived_at)
VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true, 4, now()),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', false, 8, NULL);

INSERT INTO public.shop_orders (id, payment_status, order_status)
VALUES
  ('11111111-1111-4111-8111-111111111111', 'pending', 'pending_payment'),
  ('22222222-2222-4222-8222-222222222222', 'paid', 'paid'),
  ('33333333-3333-4333-8333-333333333333', 'failed', 'order_failed'),
  ('44444444-4444-4444-8444-444444444444', 'pending', 'pending_payment');

INSERT INTO public.shop_order_items (order_id, listing_id, qty)
VALUES
  ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 2),
  ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 3),
  ('22222222-2222-4222-8222-222222222222', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 4),
  ('33333333-3333-4333-8333-333333333333', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1),
  ('44444444-4444-4444-8444-444444444444', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 2);

DO $$
DECLARE
  released boolean;
  stock integer;
BEGIN
  SELECT public.release_manual_inventory_for_order('11111111-1111-4111-8111-111111111111') INTO released;
  IF released IS DISTINCT FROM true THEN RAISE EXCEPTION 'pending order should release'; END IF;
  SELECT inventory INTO stock FROM public.shop_listings WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  IF stock <> 9 THEN RAISE EXCEPTION 'expected grouped quantity 5 to restore stock from 4 to 9, got %', stock; END IF;

  SELECT public.release_manual_inventory_for_order('11111111-1111-4111-8111-111111111111') INTO released;
  IF released IS DISTINCT FROM false THEN RAISE EXCEPTION 'duplicate release must be rejected'; END IF;
  SELECT inventory INTO stock FROM public.shop_listings WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  IF stock <> 9 THEN RAISE EXCEPTION 'duplicate release changed stock to %', stock; END IF;

  SELECT public.release_manual_inventory_for_order('22222222-2222-4222-8222-222222222222') INTO released;
  IF released IS DISTINCT FROM false THEN RAISE EXCEPTION 'paid order must not release'; END IF;

  SELECT public.release_manual_inventory_for_order('33333333-3333-4333-8333-333333333333') INTO released;
  IF released IS DISTINCT FROM true THEN RAISE EXCEPTION 'terminal failed order should release'; END IF;
  SELECT inventory INTO stock FROM public.shop_listings WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  IF stock <> 10 THEN RAISE EXCEPTION 'failed order should restore one unit, got %', stock; END IF;

  SELECT public.release_manual_inventory_for_order('44444444-4444-4444-8444-444444444444') INTO released;
  IF released IS DISTINCT FROM true THEN RAISE EXCEPTION 'non-manual order should still be closed'; END IF;
  SELECT inventory INTO stock FROM public.shop_listings WHERE id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  IF stock <> 8 THEN RAISE EXCEPTION 'non-manual listing stock must not be changed, got %', stock; END IF;
END
$$;

SELECT 'Stripe manual inventory release SQL integration tests passed' AS result;
