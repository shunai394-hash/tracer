\set ON_ERROR_STOP on

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
END $$;

CREATE TABLE public.internal_supply_variants (
  id uuid PRIMARY KEY,
  inventory integer,
  active boolean NOT NULL,
  orderable boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.internal_fulfillment_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id uuid NOT NULL UNIQUE,
  supply_product_id uuid NOT NULL,
  supply_variant_id uuid NOT NULL REFERENCES public.internal_supply_variants(id),
  quantity integer NOT NULL CHECK (quantity > 0),
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('queued','reserved','processing','shipped','delivered','cancelled','failed')),
  order_number text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

\i supabase/migrations/20261012100000_idempotent_internal_supply_reservations.sql

INSERT INTO public.internal_supply_variants(id, inventory, active, orderable) VALUES
 ('20000000-0000-4000-8000-000000000001',10,true,true),
 ('20000000-0000-4000-8000-000000000002',4,true,true),
 ('20000000-0000-4000-8000-000000000003',1,true,true);

DO $$
DECLARE
  v_remaining integer;
  v_restored integer;
  v_count integer;
  v_state text;
  v_failed boolean;
BEGIN
  -- Reservation retries with the same idempotency key must not deduct twice.
  SELECT remaining_inventory INTO v_remaining FROM public.reserve_internal_supply_variant(
    'compensation-no-order','20000000-0000-4000-8000-000000000001',2);
  IF v_remaining <> 8 THEN RAISE EXCEPTION 'first reservation expected 8, got %', v_remaining; END IF;
  SELECT remaining_inventory INTO v_remaining FROM public.reserve_internal_supply_variant(
    'compensation-no-order','20000000-0000-4000-8000-000000000001',2);
  IF v_remaining <> 8 THEN RAISE EXCEPTION 'idempotent reservation deducted twice: %', v_remaining; END IF;
  v_failed := false;
  BEGIN
    PERFORM * FROM public.reserve_internal_supply_variant(
      'compensation-no-order','20000000-0000-4000-8000-000000000001',1);
  EXCEPTION WHEN OTHERS THEN
    v_failed := SQLERRM = 'reservation_idempotency_conflict';
    IF NOT v_failed THEN RAISE; END IF;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'reservation key accepted conflicting quantity'; END IF;

  -- Failed order creation: one compensation restores stock, repeated compensation does not.
  SELECT restored_inventory INTO v_restored FROM public.release_internal_supply_variant(
    'compensation-no-order','20000000-0000-4000-8000-000000000001',2,'test_insert_failure');
  IF v_restored <> 10 THEN RAISE EXCEPTION 'first compensation expected 10, got %', v_restored; END IF;
  SELECT count(*) INTO v_count FROM public.release_internal_supply_variant(
    'compensation-no-order','20000000-0000-4000-8000-000000000001',2,'duplicate_compensation');
  IF v_count <> 0 THEN RAISE EXCEPTION 'duplicate compensation returned stock again'; END IF;
  IF (SELECT inventory FROM public.internal_supply_variants WHERE id='20000000-0000-4000-8000-000000000001') <> 10 THEN
    RAISE EXCEPTION 'stock changed after duplicate compensation';
  END IF;

  -- Active order cannot return inventory; failed status can return exactly once.
  SELECT remaining_inventory INTO v_remaining FROM public.reserve_internal_supply_variant(
    'dropship:po-failed','20000000-0000-4000-8000-000000000001',3);
  INSERT INTO public.internal_fulfillment_orders(purchase_order_id,supply_product_id,supply_variant_id,quantity,status,order_number)
  VALUES ('30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',3,'reserved','dropship:po-failed');
  IF public.commit_internal_supply_variant_reservation('dropship:po-failed','20000000-0000-4000-8000-000000000001',3) IS NOT TRUE THEN
    RAISE EXCEPTION 'commit reservation failed';
  END IF;
  SELECT count(*) INTO v_count FROM public.release_internal_supply_variant(
    'dropship:po-failed','20000000-0000-4000-8000-000000000001',3,'must_not_release_active_order');
  IF v_count <> 0 THEN RAISE EXCEPTION 'active order released inventory'; END IF;
  UPDATE public.internal_fulfillment_orders SET status='failed' WHERE order_number='dropship:po-failed';
  SELECT restored_inventory INTO v_restored FROM public.release_internal_supply_variant(
    'dropship:po-failed','20000000-0000-4000-8000-000000000001',3,'supplier_order_failed');
  IF v_restored <> 10 THEN RAISE EXCEPTION 'failed order should restore inventory to 10, got %', v_restored; END IF;
  SELECT count(*) INTO v_count FROM public.release_internal_supply_variant(
    'dropship:po-failed','20000000-0000-4000-8000-000000000001',3,'duplicate_failed_return');
  IF v_count <> 0 THEN RAISE EXCEPTION 'failed order inventory returned twice'; END IF;

  -- Cancelled order follows the same one-time return rule.
  SELECT remaining_inventory INTO v_remaining FROM public.reserve_internal_supply_variant(
    'dropship:po-cancelled','20000000-0000-4000-8000-000000000002',1);
  INSERT INTO public.internal_fulfillment_orders(purchase_order_id,supply_product_id,supply_variant_id,quantity,status,order_number)
  VALUES ('30000000-0000-4000-8000-000000000002','40000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000002',1,'reserved','dropship:po-cancelled');
  PERFORM public.commit_internal_supply_variant_reservation('dropship:po-cancelled','20000000-0000-4000-8000-000000000002',1);
  UPDATE public.internal_fulfillment_orders SET status='cancelled' WHERE order_number='dropship:po-cancelled';
  SELECT restored_inventory INTO v_restored FROM public.release_internal_supply_variant(
    'dropship:po-cancelled','20000000-0000-4000-8000-000000000002',1,'supplier_order_cancelled');
  IF v_restored <> 4 THEN RAISE EXCEPTION 'cancelled order should restore inventory to 4, got %', v_restored; END IF;

  -- No reservation means no fulfillment order may be inserted.
  v_failed := false;
  BEGIN
    INSERT INTO public.internal_fulfillment_orders(purchase_order_id,supply_product_id,supply_variant_id,quantity,status,order_number)
    VALUES ('30000000-0000-4000-8000-000000000003','40000000-0000-4000-8000-000000000003',
      '20000000-0000-4000-8000-000000000003',1,'reserved','unreserved-order');
  EXCEPTION WHEN OTHERS THEN
    v_failed := SQLERRM = 'internal_fulfillment_requires_active_inventory_reservation';
    IF NOT v_failed THEN RAISE; END IF;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'unreserved order insert was accepted'; END IF;

  -- Insufficient inventory must not leave a phantom reservation row.
  SELECT count(*) INTO v_count FROM public.reserve_internal_supply_variant(
    'insufficient-stock','20000000-0000-4000-8000-000000000002',99);
  IF v_count <> 0 THEN RAISE EXCEPTION 'insufficient inventory was reserved'; END IF;
  IF EXISTS (SELECT 1 FROM public.internal_supply_inventory_reservations WHERE reservation_key='insufficient-stock') THEN
    RAISE EXCEPTION 'insufficient inventory left a phantom reservation';
  END IF;
END $$;

SELECT 'PASS: reservation idempotency, failed/cancelled one-time returns, active-order protection, and unreserved insert rejection' AS result;
