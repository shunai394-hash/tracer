#!/usr/bin/env bash
set -euo pipefail

reserve_same_po() {
  psql -v ON_ERROR_STOP=1 -At -c "select reservation_status || ':' || remaining_inventory::text from public.reserve_internal_supply_for_order('30000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000002',4)"
}

reserve_same_po > /tmp/tracer-reserve-same-a.txt &
pid_a=$!
reserve_same_po > /tmp/tracer-reserve-same-b.txt &
pid_b=$!
wait "$pid_a"
wait "$pid_b"

grep -q '^reserved:6$' /tmp/tracer-reserve-same-a.txt
grep -q '^reserved:6$' /tmp/tracer-reserve-same-b.txt

psql -v ON_ERROR_STOP=1 -c "DO \$\$ BEGIN
  IF (SELECT inventory FROM public.internal_supply_variants WHERE id='20000000-0000-4000-8000-000000000002') <> 6 THEN
    RAISE EXCEPTION 'same-PO concurrent reservation decremented stock more than once';
  END IF;
  IF (SELECT count(*) FROM public.internal_supply_inventory_reservations WHERE purchase_order_id='30000000-0000-4000-8000-000000000003' AND status='reserved') <> 1 THEN
    RAISE EXCEPTION 'same-PO concurrent reservation did not create exactly one ledger row';
  END IF;
END \$\$;"

reserve_d() {
  psql -v ON_ERROR_STOP=1 -At -c "select reservation_status from public.reserve_internal_supply_for_order('30000000-0000-4000-8000-000000000004','20000000-0000-4000-8000-000000000002',4)"
}
reserve_e() {
  psql -v ON_ERROR_STOP=1 -At -c "select reservation_status from public.reserve_internal_supply_for_order('30000000-0000-4000-8000-000000000005','20000000-0000-4000-8000-000000000002',4)"
}

reserve_d > /tmp/tracer-reserve-d.txt &
pid_d=$!
reserve_e > /tmp/tracer-reserve-e.txt &
pid_e=$!
wait "$pid_d"
wait "$pid_e"

psql -v ON_ERROR_STOP=1 -c "DO \$\$ DECLARE v_reserved integer; v_inventory integer; BEGIN
  SELECT count(*) INTO v_reserved FROM public.internal_supply_inventory_reservations
   WHERE purchase_order_id IN ('30000000-0000-4000-8000-000000000004','30000000-0000-4000-8000-000000000005') AND status='reserved';
  SELECT inventory INTO v_inventory FROM public.internal_supply_variants WHERE id='20000000-0000-4000-8000-000000000002';
  IF v_reserved <> 1 OR v_inventory <> 2 THEN
    RAISE EXCEPTION 'competing reservations overbooked stock: reservations %, inventory %', v_reserved, v_inventory;
  END IF;
END \$\$;"

echo "PASS: concurrent retries reserve a PO once and competing POs cannot overbook inventory."
