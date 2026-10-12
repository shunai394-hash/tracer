#!/usr/bin/env bash
set -euo pipefail

variant_id="20000000-0000-4000-8000-000000000003"

psql -X -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE OR REPLACE FUNCTION public.test_delay_inventory_reservation_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_sleep(0.4);
  RETURN NEW;
END;
$$;
CREATE TRIGGER test_delay_inventory_reservation_insert
BEFORE INSERT ON public.internal_supply_inventory_reservations
FOR EACH ROW EXECUTE FUNCTION public.test_delay_inventory_reservation_insert();
SQL

psql -X -v ON_ERROR_STOP=1 -qAt -c "select variant_id, remaining_inventory from public.reserve_internal_supply_variant('concurrent-reservation-a', '$variant_id', 1)" > /tmp/tracer-reservation-a.txt &
pid_a=$!
psql -X -v ON_ERROR_STOP=1 -qAt -c "select variant_id, remaining_inventory from public.reserve_internal_supply_variant('concurrent-reservation-b', '$variant_id', 1)" > /tmp/tracer-reservation-b.txt &
pid_b=$!
wait "$pid_a"
wait "$pid_b"

successes="$(awk 'NF {n++} END {print n+0}' /tmp/tracer-reservation-a.txt /tmp/tracer-reservation-b.txt)"
if [[ "$successes" != "1" ]]; then
  echo "Expected exactly one concurrent reservation to succeed; got $successes"
  cat /tmp/tracer-reservation-a.txt /tmp/tracer-reservation-b.txt
  exit 1
fi

remaining="$(psql -X -v ON_ERROR_STOP=1 -qAt -c "select inventory from public.internal_supply_variants where id='$variant_id'")"
reservation_count="$(psql -X -v ON_ERROR_STOP=1 -qAt -c "select count(*) from public.internal_supply_inventory_reservations where reservation_key in ('concurrent-reservation-a','concurrent-reservation-b')")"
if [[ "$remaining" != "0" || "$reservation_count" != "1" ]]; then
  echo "Unexpected concurrent state: remaining=$remaining reservations=$reservation_count"
  exit 1
fi

psql -X -v ON_ERROR_STOP=1 -q <<'SQL'
DROP TRIGGER IF EXISTS test_delay_inventory_reservation_insert ON public.internal_supply_inventory_reservations;
DROP FUNCTION IF EXISTS public.test_delay_inventory_reservation_insert();
SQL

echo "PASS: concurrent reservation deducted one unit exactly once; one reservation won."
